// Verifies refreshBintrackerData's auth + validation + precondition logic against the local
// Functions emulator - mirrors tests/functions-sendinductionemail.test.js's approach: every case
// here is rejected inside assertIsAdmin()/payload validation/the bintrackerBuildingName check,
// all of which throw before the function ever calls fetchBintrackerCollections() to reach the
// real network. No real Bintracker credentials or network access needed - the two secrets are
// given throwaway values in functions/.secret.local purely so the emulator can load the function
// at all. The real fetch/mapping/storage behavior against the live dsdev sandbox was verified
// manually and directly (2026-09-24), not by this automated suite, same reasoning as
// sendInductionEmail's own real-send path being left untested here by design.
//
// testRecyclingLevelAggregation() (Workstream 7 Point 5 sub-idea, 2026-09-24) covers the OTHER
// half of refreshBintrackerData - the recyclingLevelPct aggregate write step - by calling
// functions/index.js's exported _writeRecyclingLevelAggregates directly against
// bintrackerRows/bintrackerTenantMatches seeded straight into the emulator (via the admin SDK,
// obtained through the also-exported _getAdminFirestoreForTests() - bypasses rules entirely),
// same "seed what a real refresh would have produced, skip the real network" approach as the
// rest of this file and as admin-buildings-bintracker.test.js's own review-UI suite.
//
// Run: npm run test:functions-bintracker
// On this machine, port 5001 may already be taken by an unrelated project's dev server - run
// instead with:
//   firebase --config firebase.local-test.json emulators:exec --only firestore,auth,functions "node tests/functions-refreshbintrackerdata.test.js"
const fs = require('fs');
const path = require('path');
const { initializeApp } = require('firebase/app');
const { getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signInWithEmailAndPassword } = require('firebase/auth');
const { getFirestore, connectFirestoreEmulator, doc, setDoc } = require('firebase/firestore');
const { getFunctions, connectFunctionsEmulator, httpsCallable } = require('firebase/functions');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');

const RULES_PATH = path.join(__dirname, '..', 'firestore.rules');
const OWNER_EMAIL = 'esgtradeflex@gmail.com';
const OTHER_ADMIN_EMAIL = 'other-admin@example.com';
const RANDOM_EMAIL = 'random-user@example.com';
const PASSWORD = 'test-password-123';
const FUNCTIONS_PORT = Number(process.env.FUNCTIONS_EMULATOR_PORT || 5001);

const firebaseConfig = {
  apiKey: 'AIzaSyAoWSx9FYa6UJa-6EZezgBYiDMuVVs9BBo',
  projectId: 'esg-1-98f35',
};

const results = [];
function check(label, cond, extra) { results.push({ label, ok: Boolean(cond), extra: extra || '' }); }

async function makeClient(name, email, password) {
  const app = initializeApp(firebaseConfig, name);
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  const functions = getFunctions(app, 'australia-southeast2');
  connectFunctionsEmulator(functions, '127.0.0.1', FUNCTIONS_PORT);
  if (email) {
    try {
      await createUserWithEmailAndPassword(auth, email, password);
    } catch (err) {
      if (err.code !== 'auth/email-already-in-use') throw err;
      await signInWithEmailAndPassword(auth, email, password);
    }
  }
  return { auth, db, functions };
}

async function callRefresh(functions, payload) {
  const fn = httpsCallable(functions, 'refreshBintrackerData');
  try {
    const result = await fn(payload);
    return { ok: true, data: result.data };
  } catch (err) {
    return { ok: false, code: err.code, message: err.message };
  }
}

async function withRulesDisabled(fn) {
  const testEnv = await initializeTestEnvironment({
    projectId: 'esg-1-98f35',
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  await testEnv.withSecurityRulesDisabled(fn);
  await testEnv.cleanup();
}

const VALID_PAYLOAD_SHAPE = { fromDate: '2026-01-01', toDate: '2026-01-31' };

// --- Recycling-level aggregate (Workstream 7 Point 5 sub-idea, 2026-09-24) ---
// Exercises _writeRecyclingLevelAggregates directly (exported from functions/index.js purely for
// this test) against bintrackerRows/bintrackerTenantMatches seeded straight into the Firestore
// emulator via the admin SDK — the real refreshBintrackerData handler also calls the real
// Bintracker network (fetchBintrackerCollections) before ever reaching this step, which this
// suite deliberately never does (see the file header) — same "seed the data a real refresh would
// have produced, skip the network" approach as admin-buildings-bintracker.test.js's own review-UI
// coverage. Requires firebase-admin, which only functions/node_modules has installed — got via
// functions/index.js's own `_admin` export rather than requiring firebase-admin directly here.
async function testRecyclingLevelAggregation() {
  const { _writeRecyclingLevelAggregates, _getAdminFirestoreForTests } = require('../functions/index.js');
  const db = _getAdminFirestoreForTests();
  const suffix = Date.now() + '-agg';
  const buildingId = 'agg-tower-' + suffix;
  const tenantConfirmedId = 'agg-tenant-confirmed-' + suffix;
  const tenantUnconfirmedId = 'agg-tenant-unconfirmed-' + suffix;
  const tenantGhostId = 'agg-tenant-ghost-' + suffix; // confirmed match, tenant doc never created

  await db.doc(`buildings/${buildingId}`).set({ name: 'Aggregate Tower', bintrackerBuildingName: 'Agg Demo Building' });
  await db.doc(`buildings/${buildingId}/tenants/${tenantConfirmedId}`).set({ name: 'Confirmed Co', levels: ['L1'] });
  await db.doc(`buildings/${buildingId}/tenants/${tenantUnconfirmedId}`).set({ name: 'Unconfirmed Co', levels: ['L1'] });

  // "Confirmed Raw Co" — 5 qualifying rows (exactly at the floor), 4 Recycled -> 80%.
  const confirmedRows = [
    ['mr', 'Recycled'], ['mr', 'Recycled'], ['pc', 'Recycled'], ['og', 'Recycled'], ['og', 'Non-Recycled'],
  ];
  // "Other Co" — 5 qualifying rows, 3 Recycled -> would be 60% IF its match were confirmed;
  // its match doc below is deliberately left as status:'pending' to prove an unconfirmed match
  // never feeds the tenant-level field, same "admin reviews, never fully automatic" principle
  // established for the rest of this workstream.
  const otherRows = [
    ['mr', 'Recycled'], ['mr', 'Recycled'], ['pc', 'Recycled'], ['pc', 'Non-Recycled'], ['og', 'Non-Recycled'],
  ];
  // One row tagged with a different-case variant of the confirmed raw string — bintrackerTenantRaw
  // matching is documented as case-sensitive exact match; this row must count toward the BUILDING
  // total (still externalOnly + a recyclable stream) but must NOT count toward Confirmed Co's own
  // tenant-level number.
  const caseVariantRow = { ourStream: 'mr', externalOnly: true, wasteOutcome: 'Recycled', bintrackerTenantRaw: 'confirmed raw co' };
  // Noise that must never count toward either number: General Waste/E-Waste (wrong streams) and
  // an internalOnly (externalOnly:false) recyclable-stream row.
  const excludedRows = [
    { ourStream: 'gw', externalOnly: true, wasteOutcome: 'Recycled', bintrackerTenantRaw: 'Confirmed Raw Co' },
    { ourStream: 'ew', externalOnly: true, wasteOutcome: 'Recycled', bintrackerTenantRaw: 'Confirmed Raw Co' },
    { ourStream: 'mr', externalOnly: false, wasteOutcome: 'Recycled', bintrackerTenantRaw: 'Confirmed Raw Co' },
  ];

  const allRows = [
    ...confirmedRows.map(([ourStream, wasteOutcome]) => ({ ourStream, externalOnly: true, wasteOutcome, bintrackerTenantRaw: 'Confirmed Raw Co' })),
    ...otherRows.map(([ourStream, wasteOutcome]) => ({ ourStream, externalOnly: true, wasteOutcome, bintrackerTenantRaw: 'Other Co' })),
    caseVariantRow,
    ...excludedRows,
  ];
  for (const r of allRows) {
    await db.collection('bintrackerRows').add({
      buildingId, bintrackerLocationRaw: 'Level 1', wasteTypeRaw: 'x', contaminated: false,
      collectDate: '2026-01-15', weight: 10, fetchedAt: new Date(), ...r,
    });
  }
  // Building total: Confirmed Raw Co (5 rows, 4 recycled) + Other Co (5 rows, 3 recycled) +
  // the lowercase case-variant row (1 row, recycled) = 11 qualifying, 8 recycled -> 8/11 = 72.7% -> 73.
  // Confirmed Co's own number: only the 5 exact-case "Confirmed Raw Co" rows -> 4/5 = 80%.

  await db.doc('bintrackerTenantMatches/' + `${buildingId}__${tenantConfirmedId}`).set({
    buildingId, tenantId: tenantConfirmedId, tenantName: 'Confirmed Co',
    bintrackerTenantRaw: 'Confirmed Raw Co', bintrackerLocationRaw: 'Level 1',
    confirmedBy: 'admin@example.com', status: 'confirmed',
  });
  await db.doc('bintrackerTenantMatches/' + `${buildingId}__${tenantUnconfirmedId}`).set({
    buildingId, tenantId: tenantUnconfirmedId, tenantName: 'Unconfirmed Co',
    bintrackerTenantRaw: 'Other Co', bintrackerLocationRaw: 'Level 1',
    confirmedBy: '', status: 'pending',
  });
  await db.doc('bintrackerTenantMatches/' + `${buildingId}__${tenantGhostId}`).set({
    buildingId, tenantId: tenantGhostId, tenantName: 'Ghost Co',
    bintrackerTenantRaw: 'Ghost Raw Co', bintrackerLocationRaw: 'Level 1',
    confirmedBy: 'admin@example.com', status: 'confirmed',
  });

  await _writeRecyclingLevelAggregates(db, buildingId);

  const buildingSnap = await db.doc(`buildings/${buildingId}`).get();
  check('building-wide recyclingLevelPct computed correctly across all qualifying rows (8/11 -> 73%)',
    buildingSnap.data().recyclingLevelPct === 73, JSON.stringify(buildingSnap.data()));

  const confirmedTenantSnap = await db.doc(`buildings/${buildingId}/tenants/${tenantConfirmedId}`).get();
  check('confirmed tenant recyclingLevelPct computed from only its own exact-case raw rows (4/5 -> 80%)',
    confirmedTenantSnap.data().recyclingLevelPct === 80, JSON.stringify(confirmedTenantSnap.data()));

  const unconfirmedTenantSnap = await db.doc(`buildings/${buildingId}/tenants/${tenantUnconfirmedId}`).get();
  check('a tenant whose match is only "pending" (not confirmed) gets no recyclingLevelPct field at all',
    unconfirmedTenantSnap.data().recyclingLevelPct === undefined, JSON.stringify(unconfirmedTenantSnap.data()));

  const ghostTenantSnap = await db.doc(`buildings/${buildingId}/tenants/${tenantGhostId}`).get();
  check('a confirmed match pointing at a tenant doc that was never created is skipped gracefully, not crashing and not creating a phantom doc',
    !ghostTenantSnap.exists, JSON.stringify(ghostTenantSnap.data()));

  // --- Below-the-floor + stale-field deletion: delete every bintrackerRows doc for this building
  // (simulating a re-refresh over a narrower/emptier range) and re-run the aggregate — both the
  // building's and the tenant's previously-written numbers must be REMOVED (FieldValue.delete()),
  // not left stale and not zeroed out. ---
  const rowsSnap = await db.collection('bintrackerRows').where('buildingId', '==', buildingId).get();
  const batch = db.batch();
  rowsSnap.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();

  await _writeRecyclingLevelAggregates(db, buildingId);

  const buildingSnapAfter = await db.doc(`buildings/${buildingId}`).get();
  check('after the qualifying rows disappear, the building doc\'s stale recyclingLevelPct is removed entirely (not left, not zeroed)',
    buildingSnapAfter.exists && !('recyclingLevelPct' in buildingSnapAfter.data()), JSON.stringify(buildingSnapAfter.data()));

  const confirmedTenantSnapAfter = await db.doc(`buildings/${buildingId}/tenants/${tenantConfirmedId}`).get();
  check('...and the confirmed tenant\'s stale recyclingLevelPct is removed the same way',
    confirmedTenantSnapAfter.exists && !('recyclingLevelPct' in confirmedTenantSnapAfter.data()), JSON.stringify(confirmedTenantSnapAfter.data()));
}

async function main() {
  const MAPPED_BUILDING_ID = 'mapped-tower-' + Date.now();
  const UNMAPPED_BUILDING_ID = 'unmapped-tower-' + Date.now();
  await withRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'buildings', MAPPED_BUILDING_ID), { name: 'Mapped Tower', bintrackerBuildingName: 'Demo Building' });
    await setDoc(doc(db, 'buildings', UNMAPPED_BUILDING_ID), { name: 'Unmapped Tower' });
  });

  const anon = await makeClient('anon', null, null);
  const anonResult = await callRefresh(anon.functions, { buildingId: MAPPED_BUILDING_ID, ...VALID_PAYLOAD_SHAPE });
  check('unauthenticated call is rejected', !anonResult.ok && anonResult.code === 'functions/unauthenticated', JSON.stringify(anonResult));

  const random = await makeClient('random', RANDOM_EMAIL, PASSWORD);
  const randomResult = await callRefresh(random.functions, { buildingId: MAPPED_BUILDING_ID, ...VALID_PAYLOAD_SHAPE });
  check('non-admin signed-in call is rejected', !randomResult.ok && randomResult.code === 'functions/permission-denied', JSON.stringify(randomResult));

  const owner = await makeClient('owner', OWNER_EMAIL, PASSWORD);
  await setDoc(doc(owner.db, 'admins', OTHER_ADMIN_EMAIL), { addedBy: OWNER_EMAIL });
  const otherAdmin = await makeClient('otherAdmin', OTHER_ADMIN_EMAIL, PASSWORD);

  const missingIdResult = await callRefresh(otherAdmin.functions, { ...VALID_PAYLOAD_SHAPE });
  check('missing buildingId is rejected', !missingIdResult.ok && missingIdResult.code === 'functions/invalid-argument', JSON.stringify(missingIdResult));

  const badDateResult = await callRefresh(otherAdmin.functions, { buildingId: MAPPED_BUILDING_ID, fromDate: 'not-a-date', toDate: '2026-01-31' });
  check('malformed fromDate is rejected', !badDateResult.ok && badDateResult.code === 'functions/invalid-argument', JSON.stringify(badDateResult));

  const notFoundResult = await callRefresh(otherAdmin.functions, { buildingId: 'does-not-exist', ...VALID_PAYLOAD_SHAPE });
  check('a non-existent building is rejected', !notFoundResult.ok && notFoundResult.code === 'functions/not-found', JSON.stringify(notFoundResult));

  const unmappedResult = await callRefresh(otherAdmin.functions, { buildingId: UNMAPPED_BUILDING_ID, ...VALID_PAYLOAD_SHAPE });
  check('a building with no bintrackerBuildingName set is rejected', !unmappedResult.ok && unmappedResult.code === 'functions/failed-precondition', JSON.stringify(unmappedResult));

  await testRecyclingLevelAggregation();

  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} — ${r.label}${r.ok ? '' : ' ' + r.extra}`);
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(err => { console.error('Test run crashed:', err); process.exit(1); });
