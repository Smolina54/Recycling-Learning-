// Verifies the 3 Workstream 12 (Bintracker building/tenant catalog sync) Cloud Functions against
// the local Functions emulator: discoverBintrackerBuildings, syncBintrackerTenants, and
// deleteTenantPermanently. Mirrors tests/functions-deletebuildingpermanently.test.js's exact
// harness/style (same emulator bootstrap, check()/results array, real seeded Firestore data via
// the rules-unit-testing SDK).
//
// Same "no real Bintracker network call" convention as tests/functions-refreshbintrackerdata.test.js:
// discoverBintrackerBuildings/syncBintrackerTenants both call the real Bintracker network AFTER
// their own auth/validation/precondition checks, so every case below is rejected before either
// function ever reaches fetchBintrackerCollections() - no real credentials or network access
// needed, same throwaway functions/.secret.local values as the sibling suite. The actual fetch-
// then-diff data logic (which DOES need real-shaped API response rows) is covered separately and
// WITHOUT any network/emulator dependency at all, by calling the pure diffDiscoveredBuildingNames/
// diffBintrackerTenants exports from functions/bintracker.js directly with realistic seeded row
// shapes - the same "separate the fetch from the diff so the diff is unit-testable" split
// documented on those functions themselves.
//
// deleteTenantPermanently is exercised fully end-to-end here (real cascade delete against seeded
// submissions/attempts + the tenant doc, re-read afterward to confirm), including the deliberate
// design decision that it does NOT require the tenant to be archived first (unlike
// deleteBuildingPermanently's archive-first gate on a still-active building).
//
// Run: npm run test:functions-bintrackersync
// On this machine, port 5001 (firebase.json's default Functions emulator port) may already be
// taken by an unrelated project's dev server - run instead with:
//   firebase --config firebase.local-test.json emulators:exec --only firestore,auth,functions "node tests/functions-bintrackersync.test.js"
const fs = require('fs');
const path = require('path');
const { initializeApp } = require('firebase/app');
const { getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signInWithEmailAndPassword } = require('firebase/auth');
const { getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc } = require('firebase/firestore');
const { getFunctions, connectFunctionsEmulator, httpsCallable } = require('firebase/functions');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { diffDiscoveredBuildingNames, diffBintrackerTenants } = require('../functions/bintracker');

const RULES_PATH = path.join(__dirname, '..', 'firestore.rules');
const OWNER_EMAIL = 'esgtradeflex@gmail.com'; // must match functions/index.js's OWNER_EMAIL
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

function callFn(functions, name, payload) {
  return async () => {
    const fn = httpsCallable(functions, name);
    try {
      const result = await fn(payload);
      return { ok: true, data: result.data };
    } catch (err) {
      return { ok: false, code: err.code, message: err.message };
    }
  };
}

async function withRulesDisabled(fn) {
  const testEnv = await initializeTestEnvironment({
    projectId: 'esg-1-98f35',
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  await testEnv.withSecurityRulesDisabled(fn);
  await testEnv.cleanup();
}

async function collectionCountForTenant(collectionName, tenantId) {
  const testEnv = await initializeTestEnvironment({
    projectId: 'esg-1-98f35',
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  let count = 0;
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const { getDocs, collection, query, where } = require('firebase/firestore');
    const snap = await getDocs(query(collection(context.firestore(), collectionName), where('tenantId', '==', tenantId)));
    count = snap.size;
  });
  await testEnv.cleanup();
  return count;
}

// --- Pure diff logic, no network/emulator needed at all ---
function testDiffDiscoveredBuildingNames() {
  const rawRows = [
    { building: 'Tower One' },
    { building: 'Tower One' }, // duplicate - must be deduped
    { building: 'tower one  ' }, // same building, different case/whitespace - still deduped
    { building: 'Tower Two' },
    { building: 'Already Mapped Tower' },
    { building: '' }, // blank - ignored
    { building: null }, // missing field - ignored
  ];
  const existing = ['Already Mapped Tower', '  already  mapped tower  ']; // duplicate-ish existing entries, harmless
  const discovered = diffDiscoveredBuildingNames(rawRows, existing);
  check('discoverBintrackerBuildings diff: dedupes case/whitespace variants of the same building',
    discovered.length === 2, JSON.stringify(discovered));
  check('...and includes both genuinely-new buildings',
    discovered.includes('Tower One') && discovered.includes('Tower Two'), JSON.stringify(discovered));
  check('...and excludes a building already mapped (even via a differently-cased/spaced saved name)',
    !discovered.some((n) => n.toLowerCase().includes('already mapped')), JSON.stringify(discovered));
}

function testDiffBintrackerTenants() {
  const existingTenants = [
    { id: 'acme-id', name: 'Acme Legal', levels: ['Level 5'] },
    { id: 'widget-id', name: 'Widgetco', levels: ['Level 3'] },
    { id: 'gone-id', name: 'Gone Co', levels: ['Level 8'] },
  ];
  const rawRows = [
    // Acme Legal: exact match, seen on Level 5 (already known) and Level 6 (new -> mismatch)
    { tenant: 'Acme Legal', primaryLocation: 'Level 5' },
    { tenant: 'Acme Legal', primaryLocation: 'Level 6' },
    // WIDGETCO PTY LTD: contains-match to "Widgetco", same level already known - no mismatch
    { tenant: 'WIDGETCO PTY LTD', primaryLocation: 'Level 3' },
    // Brand-new tenant/location pair with no match to any existing tenant
    { tenant: 'New Startup Pty Ltd', primaryLocation: 'Level 12' },
    // Blank/missing tenant field - ignored
    { tenant: '', primaryLocation: 'Level 1' },
  ];
  // "Gone Co" appears in NO row above - must surface as missing.

  const { newTenants, missingTenants, levelMismatches } = diffBintrackerTenants(rawRows, existingTenants);

  check('syncBintrackerTenants diff: finds exactly one genuinely new tenant/location pair',
    newTenants.length === 1 && newTenants[0].bintrackerTenantRaw === 'New Startup Pty Ltd'
      && newTenants[0].primaryLocations.includes('Level 12'),
    JSON.stringify(newTenants));

  check('...finds the one tenant never seen in the window as missing',
    missingTenants.length === 1 && missingTenants[0].tenantId === 'gone-id', JSON.stringify(missingTenants));

  check('...finds exactly one level mismatch (Acme Legal seen on a level not in its stored levels)',
    levelMismatches.length === 1 && levelMismatches[0].tenantId === 'acme-id'
      && levelMismatches[0].newLevels.includes('Level 6'),
    JSON.stringify(levelMismatches));

  check('...and does NOT flag Widgetco as a mismatch (its only seen level is already stored)',
    !levelMismatches.some((m) => m.tenantId === 'widget-id'), JSON.stringify(levelMismatches));

  check('...and does NOT flag Widgetco as new (matched via contains-confidence to "WIDGETCO PTY LTD")',
    !newTenants.some((n) => n.bintrackerTenantRaw === 'WIDGETCO PTY LTD'), JSON.stringify(newTenants));
}

async function main() {
  testDiffDiscoveredBuildingNames();
  testDiffBintrackerTenants();

  // --- Auth/permission rejection, all 3 functions ---
  const SEED_BUILDING_ID = 'sync-tower-' + Date.now();
  const SEED_TENANT_ID = 'sync-tenant-' + Date.now();
  await withRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'buildings', SEED_BUILDING_ID), { name: 'Sync Tower', bintrackerBuildingName: 'Sync Test Tower' });
    await setDoc(doc(db, 'buildings', SEED_BUILDING_ID, 'tenants', SEED_TENANT_ID), { name: 'Seed Tenant', levels: ['Level 1'], active: true });
  });
  const UNMAPPED_BUILDING_ID = 'unmapped-sync-tower-' + Date.now();
  await withRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'buildings', UNMAPPED_BUILDING_ID), { name: 'Unmapped Sync Tower' });
  });

  const anon = await makeClient('anon', null, null);
  const anonDiscover = await callFn(anon.functions, 'discoverBintrackerBuildings', {})();
  check('discoverBintrackerBuildings: unauthenticated call is rejected',
    !anonDiscover.ok && anonDiscover.code === 'functions/unauthenticated', JSON.stringify(anonDiscover));
  const anonSync = await callFn(anon.functions, 'syncBintrackerTenants', { buildingId: SEED_BUILDING_ID })();
  check('syncBintrackerTenants: unauthenticated call is rejected',
    !anonSync.ok && anonSync.code === 'functions/unauthenticated', JSON.stringify(anonSync));
  const anonDelete = await callFn(anon.functions, 'deleteTenantPermanently', { buildingId: SEED_BUILDING_ID, tenantId: SEED_TENANT_ID, confirmName: 'Seed Tenant' })();
  check('deleteTenantPermanently: unauthenticated call is rejected',
    !anonDelete.ok && anonDelete.code === 'functions/unauthenticated', JSON.stringify(anonDelete));

  const random = await makeClient('random', RANDOM_EMAIL, PASSWORD);
  const randomDiscover = await callFn(random.functions, 'discoverBintrackerBuildings', {})();
  check('discoverBintrackerBuildings: non-admin signed-in call is rejected',
    !randomDiscover.ok && randomDiscover.code === 'functions/permission-denied', JSON.stringify(randomDiscover));
  const randomSync = await callFn(random.functions, 'syncBintrackerTenants', { buildingId: SEED_BUILDING_ID })();
  check('syncBintrackerTenants: non-admin signed-in call is rejected',
    !randomSync.ok && randomSync.code === 'functions/permission-denied', JSON.stringify(randomSync));
  const randomDelete = await callFn(random.functions, 'deleteTenantPermanently', { buildingId: SEED_BUILDING_ID, tenantId: SEED_TENANT_ID, confirmName: 'Seed Tenant' })();
  check('deleteTenantPermanently: non-admin signed-in call is rejected',
    !randomDelete.ok && randomDelete.code === 'functions/permission-denied', JSON.stringify(randomDelete));

  const owner = await makeClient('owner', OWNER_EMAIL, PASSWORD);
  await setDoc(doc(owner.db, 'admins', OTHER_ADMIN_EMAIL), { addedBy: OWNER_EMAIL });
  const otherAdmin = await makeClient('otherAdmin', OTHER_ADMIN_EMAIL, PASSWORD);

  // --- syncBintrackerTenants: failed-precondition when bintrackerBuildingName isn't set ---
  const unmappedSync = await callFn(otherAdmin.functions, 'syncBintrackerTenants', { buildingId: UNMAPPED_BUILDING_ID })();
  check('syncBintrackerTenants: rejects failed-precondition when bintrackerBuildingName is unset',
    !unmappedSync.ok && unmappedSync.code === 'functions/failed-precondition', JSON.stringify(unmappedSync));

  // --- syncBintrackerTenants: not-found / invalid-argument ---
  const missingIdSync = await callFn(otherAdmin.functions, 'syncBintrackerTenants', {})();
  check('syncBintrackerTenants: missing buildingId is rejected as invalid-argument',
    !missingIdSync.ok && missingIdSync.code === 'functions/invalid-argument', JSON.stringify(missingIdSync));
  const notFoundSync = await callFn(otherAdmin.functions, 'syncBintrackerTenants', { buildingId: 'does-not-exist' })();
  check('syncBintrackerTenants: a non-existent building is rejected as not-found',
    !notFoundSync.ok && notFoundSync.code === 'functions/not-found', JSON.stringify(notFoundSync));

  // --- deleteTenantPermanently: validation ---
  const missingTenantIdDelete = await callFn(otherAdmin.functions, 'deleteTenantPermanently', { buildingId: SEED_BUILDING_ID, confirmName: 'Seed Tenant' })();
  check('deleteTenantPermanently: missing tenantId is rejected as invalid-argument',
    !missingTenantIdDelete.ok && missingTenantIdDelete.code === 'functions/invalid-argument', JSON.stringify(missingTenantIdDelete));
  const notFoundDelete = await callFn(otherAdmin.functions, 'deleteTenantPermanently', { buildingId: SEED_BUILDING_ID, tenantId: 'does-not-exist', confirmName: 'x' })();
  check('deleteTenantPermanently: a non-existent tenant is rejected as not-found',
    !notFoundDelete.ok && notFoundDelete.code === 'functions/not-found', JSON.stringify(notFoundDelete));
  const wrongNameDelete = await callFn(otherAdmin.functions, 'deleteTenantPermanently', { buildingId: SEED_BUILDING_ID, tenantId: SEED_TENANT_ID, confirmName: 'Not The Real Name' })();
  check('deleteTenantPermanently: wrong confirmName is rejected as failed-precondition',
    !wrongNameDelete.ok && wrongNameDelete.code === 'functions/failed-precondition', JSON.stringify(wrongNameDelete));
  const survivingTenant = await getDoc(doc(otherAdmin.db, 'buildings', SEED_BUILDING_ID, 'tenants', SEED_TENANT_ID));
  check('...and the tenant survives a wrong-name-rejected call', survivingTenant.exists(), '');

  // --- deleteTenantPermanently: happy path, proving NO archive-first gate is required ---
  const STILL_ACTIVE_BUILDING_ID = 'active-sync-tower-' + Date.now();
  const STILL_ACTIVE_TENANT_ID = 'active-sync-tenant-' + Date.now();
  await withRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'buildings', STILL_ACTIVE_BUILDING_ID), { name: 'Active Sync Tower' });
    // active: true (or omitted, same as a freshly-added tenant) - deliberately NOT archived first.
    await setDoc(doc(db, 'buildings', STILL_ACTIVE_BUILDING_ID, 'tenants', STILL_ACTIVE_TENANT_ID), { name: 'Still Active Tenant', levels: ['Level 1'], active: true });
    for (let i = 0; i < 3; i++) {
      await setDoc(doc(db, 'submissions', `${STILL_ACTIVE_TENANT_ID}-sub-${i}`), {
        buildingId: STILL_ACTIVE_BUILDING_ID, tenantId: STILL_ACTIVE_TENANT_ID, programId: 'recycling-sorting', score: 90,
      });
    }
    for (let i = 0; i < 2; i++) {
      await setDoc(doc(db, 'attempts', `${STILL_ACTIVE_TENANT_ID}-att-${i}`), {
        buildingId: STILL_ACTIVE_BUILDING_ID, tenantId: STILL_ACTIVE_TENANT_ID, programId: 'recycling-sorting',
      });
    }
    // An unrelated tenant's data, to prove cross-tenant isolation of the cascade delete below.
    await setDoc(doc(db, 'submissions', 'other-tenant-sub-' + Date.now()), {
      buildingId: STILL_ACTIVE_BUILDING_ID, tenantId: 'some-other-tenant-id', programId: 'recycling-sorting', score: 50,
    });
  });

  const happyDelete = await callFn(otherAdmin.functions, 'deleteTenantPermanently', {
    buildingId: STILL_ACTIVE_BUILDING_ID, tenantId: STILL_ACTIVE_TENANT_ID, confirmName: 'Still Active Tenant',
  })();
  check('deleteTenantPermanently: a STILL-ACTIVE tenant (no archive-first gate) can be deleted directly',
    happyDelete.ok && happyDelete.data && happyDelete.data.ok === true, JSON.stringify(happyDelete));
  if (happyDelete.ok) {
    const c = happyDelete.data.deletedCounts;
    check('...and deletedCounts matches what was seeded (3 submissions, 2 attempts)',
      c.submissions === 3 && c.attempts === 2, JSON.stringify(c));
  }

  const tenantDocAfter = await getDoc(doc(otherAdmin.db, 'buildings', STILL_ACTIVE_BUILDING_ID, 'tenants', STILL_ACTIVE_TENANT_ID));
  check('...the tenant doc itself is really gone', !tenantDocAfter.exists());
  const subsAfter = await collectionCountForTenant('submissions', STILL_ACTIVE_TENANT_ID);
  const attemptsAfter = await collectionCountForTenant('attempts', STILL_ACTIVE_TENANT_ID);
  check('...its submissions are really gone', subsAfter === 0, String(subsAfter));
  check('...its attempts are really gone', attemptsAfter === 0, String(attemptsAfter));
  const otherTenantSubsAfter = await collectionCountForTenant('submissions', 'some-other-tenant-id');
  check('...an unrelated tenant\'s submission in the SAME building survives untouched', otherTenantSubsAfter === 1, String(otherTenantSubsAfter));

  // The building itself (still active, never archived) must survive - this function only ever
  // touches the one named tenant and its own history, never the building doc.
  const buildingStillThere = await getDoc(doc(otherAdmin.db, 'buildings', STILL_ACTIVE_BUILDING_ID));
  check('...and the still-active BUILDING itself is untouched (only the tenant was deleted)', buildingStillThere.exists());

  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} — ${r.label}${r.ok ? '' : ' ' + r.extra}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(err => { console.error('Test run crashed:', err); process.exit(1); });
