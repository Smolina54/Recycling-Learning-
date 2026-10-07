// Verifies the 2 remaining Workstream 12 (Bintracker building/tenant catalog sync) Cloud
// Functions against the local Functions emulator: syncBintrackerTenants and
// deleteTenantPermanently. (discoverBintrackerBuildings was removed 2026-10-07, Workstream 15
// Part 4 - "Check for new buildings" is now a plain client-side Firestore read of
// discovery/bintrackerBuildings, no longer a Cloud Function at all.) Mirrors
// tests/functions-deletebuildingpermanently.test.js's exact harness/style (same emulator
// bootstrap, check()/results array, real seeded Firestore data via the rules-unit-testing SDK).
//
// syncBintrackerTenants no longer calls Bintracker's live API either (same date, same
// workstream) - it queries this app's own already-stored bintrackerRows (written by the nightly
// scheduled sync), so every case below exercises its real auth/validation/precondition logic
// against the real Firestore emulator, no network/credentials involved at all. The pure diff
// logic (diffDiscoveredBuildingNames/diffBintrackerTenants, still used by the nightly sync and by
// "Check for new buildings"'s stored-doc shape respectively) is covered separately below with
// realistic seeded row shapes, no network/emulator dependency.
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
const SUPER_ADMIN_ONLY_EMAIL = 'super-admin-only@example.com'; // granted via /superAdmins, NEVER /admins
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

// Regression test for a real bug found in a pre-production audit: two existing tenants with
// similar names could both "contains"-match the SAME raw Bintracker string, since the original
// code ran findBestMatch independently per tenant with no exclusion of already-claimed names.
// Only one raw name here ("Acme Legal Services Pty Ltd"), and BOTH "Acme Legal" and "Acme Legal
// Services" are legitimate substring matches for it — before the fix, both tenants would end up
// pointing at the identical match (and the identical location data); after the fix, only one
// claims it and the other correctly falls back to "missing" rather than getting a bogus match.
function testDiffBintrackerTenantsNoDoubleClaim() {
  const existingTenants = [
    { id: 'acme-legal-id', name: 'Acme Legal', levels: ['Level 5'] },
    { id: 'acme-legal-services-id', name: 'Acme Legal Services', levels: ['Level 9'] },
  ];
  const rawRows = [
    { tenant: 'Acme Legal Services Pty Ltd', primaryLocation: 'Level 5' },
  ];

  const { missingTenants, levelMismatches } = diffBintrackerTenants(rawRows, existingTenants);

  const claimedIds = new Set(levelMismatches.map((m) => m.tenantId));
  // Every level-mismatch entry that references this one raw name must come from at most ONE
  // tenant — the bug's exact symptom was both tenants showing up here, both pointing at the
  // same bintrackerTenantRaw and the same seen-location data.
  check('diffBintrackerTenants: two similarly-named tenants never both claim the same raw match',
    claimedIds.size <= 1, JSON.stringify({ missingTenants, levelMismatches }));

  // Exactly one of the two tenants ends up unmatched (missing) as a direct consequence — this is
  // the correct, honest outcome for genuinely ambiguous data (an admin needs to resolve it
  // manually), not a silent double-match.
  check('...and exactly one of the two similarly-named tenants ends up unmatched (ambiguity surfaced, not hidden)',
    missingTenants.length === 1 &&
      (missingTenants[0].tenantId === 'acme-legal-id' || missingTenants[0].tenantId === 'acme-legal-services-id'),
    JSON.stringify(missingTenants));
}

async function main() {
  testDiffDiscoveredBuildingNames();
  testDiffBintrackerTenants();
  testDiffBintrackerTenantsNoDoubleClaim();

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
  const anonSync = await callFn(anon.functions, 'syncBintrackerTenants', { buildingId: SEED_BUILDING_ID })();
  check('syncBintrackerTenants: unauthenticated call is rejected',
    !anonSync.ok && anonSync.code === 'functions/unauthenticated', JSON.stringify(anonSync));
  const anonDelete = await callFn(anon.functions, 'deleteTenantPermanently', { buildingId: SEED_BUILDING_ID, tenantId: SEED_TENANT_ID, confirmName: 'Seed Tenant' })();
  check('deleteTenantPermanently: unauthenticated call is rejected',
    !anonDelete.ok && anonDelete.code === 'functions/unauthenticated', JSON.stringify(anonDelete));

  const random = await makeClient('random', RANDOM_EMAIL, PASSWORD);
  const randomSync = await callFn(random.functions, 'syncBintrackerTenants', { buildingId: SEED_BUILDING_ID })();
  check('syncBintrackerTenants: non-admin signed-in call is rejected',
    !randomSync.ok && randomSync.code === 'functions/permission-denied', JSON.stringify(randomSync));
  const randomDelete = await callFn(random.functions, 'deleteTenantPermanently', { buildingId: SEED_BUILDING_ID, tenantId: SEED_TENANT_ID, confirmName: 'Seed Tenant' })();
  check('deleteTenantPermanently: non-admin signed-in call is rejected',
    !randomDelete.ok && randomDelete.code === 'functions/permission-denied', JSON.stringify(randomDelete));

  const owner = await makeClient('owner', OWNER_EMAIL, PASSWORD);
  await setDoc(doc(owner.db, 'admins', OTHER_ADMIN_EMAIL), { addedBy: OWNER_EMAIL });
  const otherAdmin = await makeClient('otherAdmin', OTHER_ADMIN_EMAIL, PASSWORD);

  // Regression check for a real production bug found 2026-10-07: a Super Admin with NO separate
  // /admins doc of their own (the normal case - see functions/index.js's assertIsAdmin() and
  // firestore.rules' isAllowedReviewer() for the two halves of this same fix) got "Not an admin"
  // calling syncBintrackerTenants/deleteTenantPermanently, because assertIsAdmin() only ever
  // checked /admins, never /superAdmins.
  await setDoc(doc(owner.db, 'superAdmins', SUPER_ADMIN_ONLY_EMAIL), { addedBy: OWNER_EMAIL });
  const superAdminOnly = await makeClient('superAdminOnly', SUPER_ADMIN_ONLY_EMAIL, PASSWORD);
  const superAdminSync = await callFn(superAdminOnly.functions, 'syncBintrackerTenants', { buildingId: SEED_BUILDING_ID })();
  check('syncBintrackerTenants: a Super Admin with NO /admins doc of their own is NOT rejected as "Not an admin"',
    !(superAdminSync.code === 'functions/permission-denied'), JSON.stringify(superAdminSync));
  const superAdminDelete = await callFn(superAdminOnly.functions, 'deleteTenantPermanently', { buildingId: 'does-not-exist', tenantId: 'does-not-exist', confirmName: 'x' })();
  check('deleteTenantPermanently: same Super Admin is NOT rejected as "Not an admin" either (fails not-found instead, proving it got past the admin gate)',
    superAdminDelete.code === 'functions/not-found', JSON.stringify(superAdminDelete));

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
    // A tenant-scoped distribution link and a Bintracker tenant-match doc — a pre-production
    // audit found deleteTenantPermanently's cascade skipped both, leaving a stale link still
    // publicly resolvable at ?l=<linkId> and a stale match doc referencing a tenant that no
    // longer exists. Seed one of each for the tenant being deleted, plus one of each for the
    // unrelated tenant, to prove both the sweep and the cross-tenant isolation.
    await setDoc(doc(db, 'links', `${STILL_ACTIVE_TENANT_ID}-link`), {
      buildingId: STILL_ACTIVE_BUILDING_ID, tenantId: STILL_ACTIVE_TENANT_ID, programId: 'recycling-sorting', createdAt: Date.now(),
    });
    await setDoc(doc(db, 'bintrackerTenantMatches', `${STILL_ACTIVE_BUILDING_ID}__${STILL_ACTIVE_TENANT_ID}`), {
      buildingId: STILL_ACTIVE_BUILDING_ID, tenantId: STILL_ACTIVE_TENANT_ID, tenantName: 'Still Active Tenant',
      bintrackerTenantRaw: 'Still Active Tenant', status: 'confirmed',
    });
    await setDoc(doc(db, 'links', 'other-tenant-link-' + Date.now()), {
      buildingId: STILL_ACTIVE_BUILDING_ID, tenantId: 'some-other-tenant-id', programId: 'recycling-sorting', createdAt: Date.now(),
    });
    await setDoc(doc(db, 'bintrackerTenantMatches', `${STILL_ACTIVE_BUILDING_ID}__some-other-tenant-id`), {
      buildingId: STILL_ACTIVE_BUILDING_ID, tenantId: 'some-other-tenant-id', tenantName: 'Some Other Tenant',
      bintrackerTenantRaw: 'Some Other Tenant', status: 'confirmed',
    });
  });

  const happyDelete = await callFn(otherAdmin.functions, 'deleteTenantPermanently', {
    buildingId: STILL_ACTIVE_BUILDING_ID, tenantId: STILL_ACTIVE_TENANT_ID, confirmName: 'Still Active Tenant',
  })();
  check('deleteTenantPermanently: a STILL-ACTIVE tenant (no archive-first gate) can be deleted directly',
    happyDelete.ok && happyDelete.data && happyDelete.data.ok === true, JSON.stringify(happyDelete));
  if (happyDelete.ok) {
    const c = happyDelete.data.deletedCounts;
    check('...and deletedCounts matches what was seeded (3 submissions, 2 attempts, 1 link, 1 match)',
      c.submissions === 3 && c.attempts === 2 && c.links === 1 && c.bintrackerTenantMatches === 1, JSON.stringify(c));
  }

  const tenantDocAfter = await getDoc(doc(otherAdmin.db, 'buildings', STILL_ACTIVE_BUILDING_ID, 'tenants', STILL_ACTIVE_TENANT_ID));
  check('...the tenant doc itself is really gone', !tenantDocAfter.exists());
  const subsAfter = await collectionCountForTenant('submissions', STILL_ACTIVE_TENANT_ID);
  const attemptsAfter = await collectionCountForTenant('attempts', STILL_ACTIVE_TENANT_ID);
  const linksAfter = await collectionCountForTenant('links', STILL_ACTIVE_TENANT_ID);
  const matchesAfter = await collectionCountForTenant('bintrackerTenantMatches', STILL_ACTIVE_TENANT_ID);
  check('...its submissions are really gone', subsAfter === 0, String(subsAfter));
  check('...its attempts are really gone', attemptsAfter === 0, String(attemptsAfter));
  check('...its distribution link is really gone (a pre-production audit found this leaking)', linksAfter === 0, String(linksAfter));
  check('...its Bintracker tenant-match doc is really gone (a pre-production audit found this leaking)', matchesAfter === 0, String(matchesAfter));
  const otherTenantSubsAfter = await collectionCountForTenant('submissions', 'some-other-tenant-id');
  const otherTenantLinksAfter = await collectionCountForTenant('links', 'some-other-tenant-id');
  const otherTenantMatchesAfter = await collectionCountForTenant('bintrackerTenantMatches', 'some-other-tenant-id');
  check('...an unrelated tenant\'s submission in the SAME building survives untouched', otherTenantSubsAfter === 1, String(otherTenantSubsAfter));
  check('...an unrelated tenant\'s link survives untouched', otherTenantLinksAfter === 1, String(otherTenantLinksAfter));
  check('...an unrelated tenant\'s Bintracker match survives untouched', otherTenantMatchesAfter === 1, String(otherTenantMatchesAfter));

  // The building itself (still active, never archived) must survive - this function only ever
  // touches the one named tenant and its own history, never the building doc.
  const buildingStillThere = await getDoc(doc(otherAdmin.db, 'buildings', STILL_ACTIVE_BUILDING_ID));
  check('...and the still-active BUILDING itself is untouched (only the tenant was deleted)', buildingStillThere.exists());

  // --- Rate limit: deleteTenantPermanently only (syncBintrackerTenants dropped its own rate
  // limit 2026-10-07 - it no longer calls Bintracker's live API at all, just queries this app's
  // own already-stored bintrackerRows, so the original "protect the shared 3rd-party account from
  // a hammering client" reasoning no longer applies to it). ---
  const DELETE_RATE_LIMIT_MAX_CALLS = 50;
  await withRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'deleteRateLimits', OTHER_ADMIN_EMAIL), { count: DELETE_RATE_LIMIT_MAX_CALLS, windowStart: Date.now() });
  });
  const rateLimitedDelete = await callFn(otherAdmin.functions, 'deleteTenantPermanently', { buildingId: 'does-not-matter', tenantId: 'does-not-matter', confirmName: 'x' })();
  check(`deleteTenantPermanently: a call at the ${DELETE_RATE_LIMIT_MAX_CALLS}/window delete cap is rejected as resource-exhausted`,
    !rateLimitedDelete.ok && rateLimitedDelete.code === 'functions/resource-exhausted', JSON.stringify(rateLimitedDelete));

  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} — ${r.label}${r.ok ? '' : ' ' + r.extra}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(err => { console.error('Test run crashed:', err); process.exit(1); });
