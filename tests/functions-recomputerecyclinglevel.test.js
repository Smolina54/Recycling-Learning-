// Verifies recomputeRecyclingLevelNow (Workstream 26, 2026-10-12) against the local Functions
// emulator. Confirming a tenant's Bintracker match used to leave its recyclingLevelPct unset until
// the next nightly scheduled run - this function recomputes it immediately from already-stored
// bintrackerRows, with no Bintracker API call at all (unlike syncOneBuildingNow), so every case
// below - including the real happy path - is fully testable with no external credentials needed.
//
// Run: npm run test:functions-recomputerecyclinglevel
// On this machine, port 5001 (firebase.json's default Functions emulator port) may already be
// taken by an unrelated project's dev server - run instead with:
//   firebase --config firebase.local-test.json emulators:exec --only firestore,auth,functions "node tests/functions-recomputerecyclinglevel.test.js"
const path = require('path');
const fs = require('fs');
const { initializeApp } = require('firebase/app');
const { getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signInWithEmailAndPassword } = require('firebase/auth');
const { getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc } = require('firebase/firestore');
const { getFunctions, connectFunctionsEmulator, httpsCallable } = require('firebase/functions');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');

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

function callFn(functions, payload) {
  return async () => {
    const fn = httpsCallable(functions, 'recomputeRecyclingLevelNow', { timeout: 60000 });
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

async function main() {
  const BUILDING_ID = 'recompute-test-building-' + Date.now();
  const TENANT_ID = 'recompute-test-tenant-' + Date.now();
  const UNMAPPED_BUILDING_ID = 'recompute-unmapped-' + Date.now();
  const todayStr = new Date().toISOString().slice(0, 10);

  await withRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'buildings', BUILDING_ID), { name: 'Recompute Test Tower', active: true, bintrackerBuildingName: 'Recompute Test Tower' });
    await setDoc(doc(db, 'buildings', UNMAPPED_BUILDING_ID), { name: 'Recompute Unmapped Tower', active: true });
    await setDoc(doc(db, 'buildings', BUILDING_ID, 'tenants', TENANT_ID), { name: 'Acme Co', levels: ['Level 1'], active: true });

    // Building-level (externalOnly:true): 3 recyclable (mr/pc/og) + 2 non-recyclable (gw), weight
    // 10 each -> recovered 30 / generated 50 = 60%.
    const buildingRows = [
      { ourStream: 'mr', weight: 10 }, { ourStream: 'pc', weight: 10 }, { ourStream: 'og', weight: 10 },
      { ourStream: 'gw', weight: 10 }, { ourStream: 'gw', weight: 10 },
    ];
    for (let i = 0; i < buildingRows.length; i++) {
      await setDoc(doc(db, 'bintrackerRows', `${BUILDING_ID}-building-row-${i}`), {
        buildingId: BUILDING_ID, collectDate: todayStr, externalOnly: true,
        bintrackerTenantRaw: 'Irrelevant For Building Calc', ...buildingRows[i],
      });
    }

    // Tenant-level (externalOnly:false, matching the confirmed raw name): 4 recyclable + 1
    // non-recyclable, weight 10 each -> recovered 40 / generated 50 = 80%.
    const tenantRows = [
      { ourStream: 'mr', weight: 10 }, { ourStream: 'pc', weight: 10 }, { ourStream: 'og', weight: 10 }, { ourStream: 'mr', weight: 10 },
      { ourStream: 'gw', weight: 10 },
    ];
    for (let i = 0; i < tenantRows.length; i++) {
      await setDoc(doc(db, 'bintrackerRows', `${BUILDING_ID}-tenant-row-${i}`), {
        buildingId: BUILDING_ID, collectDate: todayStr, externalOnly: false,
        bintrackerTenantRaw: 'Acme Raw', ...tenantRows[i],
      });
    }

    await setDoc(doc(db, 'bintrackerTenantMatches', `${BUILDING_ID}__${TENANT_ID}`), {
      buildingId: BUILDING_ID, tenantId: TENANT_ID, tenantName: 'Acme Co',
      bintrackerTenantRaw: 'Acme Raw', bintrackerLocationRaw: 'Level 1',
      confirmedBy: OWNER_EMAIL, status: 'confirmed',
    });
  });

  const anon = await makeClient('anon', null, null);
  const anonResult = await callFn(anon.functions, { buildingId: BUILDING_ID })();
  check('unauthenticated call is rejected', !anonResult.ok && anonResult.code === 'functions/unauthenticated', JSON.stringify(anonResult));

  const random = await makeClient('random', RANDOM_EMAIL, PASSWORD);
  const randomResult = await callFn(random.functions, { buildingId: BUILDING_ID })();
  check('non-admin signed-in call is rejected', !randomResult.ok && randomResult.code === 'functions/permission-denied', JSON.stringify(randomResult));

  const owner = await makeClient('owner', OWNER_EMAIL, PASSWORD);
  await setDoc(doc(owner.db, 'admins', OTHER_ADMIN_EMAIL), { addedBy: OWNER_EMAIL });
  const otherAdmin = await makeClient('otherAdmin', OTHER_ADMIN_EMAIL, PASSWORD);

  const missingIdResult = await callFn(otherAdmin.functions, {})();
  check('missing buildingId is rejected as invalid-argument', !missingIdResult.ok && missingIdResult.code === 'functions/invalid-argument', JSON.stringify(missingIdResult));

  const notFoundResult = await callFn(otherAdmin.functions, { buildingId: 'does-not-exist-' + Date.now() })();
  check('a non-existent building is rejected as not-found', !notFoundResult.ok && notFoundResult.code === 'functions/not-found', JSON.stringify(notFoundResult));

  // Unlike syncOneBuildingNow, this function never calls Bintracker's API at all, so it does NOT
  // require bintrackerBuildingName to be set - it only ever reads already-stored bintrackerRows.
  const unmappedResult = await callFn(otherAdmin.functions, { buildingId: UNMAPPED_BUILDING_ID })();
  check('a building with no Bintracker mapping and no stored rows still succeeds (nothing to compute, not an error)',
    unmappedResult.ok, JSON.stringify(unmappedResult));

  // --- Real happy path: recompute from the seeded bintrackerRows above ---
  const happyResult = await callFn(otherAdmin.functions, { buildingId: BUILDING_ID })();
  check('the real recompute call succeeds', happyResult.ok, JSON.stringify(happyResult));

  const buildingSnap = await getDoc(doc(otherAdmin.db, 'buildings', BUILDING_ID));
  check('the building-level recyclingLevelPct is computed correctly from external rows (30/50 -> 60%)',
    buildingSnap.data().recyclingLevelPct === 60, buildingSnap.data().recyclingLevelPct);

  const tenantSnap = await getDoc(doc(otherAdmin.db, 'buildings', BUILDING_ID, 'tenants', TENANT_ID));
  check('the tenant-level recyclingLevelPct is computed correctly from internal rows matching its confirmed raw name (40/50 -> 80%)',
    tenantSnap.data().recyclingLevelPct === 80, tenantSnap.data().recyclingLevelPct);

  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} — ${r.label}${r.ok ? '' : ' ' + r.extra}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
