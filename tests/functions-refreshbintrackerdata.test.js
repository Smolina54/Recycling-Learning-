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

  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} — ${r.label}${r.ok ? '' : ' ' + r.extra}`);
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(err => { console.error('Test run crashed:', err); process.exit(1); });
