// Verifies syncOneBuildingNow (Workstream 21, 2026-10-09) against the local Functions emulator.
// This function is the one deliberate exception to "no button calls Bintracker live"
// (Workstream 15 Part 4) - it's never triggered by a manual button, only automatically as a side
// effect of mapping a building (see admin-buildings.html's "Add this building" and
// save-bintracker-mapping-btn handlers). Mirrors tests/functions-bintrackersync.test.js's exact
// harness/style (same emulator bootstrap, check()/results array, real seeded Firestore data via
// the rules-unit-testing SDK).
//
// Every rejection path below (auth, permission, invalid-argument, not-found, failed-precondition)
// is exercised fully against the real Firestore emulator, no network/credentials involved - none
// of these ever reach fetchBintrackerCollections. The one happy-path case below DOES reach past
// every validation check and attempts a real network call using the placeholder test credentials
// in functions/.secret.local - against Bintracker's real endpoint, this is expected to fail (no
// real network in this sandbox, or a real auth rejection from Bintracker either way), so it only
// asserts the call got PAST every pre-flight check (none of the specific rejection codes above),
// proving the wrapper correctly reaches processOneBuildingRows's own fetch step. The underlying
// fetch+diff+write logic itself (processOneBuildingRows) already has full, separate test coverage
// with controlled fake rows in tests/functions-scheduledbintrackerrefresh.test.js - not repeated
// here.
//
// Run: npm run test:functions-synconebuilding
// On this machine, port 5001 (firebase.json's default Functions emulator port) may already be
// taken by an unrelated project's dev server - run instead with:
//   firebase --config firebase.local-test.json emulators:exec --only firestore,auth,functions "node tests/functions-synconebuilding.test.js"
const path = require('path');
const fs = require('fs');
const { initializeApp } = require('firebase/app');
const { getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signInWithEmailAndPassword } = require('firebase/auth');
const { getFirestore, connectFirestoreEmulator, doc, setDoc } = require('firebase/firestore');
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
    const fn = httpsCallable(functions, 'syncOneBuildingNow', { timeout: 120000 });
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
  const MAPPED_BUILDING_ID = 'syncnow-tower-' + Date.now();
  const UNMAPPED_BUILDING_ID = 'syncnow-unmapped-' + Date.now();
  await withRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'buildings', MAPPED_BUILDING_ID), { name: 'Sync Now Tower', bintrackerBuildingName: 'Sync Now Test Tower' });
    await setDoc(doc(db, 'buildings', UNMAPPED_BUILDING_ID), { name: 'Unmapped Sync Now Tower' });
  });

  const anon = await makeClient('anon', null, null);
  const anonResult = await callFn(anon.functions, { buildingId: MAPPED_BUILDING_ID })();
  check('unauthenticated call is rejected', !anonResult.ok && anonResult.code === 'functions/unauthenticated', JSON.stringify(anonResult));

  const random = await makeClient('random', RANDOM_EMAIL, PASSWORD);
  const randomResult = await callFn(random.functions, { buildingId: MAPPED_BUILDING_ID })();
  check('non-admin signed-in call is rejected', !randomResult.ok && randomResult.code === 'functions/permission-denied', JSON.stringify(randomResult));

  const owner = await makeClient('owner', OWNER_EMAIL, PASSWORD);
  await setDoc(doc(owner.db, 'admins', OTHER_ADMIN_EMAIL), { addedBy: OWNER_EMAIL });
  const otherAdmin = await makeClient('otherAdmin', OTHER_ADMIN_EMAIL, PASSWORD);

  const missingIdResult = await callFn(otherAdmin.functions, {})();
  check('missing buildingId is rejected as invalid-argument', !missingIdResult.ok && missingIdResult.code === 'functions/invalid-argument', JSON.stringify(missingIdResult));

  const notFoundResult = await callFn(otherAdmin.functions, { buildingId: 'does-not-exist-' + Date.now() })();
  check('a non-existent building is rejected as not-found', !notFoundResult.ok && notFoundResult.code === 'functions/not-found', JSON.stringify(notFoundResult));

  const unmappedResult = await callFn(otherAdmin.functions, { buildingId: UNMAPPED_BUILDING_ID })();
  check('a building with no bintrackerBuildingName is rejected as failed-precondition',
    !unmappedResult.ok && unmappedResult.code === 'functions/failed-precondition', JSON.stringify(unmappedResult));

  // A mapped building's call must reach PAST every pre-flight check above - it either succeeds
  // (unlikely with placeholder test credentials) or fails for a reason that is NOT one of the
  // specific rejection codes already proven above, confirming the wrapper correctly reaches
  // processOneBuildingRows's own fetch step.
  const mappedResult = await callFn(otherAdmin.functions, { buildingId: MAPPED_BUILDING_ID })();
  const preflightCodes = ['functions/unauthenticated', 'functions/permission-denied', 'functions/invalid-argument', 'functions/not-found', 'functions/failed-precondition'];
  check('a mapped building\'s call gets past every pre-flight check (reaches the real fetch step)',
    mappedResult.ok || !preflightCodes.includes(mappedResult.code), JSON.stringify(mappedResult));

  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} — ${r.label}${r.ok ? '' : ' ' + r.extra}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
