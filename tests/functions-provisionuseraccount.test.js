// Verifies provisionUserAccount's auth + validation + rate-limit logic against the local Functions
// emulator (Workstream 15, Part 3) - mirrors tests/functions-sendinductionemail.test.js's approach.
// This function's happy path ends in a REAL SMTP send attempt (buildTransporter/sendViaSmtp), same
// as sendInductionEmail/sendMyResultEmail - with the throwaway credentials in
// functions/.secret.local, that real network call is expected to fail (an 'internal' error, "The
// mail server rejected the send."), not a connection failure - proving the function got all the
// way through auth/validation/account-creation/link-generation before only the final send step
// fails, same reasoning already established for this codebase's other two email functions. Account
// creation itself is verified directly via the Auth emulator (_getAdminAuthForTests), not via the
// callable's own return value, since that value is never reached when the send fails.
//
// Run: npm run test:functions-provisionuseraccount
// On this machine, port 5001 may already be taken by an unrelated project's dev server - run
// instead with:
//   firebase --config firebase.local-test.json emulators:exec --only firestore,auth,functions "node tests/functions-provisionuseraccount.test.js"
const fs = require('fs');
const path = require('path');
const { initializeApp } = require('firebase/app');
const { getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signInWithEmailAndPassword } = require('firebase/auth');
const { getFirestore, connectFirestoreEmulator, doc, setDoc } = require('firebase/firestore');
const { getFunctions, connectFunctionsEmulator, httpsCallable } = require('firebase/functions');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');

const RULES_PATH = path.join(__dirname, '..', 'firestore.rules');
const OWNER_EMAIL = 'esgtradeflex@gmail.com';
const RANDOM_EMAIL = 'random-user@example.com';
const PASSWORD = 'test-password-123';
const FUNCTIONS_PORT = Number(process.env.FUNCTIONS_EMULATOR_PORT || 5001);
// Must match functions/index.js's PROVISION_RATE_LIMIT_MAX_CALLS — kept in sync by hand, same
// reasoning as every other hand-synced constant in this test suite (no shared module).
const PROVISION_RATE_LIMIT_MAX_CALLS = 30;

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

async function callProvision(functions, payload) {
  const fn = httpsCallable(functions, 'provisionUserAccount');
  try {
    const result = await fn(payload);
    return { ok: true, data: result.data };
  } catch (err) {
    return { ok: false, code: err.code, message: err.message };
  }
}

async function main() {
  const owner = await makeClient('owner', OWNER_EMAIL, PASSWORD);
  const anon = await makeClient('anon', null, null);
  const random = await makeClient('random', RANDOM_EMAIL, PASSWORD);

  const anonResult = await callProvision(anon.functions, { email: 'new-person@example.com', role: 'user' });
  check('unauthenticated call is rejected', !anonResult.ok && anonResult.code === 'functions/unauthenticated', JSON.stringify(anonResult));

  const randomResult = await callProvision(random.functions, { email: 'new-person@example.com', role: 'user' });
  check('non-admin signed-in call is rejected', !randomResult.ok && randomResult.code === 'functions/permission-denied', JSON.stringify(randomResult));

  const badEmailResult = await callProvision(owner.functions, { email: 'not-an-email', role: 'user' });
  check('an invalid email is rejected', !badEmailResult.ok && badEmailResult.code === 'functions/invalid-argument', JSON.stringify(badEmailResult));

  const missingEmailResult = await callProvision(owner.functions, { role: 'user' });
  check('a missing email is rejected', !missingEmailResult.ok && missingEmailResult.code === 'functions/invalid-argument', JSON.stringify(missingEmailResult));

  const badRoleResult = await callProvision(owner.functions, { email: 'new-person@example.com', role: 'super-duper-admin' });
  check('an invalid role value is rejected', !badRoleResult.ok && badRoleResult.code === 'functions/invalid-argument', JSON.stringify(badRoleResult));

  // --- Happy path: valid admin + valid payload -> the account creation succeeds and the call
  // returns ok:true even though the real SMTP send fails (throwaway test credentials) - a flaky
  // send must not throw away the account/role grant, so the function reports emailSent:false
  // instead of throwing (confirmed 2026-10-06, after finding the original all-or-nothing design
  // would silently grant NO access at all whenever the invite email happened to fail). ---
  const { _getAdminAuthForTests } = require('../functions/index.js');
  const adminAuth = _getAdminAuthForTests();
  const newPersonEmail = `provision-test-${Date.now()}@example.com`;

  const firstCall = await callProvision(owner.functions, { email: newPersonEmail, role: 'administrator' });
  check('a valid admin call succeeds (ok:true) even though the real SMTP send fails with throwaway test credentials',
    firstCall.ok && firstCall.data.ok === true && firstCall.data.alreadyExisted === false && firstCall.data.emailSent === false,
    JSON.stringify(firstCall));

  const createdUser = await adminAuth.getUserByEmail(newPersonEmail).catch((err) => null);
  check('the Auth account was really created even though the email send failed afterward',
    Boolean(createdUser) && createdUser.email === newPersonEmail, JSON.stringify(createdUser && createdUser.email));

  // --- Idempotent re-add: calling again for the same (now-existing) email must not error out on
  // account creation itself (no "already exists" crash) and must not create a second account. ---
  const secondCall = await callProvision(owner.functions, { email: newPersonEmail, role: 'user' });
  check('calling again for an already-existing account succeeds with alreadyExisted:true (no duplicate-account error)',
    secondCall.ok && secondCall.data.alreadyExisted === true, JSON.stringify(secondCall));

  const usersAfterSecondCall = await adminAuth.listUsers(1000);
  const matchingUsers = usersAfterSecondCall.users.filter((u) => u.email === newPersonEmail);
  check('exactly one Auth account exists for that email after two calls (idempotent, no duplicate)',
    matchingUsers.length === 1, matchingUsers.length);

  // --- Rate limit: seed the counter directly at the cap (same technique as
  // functions-sendinductionemail.test.js's seedRateLimitCounter) rather than making
  // PROVISION_RATE_LIMIT_MAX_CALLS real slow SMTP-reaching calls just to prove the limit exists. ---
  const testEnv = await initializeTestEnvironment({
    projectId: 'esg-1-98f35',
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'provisionRateLimits', OWNER_EMAIL), { count: PROVISION_RATE_LIMIT_MAX_CALLS, windowStart: Date.now() });
  });
  await testEnv.cleanup();
  const overLimitResult = await callProvision(owner.functions, { email: 'rate-limited@example.com', role: 'user' });
  check(`a call at the ${PROVISION_RATE_LIMIT_MAX_CALLS}/window cap is rejected as resource-exhausted`,
    !overLimitResult.ok && overLimitResult.code === 'functions/resource-exhausted', JSON.stringify(overLimitResult));

  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} — ${r.label}${r.ok ? '' : ' ' + r.extra}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error('Test run crashed:', err); process.exit(1); });
