// Verifies sendInductionEmail's auth + payload-validation logic against the local Functions
// emulator, without touching a real mailbox — every case here is rejected inside
// assertIsAdmin()/validatePayload()/checkRateLimit() (functions/index.js), all of which throw
// before the function ever calls sendViaSmtp() to open a real SMTP connection to
// smtp.office365.com. No Blaze plan or real Microsoft 365 credentials needed — the three SMTP
// secrets are given throwaway values in functions/.secret.local purely so the emulator can
// load the function at all.
//
// Run: npm run test:functions
// On this machine, port 5001 (firebase.json's default Functions emulator port) is already
// taken by an unrelated project's dev server — run instead with:
//   firebase --config firebase.local-test.json emulators:exec --only firestore,auth,functions "node tests/functions-sendinductionemail.test.js"
// (firebase.local-test.json is a gitignored, machine-local copy of firebase.json with the
// Functions port moved to 5002; see .gitignore for why it isn't committed.)
const fs = require('fs');
const path = require('path');
const { initializeApp } = require('firebase/app');
const { getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signInWithEmailAndPassword } = require('firebase/auth');
const { getFirestore, connectFirestoreEmulator, doc, setDoc } = require('firebase/firestore');
const { getFunctions, connectFunctionsEmulator, httpsCallable } = require('firebase/functions');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');

const RULES_PATH = path.join(__dirname, '..', 'firestore.rules');
// Must match functions/index.js's RATE_LIMIT_MAX_SENDS — kept in sync by hand, same reasoning
// as OWNER_EMAIL below (no shared module between the function and its test).
const RATE_LIMIT_MAX_SENDS = 200;

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

async function callSendInductionEmail(functions, payload) {
  const sendInductionEmail = httpsCallable(functions, 'sendInductionEmail');
  try {
    await sendInductionEmail(payload);
    return { ok: true };
  } catch (err) {
    return { ok: false, code: err.code, message: err.message };
  }
}

const VALID_PAYLOAD = { to: ['tenant@example.com'], subject: 'Induction link', text: 'Here is your link.' };

// Seeds an emailRateLimits/{email} counter directly, bypassing firestore.rules (which deny
// this collection to every client, admins included) — the only way to put an admin "already
// at the cap" without actually making RATE_LIMIT_MAX_SENDS real calls first.
async function seedRateLimitCounter(email, count, windowStart) {
  const testEnv = await initializeTestEnvironment({
    projectId: 'esg-1-98f35',
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'emailRateLimits', email), { count, windowStart });
  });
  await testEnv.cleanup();
}

async function main() {
  const anon = await makeClient('anon', null, null);
  const anonResult = await callSendInductionEmail(anon.functions, VALID_PAYLOAD);
  check('unauthenticated call is rejected', !anonResult.ok && anonResult.code === 'functions/unauthenticated', JSON.stringify(anonResult));

  const random = await makeClient('random', RANDOM_EMAIL, PASSWORD);
  const randomResult = await callSendInductionEmail(random.functions, VALID_PAYLOAD);
  check('non-admin signed-in call is rejected', !randomResult.ok && randomResult.code === 'functions/permission-denied', JSON.stringify(randomResult));

  // Owner bypasses firestore.rules' isAllowedReviewer() check, so it can seed the admins/
  // doc the next case needs — mirrors how the report's own Admins panel grants access.
  const owner = await makeClient('owner', OWNER_EMAIL, PASSWORD);
  await setDoc(doc(owner.db, 'admins', OTHER_ADMIN_EMAIL), { addedBy: OWNER_EMAIL });

  const otherAdmin = await makeClient('otherAdmin', OTHER_ADMIN_EMAIL, PASSWORD);

  const emptyToResult = await callSendInductionEmail(otherAdmin.functions, { to: [], subject: 'x', text: 'y' });
  check('empty recipient list is rejected', !emptyToResult.ok && emptyToResult.code === 'functions/invalid-argument', JSON.stringify(emptyToResult));

  const tooManyResult = await callSendInductionEmail(otherAdmin.functions, {
    to: Array.from({ length: 21 }, (_, i) => `person${i}@example.com`), subject: 'x', text: 'y',
  });
  check('21 recipients (over the cap of 20) is rejected', !tooManyResult.ok && tooManyResult.code === 'functions/invalid-argument', JSON.stringify(tooManyResult));

  const badEmailResult = await callSendInductionEmail(otherAdmin.functions, { to: ['not-an-email'], subject: 'x', text: 'y' });
  check('malformed recipient address is rejected', !badEmailResult.ok && badEmailResult.code === 'functions/invalid-argument', JSON.stringify(badEmailResult));

  const missingSubjectResult = await callSendInductionEmail(otherAdmin.functions, { to: ['ok@example.com'], subject: '', text: 'y' });
  check('missing subject is rejected', !missingSubjectResult.ok && missingSubjectResult.code === 'functions/invalid-argument', JSON.stringify(missingSubjectResult));

  const missingTextResult = await callSendInductionEmail(otherAdmin.functions, { to: ['ok@example.com'], subject: 'x', text: '' });
  check('missing body text is rejected', !missingTextResult.ok && missingTextResult.code === 'functions/invalid-argument', JSON.stringify(missingTextResult));

  // ---- Rate limit ----
  // A fresh admin (not otherAdmin above, to keep this counter isolated from the calls those
  // validation cases made) seeded already AT the cap, within the current window. checkRateLimit()
  // runs after validatePayload() but before sendViaSmtp(), so this rejection — like every case
  // above — never reaches the network. The window-reset path (an expired window resets the
  // counter and lets a call through) isn't covered here on purpose: proving it would mean letting
  // a call past checkRateLimit into a real SMTP connection attempt, which is exactly the real
  // network call this whole file is built to avoid (see the file's own header comment) — that
  // path stays untested pre-deployment, same as the send itself.
  const RATE_LIMITED_EMAIL = 'rate-limited-admin@example.com';
  await setDoc(doc(owner.db, 'admins', RATE_LIMITED_EMAIL), { addedBy: OWNER_EMAIL });
  const rateLimitedAdmin = await makeClient('rateLimitedAdmin', RATE_LIMITED_EMAIL, PASSWORD);
  await seedRateLimitCounter(RATE_LIMITED_EMAIL, RATE_LIMIT_MAX_SENDS, Date.now());
  const overLimitResult = await callSendInductionEmail(rateLimitedAdmin.functions, VALID_PAYLOAD);
  check(`a send at the ${RATE_LIMIT_MAX_SENDS}/window cap is rejected as resource-exhausted`,
    !overLimitResult.ok && overLimitResult.code === 'functions/resource-exhausted', JSON.stringify(overLimitResult));

  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} — ${r.label}${r.ok ? '' : ' ' + r.extra}`);
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(err => { console.error('Test run crashed:', err); process.exit(1); });
