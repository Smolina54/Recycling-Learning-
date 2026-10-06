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

// --- Recycling-level aggregate (Workstream 7 Point 5 sub-idea, 2026-09-24; formula revised
// 2026-10-05/06 to NABERS' kg-recovered/kg-generated definition, building=external/tenant=internal
// split, 365-day cutoff) ---
// Exercises _writeRecyclingLevelAggregates directly (exported from functions/index.js purely for
// this test) against bintrackerRows/bintrackerTenantMatches seeded straight into the Firestore
// emulator via the admin SDK — the real refreshBintrackerData handler also calls the real
// Bintracker network (fetchBintrackerCollections) before ever reaching this step, which this
// suite deliberately never does (see the file header) — same "seed the data a real refresh would
// have produced, skip the network" approach as admin-buildings-bintracker.test.js's own review-UI
// coverage. Requires firebase-admin, which only functions/node_modules has installed — got via
// functions/index.js's own `_admin` export rather than requiring firebase-admin directly here.
//
// `wasteOutcome` is stored (matches the real doc shape) but deliberately uncorrelated with the
// expected result — it's no longer read by the formula, only `ourStream` (recovered = mr/pc/og
// weight) and `weight` (generated = ALL streams' weight) matter now, which is why every row below
// uses a DISTINCT, deliberately non-uniform weight — proves the math is really weight-based, not
// accidentally passing because every row happened to weigh the same.
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

  // Building-level population = EXTERNAL (externalOnly:true) rows only, regardless of tenant.
  // mr 40 + pc 30 + og 20 + gw 5 + ew 5 = generated 100; recovered (mr+pc+og) = 90 -> 90%.
  // gw/ew legitimately count toward "generated" now (real NABERS denominator = ALL waste), but
  // never toward "recovered" — this is the actual behavior change from the pre-2026-10-05 formula.
  const buildingExternalRows = [
    { ourStream: 'mr', weight: 40, bintrackerTenantRaw: 'Confirmed Raw Co' },
    { ourStream: 'pc', weight: 30, bintrackerTenantRaw: 'Confirmed Raw Co' },
    { ourStream: 'og', weight: 20, bintrackerTenantRaw: 'Other Co' },
    { ourStream: 'gw', weight: 5, bintrackerTenantRaw: 'Confirmed Raw Co' },
    { ourStream: 'ew', weight: 5, bintrackerTenantRaw: 'Other Co' },
  ];
  // An INTERNAL row, huge distinctive weight (999) — must NEVER count toward the building total
  // (building reads external rows only); if wrongly included, generated would balloon to 1099 and
  // the building percentage below would be very different, making this a real discriminating check.
  // Tagged with a raw string that has NO confirmed match doc at all, so it also can't accidentally
  // feed any tenant-level number either — isolates this to testing the building-level exclusion only.
  const buildingExcludedInternalRow = { ourStream: 'mr', weight: 999, externalOnly: false, bintrackerTenantRaw: 'Unrelated Internal Co' };

  // Confirmed Co's own tenant-level population = INTERNAL rows for 'Confirmed Raw Co' exactly.
  // mr 40 + pc 20 + og 10 + gw 20 + ew 10 = generated 100; recovered = 70 -> 70%.
  const confirmedTenantInternalRows = [
    { ourStream: 'mr', weight: 40, externalOnly: false, bintrackerTenantRaw: 'Confirmed Raw Co' },
    { ourStream: 'pc', weight: 20, externalOnly: false, bintrackerTenantRaw: 'Confirmed Raw Co' },
    { ourStream: 'og', weight: 10, externalOnly: false, bintrackerTenantRaw: 'Confirmed Raw Co' },
    { ourStream: 'gw', weight: 20, externalOnly: false, bintrackerTenantRaw: 'Confirmed Raw Co' },
    { ourStream: 'ew', weight: 10, externalOnly: false, bintrackerTenantRaw: 'Confirmed Raw Co' },
  ];
  // A different-case variant of the confirmed raw string, INTERNAL, huge distinctive weight (500) —
  // bintrackerTenantRaw matching is documented as case-sensitive exact match; this row must NOT
  // count toward Confirmed Co's own tenant-level number (would balloon generated to 600 if wrongly
  // included, a real discriminating check, not just "happens to still pass").
  const caseVariantInternalRow = { ourStream: 'mr', weight: 500, externalOnly: false, bintrackerTenantRaw: 'confirmed raw co' };

  // "Other Co" — 5 internal rows, would be 30/50=60% IF its match were confirmed; its match doc
  // below is deliberately left as status:'pending' to prove an unconfirmed match never feeds the
  // tenant-level field, same "admin reviews, never fully automatic" principle established for the
  // rest of this workstream.
  const otherTenantInternalRows = [
    { ourStream: 'mr', weight: 10, externalOnly: false, bintrackerTenantRaw: 'Other Co' },
    { ourStream: 'pc', weight: 10, externalOnly: false, bintrackerTenantRaw: 'Other Co' },
    { ourStream: 'og', weight: 10, externalOnly: false, bintrackerTenantRaw: 'Other Co' },
    { ourStream: 'gw', weight: 10, externalOnly: false, bintrackerTenantRaw: 'Other Co' },
    { ourStream: 'ew', weight: 10, externalOnly: false, bintrackerTenantRaw: 'Other Co' },
  ];

  const allRows = [
    ...buildingExternalRows.map((r) => ({ externalOnly: true, ...r })),
    buildingExcludedInternalRow,
    ...confirmedTenantInternalRows,
    caseVariantInternalRow,
    ...otherTenantInternalRows,
  ];
  for (const r of allRows) {
    await db.collection('bintrackerRows').add({
      buildingId, bintrackerLocationRaw: 'Level 1', wasteTypeRaw: 'x', contaminated: false,
      wasteOutcome: 'Recycled', collectDate: '2026-01-15', fetchedAt: new Date(), ...r,
    });
  }

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
  check('building-wide recyclingLevelPct computed from EXTERNAL rows only, kg recovered/generated (90/100 -> 90%)',
    buildingSnap.data().recyclingLevelPct === 90, JSON.stringify(buildingSnap.data()));

  const confirmedTenantSnap = await db.doc(`buildings/${buildingId}/tenants/${tenantConfirmedId}`).get();
  check('confirmed tenant recyclingLevelPct computed from only its own exact-case INTERNAL rows (70/100 -> 70%)',
    confirmedTenantSnap.data().recyclingLevelPct === 70, JSON.stringify(confirmedTenantSnap.data()));

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

// --- 365-day cutoff (added 2026-10-06, per NABERS' own "based on 12 months of waste data"
// definition) --- Seeds exactly MIN_ROWS_FOR_RECYCLING_LEVEL (5) qualifying rows, all dated well
// over a year ago (computed relative to the real clock, not hardcoded, so this test never goes
// stale) — without the cutoff these 5 rows would sit exactly at the floor and produce a real
// percentage; with it, the Firestore query itself should never even fetch them, leaving
// recyclingLevelPct unset (graceful absence), not a stale/wrong number.
async function testTwelveMonthCutoff() {
  const { _writeRecyclingLevelAggregates, _getAdminFirestoreForTests } = require('../functions/index.js');
  const db = _getAdminFirestoreForTests();
  const suffix = Date.now() + '-cutoff';
  const buildingId = 'cutoff-tower-' + suffix;
  await db.doc(`buildings/${buildingId}`).set({ name: 'Cutoff Tower', bintrackerBuildingName: 'Cutoff Demo Building' });

  const over400DaysAgo = new Date();
  over400DaysAgo.setDate(over400DaysAgo.getDate() - 400);
  const oldDateStr = over400DaysAgo.toISOString().slice(0, 10);

  const oldRows = [
    ['mr', 'Recycled'], ['mr', 'Recycled'], ['pc', 'Recycled'], ['og', 'Recycled'], ['og', 'Non-Recycled'],
  ];
  for (const [ourStream, wasteOutcome] of oldRows) {
    await db.collection('bintrackerRows').add({
      buildingId, bintrackerTenantRaw: 'Old Data Co', bintrackerLocationRaw: 'Level 1', wasteTypeRaw: 'x',
      ourStream, externalOnly: true, contaminated: wasteOutcome !== 'Recycled', wasteOutcome,
      collectDate: oldDateStr, weight: 10, fetchedAt: new Date(),
    });
  }

  await _writeRecyclingLevelAggregates(db, buildingId);
  const buildingSnap = await db.doc(`buildings/${buildingId}`).get();
  check('rows older than 365 days are excluded by the cutoff - recyclingLevelPct stays unset even though 5 rows exist (would otherwise sit exactly at the floor)',
    buildingSnap.exists && !('recyclingLevelPct' in buildingSnap.data()), JSON.stringify(buildingSnap.data()));
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
  await testTwelveMonthCutoff();

  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} — ${r.label}${r.ok ? '' : ' ' + r.extra}`);
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(err => { console.error('Test run crashed:', err); process.exit(1); });
