// Verifies sendMyResultEmail's validation/lookup/rate-limit logic against the local Functions
// emulator. Unlike sendInductionEmail, this function is deliberately UNAUTHENTICATED (trainees
// never sign in) — every rejection case here (missing id, bad email, unknown submission, at the
// per-submission cap) is designed to throw before ever reaching sendViaSmtp()'s real network
// call, same principle as the admin email suite. The one case that genuinely can't avoid the
// network (a valid, not-yet-capped submission) is included anyway, asserting only that it fails
// for a NETWORK reason (code 'internal', from the fake credentials in functions/.secret.local
// being rejected by the real smtp.office365.com) rather than a validation bug — and, more
// importantly, that the per-submission bookkeeping (sendCount increment, corrected email
// persisted) already happened by the time that network attempt is made.
//
// Run: FUNCTIONS_EMULATOR_PORT=5003 firebase --config firebase.local-test.json emulators:exec
//   --only firestore,auth,functions "node tests/functions-sendmyresultemail.test.js"
const path = require('path');
const fs = require('fs');
const { initializeApp } = require('firebase/app');
const { getFunctions, connectFunctionsEmulator, httpsCallable } = require('firebase/functions');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc, getDoc } = require('firebase/firestore');

const RULES_PATH = path.join(__dirname, '..', 'firestore.rules');
const RESULT_EMAIL_MAX_SENDS = 5; // must match functions/index.js's RESULT_EMAIL_MAX_SENDS
const FUNCTIONS_PORT = Number(process.env.FUNCTIONS_EMULATOR_PORT || 5001);

const firebaseConfig = { apiKey: 'AIzaSyAoWSx9FYa6UJa-6EZezgBYiDMuVVs9BBo', projectId: 'esg-1-98f35' };

const results = [];
function check(label, cond, extra) { results.push({ label, ok: Boolean(cond), extra: extra || '' }); }

async function seedSubmission(id, overrides) {
  const testEnv = await initializeTestEnvironment({
    projectId: 'esg-1-98f35',
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'submissions', id), {
      programId: 'recycling-sorting', buildingId: 'test-building', buildingName: 'Test Tower',
      name: 'Test Trainee', email: 'trainee@example.com', score: 80, avoided: 20, total: 25,
      breakdown: { gw: { avoided: 5, total: 5 }, mr: { avoided: 3, total: 5 }, pc: { avoided: 4, total: 5 }, og: { avoided: 4, total: 5 }, ew: { avoided: 4, total: 5 } },
      items: { 'mr-jar': 0, 'og-coffee': 1 },
      ...overrides,
    });
  });
  return testEnv;
}

async function readSubmission(id) {
  const testEnv = await initializeTestEnvironment({
    projectId: 'esg-1-98f35',
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  let data = null;
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const snap = await getDoc(doc(context.firestore(), 'submissions', id));
    data = snap.exists() ? snap.data() : null;
  });
  return data;
}

async function callSendMyResultEmail(functions, payload) {
  const fn = httpsCallable(functions, 'sendMyResultEmail');
  try {
    await fn(payload);
    return { ok: true };
  } catch (err) {
    return { ok: false, code: err.code, message: err.message };
  }
}

async function main() {
  const app = initializeApp(firebaseConfig);
  const functions = getFunctions(app, 'australia-southeast2');
  connectFunctionsEmulator(functions, '127.0.0.1', FUNCTIONS_PORT);

  const missingIdResult = await callSendMyResultEmail(functions, { confirmedEmail: 'a@example.com' });
  check('missing submissionId is rejected', !missingIdResult.ok && missingIdResult.code === 'functions/invalid-argument', JSON.stringify(missingIdResult));

  const badEmailResult = await callSendMyResultEmail(functions, { submissionId: 'whatever', confirmedEmail: 'not-an-email' });
  check('malformed confirmedEmail is rejected', !badEmailResult.ok && badEmailResult.code === 'functions/invalid-argument', JSON.stringify(badEmailResult));

  const notFoundResult = await callSendMyResultEmail(functions, { submissionId: 'does-not-exist-' + Date.now(), confirmedEmail: 'a@example.com' });
  check('unknown submissionId is rejected as not-found', !notFoundResult.ok && notFoundResult.code === 'functions/not-found', JSON.stringify(notFoundResult));

  const cappedId = 'test-sub-capped-' + Date.now();
  await seedSubmission(cappedId, { sendCount: RESULT_EMAIL_MAX_SENDS });
  const cappedResult = await callSendMyResultEmail(functions, { submissionId: cappedId, confirmedEmail: 'a@example.com' });
  check(`a submission already at the ${RESULT_EMAIL_MAX_SENDS}-send cap is rejected as resource-exhausted`,
    !cappedResult.ok && cappedResult.code === 'functions/resource-exhausted', JSON.stringify(cappedResult));

  // The one case that can't avoid a real network attempt (fake SMTP creds, real smtp.office365.com).
  const freshId = 'test-sub-fresh-' + Date.now();
  await seedSubmission(freshId, {});
  const freshResult = await callSendMyResultEmail(functions, { submissionId: freshId, confirmedEmail: 'corrected@example.com' });
  check('a valid, uncapped submission reaches the send attempt and fails only for a network reason (fake test creds)',
    !freshResult.ok && freshResult.code === 'functions/internal', JSON.stringify(freshResult));

  const freshAfter = await readSubmission(freshId);
  check('sendCount was incremented before the send attempt', freshAfter && freshAfter.sendCount === 1, JSON.stringify(freshAfter && freshAfter.sendCount));
  check('the corrected email was persisted back onto the submission', freshAfter && freshAfter.email === 'corrected@example.com', JSON.stringify(freshAfter && freshAfter.email));

  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} — ${r.label}${r.ok ? '' : ' ' + r.extra}`);
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(err => { console.error('Test run crashed:', err); process.exit(1); });
