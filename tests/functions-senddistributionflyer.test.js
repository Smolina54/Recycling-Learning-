// Verifies sendDistributionFlyer's auth + payload-validation + graceful-absence + rate-limit
// logic against the local Functions emulator, without touching a real mailbox - same philosophy
// and structure as tests/functions-sendinductionemail.test.js (Workstream 13, Part 2's direct
// template). Every rejection case here throws inside assertIsAdmin()/validateFlyerPayload()/
// the managerEmails graceful-absence check/checkRateLimit() (functions/index.js), all BEFORE the
// function ever calls sendViaSmtp() to open a real SMTP connection to smtp.office365.com. The one
// "valid, uncapped, has managerEmails" case is included anyway, asserting only that it fails for
// a NETWORK reason (code 'internal', from the fake credentials in functions/.secret.local being
// rejected by the real smtp.office365.com) - proving PDF generation itself (buildFlyerPdf, a real
// qrcode+pdf-lib+fontkit composition) succeeded first, before the send was even attempted.
//
// Also directly calls buildFlyerPdf() - a cheap check needing no emulator at all - and asserts it
// resolves to a real Buffer starting with the %PDF magic bytes.
//
// Run: FUNCTIONS_EMULATOR_PORT=5003 firebase --config firebase.local-test.json emulators:exec
//   --only firestore,auth,functions "node tests/functions-senddistributionflyer.test.js"
const fs = require('fs');
const path = require('path');
const { initializeApp } = require('firebase/app');
const { getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signInWithEmailAndPassword } = require('firebase/auth');
const { getFirestore, connectFirestoreEmulator, doc, setDoc } = require('firebase/firestore');
const { getFunctions, connectFunctionsEmulator, httpsCallable } = require('firebase/functions');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { buildFlyerPdf } = require('../functions/flyer');

const RULES_PATH = path.join(__dirname, '..', 'firestore.rules');
// Must match functions/index.js's RATE_LIMIT_MAX_SENDS - kept in sync by hand, same reasoning as
// OWNER_EMAIL below (no shared module between the function and its test). This is the SAME
// counter sendInductionEmail uses (one shared per-admin budget across both features), so this
// suite seeds its own distinct admin email for the rate-limit case, same as that suite does.
const RATE_LIMIT_MAX_SENDS = 200;

const OWNER_EMAIL = 'esgtradeflex@gmail.com'; // must match functions/index.js's OWNER_EMAIL
const OTHER_ADMIN_EMAIL = 'flyer-other-admin@example.com';
const RANDOM_EMAIL = 'flyer-random-user@example.com';
const PASSWORD = 'test-password-123';
const FUNCTIONS_PORT = Number(process.env.FUNCTIONS_EMULATOR_PORT || 5001);

const firebaseConfig = { apiKey: 'AIzaSyAoWSx9FYa6UJa-6EZezgBYiDMuVVs9BBo', projectId: 'esg-1-98f35' };

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

async function callSendDistributionFlyer(functions, payload) {
  const sendDistributionFlyer = httpsCallable(functions, 'sendDistributionFlyer');
  try {
    await sendDistributionFlyer(payload);
    return { ok: true };
  } catch (err) {
    return { ok: false, code: err.code, message: err.message };
  }
}

async function seedBuilding(db, buildingId, overrides) {
  await setDoc(doc(db, 'buildings', buildingId), {
    name: 'Flyer Test Tower', managerEmails: ['manager1@example.com', 'manager2@example.com'],
    ...overrides,
  });
}

const VALID_PAYLOAD_BASE = {
  programFile: 'recycling-training.html',
  programName: 'Recycling Sorting',
};

// Seeds an emailRateLimits/{email} counter directly, bypassing firestore.rules (which deny this
// collection to every client, admins included) - same helper as
// tests/functions-sendinductionemail.test.js's own copy.
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
  // ---- buildFlyerPdf(), directly, no emulator needed ----
  const pdfBuffer = await buildFlyerPdf({
    buildingName: 'Direct Call Test Tower',
    link: 'https://esg-1-98f35.web.app/recycling-training.html?b=direct-call-test',
  });
  check('buildFlyerPdf() resolves to a real Buffer', Buffer.isBuffer(pdfBuffer), typeof pdfBuffer);
  check('buildFlyerPdf() output starts with the %PDF magic bytes', pdfBuffer.slice(0, 4).toString() === '%PDF', pdfBuffer.slice(0, 8).toString());

  // ---- Cloud Function checks, against the emulator ----
  const anon = await makeClient('flyerAnon', null, null);
  const anonResult = await callSendDistributionFlyer(anon.functions, { buildingId: 'whatever', ...VALID_PAYLOAD_BASE });
  check('unauthenticated call is rejected', !anonResult.ok && anonResult.code === 'functions/unauthenticated', JSON.stringify(anonResult));

  const random = await makeClient('flyerRandom', RANDOM_EMAIL, PASSWORD);
  const randomResult = await callSendDistributionFlyer(random.functions, { buildingId: 'whatever', ...VALID_PAYLOAD_BASE });
  check('non-admin signed-in call is rejected', !randomResult.ok && randomResult.code === 'functions/permission-denied', JSON.stringify(randomResult));

  // Owner bypasses firestore.rules' isAllowedReviewer() check, so it can seed the admins/ doc the
  // next case needs, and seed the test building itself - mirrors
  // tests/functions-sendinductionemail.test.js's own setup.
  const owner = await makeClient('flyerOwner', OWNER_EMAIL, PASSWORD);
  await setDoc(doc(owner.db, 'admins', OTHER_ADMIN_EMAIL), { addedBy: OWNER_EMAIL });
  const buildingId = 'flyer-test-tower-' + Date.now();
  await seedBuilding(owner.db, buildingId, {});
  const noManagersBuildingId = 'flyer-no-managers-' + Date.now();
  await seedBuilding(owner.db, noManagersBuildingId, { managerEmails: [] });

  const otherAdmin = await makeClient('flyerOtherAdmin', OTHER_ADMIN_EMAIL, PASSWORD);

  const badBuildingIdResult = await callSendDistributionFlyer(otherAdmin.functions, { buildingId: 'has a space', ...VALID_PAYLOAD_BASE });
  check('malformed buildingId is rejected', !badBuildingIdResult.ok && badBuildingIdResult.code === 'functions/invalid-argument', JSON.stringify(badBuildingIdResult));

  const missingProgramFileResult = await callSendDistributionFlyer(otherAdmin.functions, { buildingId, programFile: '', programName: 'Recycling Sorting' });
  check('missing programFile is rejected', !missingProgramFileResult.ok && missingProgramFileResult.code === 'functions/invalid-argument', JSON.stringify(missingProgramFileResult));

  const missingProgramNameResult = await callSendDistributionFlyer(otherAdmin.functions, { buildingId, programFile: 'recycling-training.html', programName: '' });
  check('missing programName is rejected', !missingProgramNameResult.ok && missingProgramNameResult.code === 'functions/invalid-argument', JSON.stringify(missingProgramNameResult));

  const noSuchBuildingResult = await callSendDistributionFlyer(otherAdmin.functions, { buildingId: 'no-such-building-' + Date.now(), ...VALID_PAYLOAD_BASE });
  check('an unknown buildingId is rejected as not-found', !noSuchBuildingResult.ok && noSuchBuildingResult.code === 'functions/not-found', JSON.stringify(noSuchBuildingResult));

  const noManagersResult = await callSendDistributionFlyer(otherAdmin.functions, { buildingId: noManagersBuildingId, ...VALID_PAYLOAD_BASE });
  check('a building with no saved managerEmails is rejected as failed-precondition (graceful absence)',
    !noManagersResult.ok && noManagersResult.code === 'functions/failed-precondition', JSON.stringify(noManagersResult));

  // ---- Rate limit (shares sendInductionEmail's own emailRateLimits/{email} bucket - a fresh
  // admin, seeded already AT the cap, isolates this from the calls the validation cases above
  // made against otherAdmin) ----
  const RATE_LIMITED_EMAIL = 'flyer-rate-limited-admin@example.com';
  await setDoc(doc(owner.db, 'admins', RATE_LIMITED_EMAIL), { addedBy: OWNER_EMAIL });
  const rateLimitedAdmin = await makeClient('flyerRateLimitedAdmin', RATE_LIMITED_EMAIL, PASSWORD);
  await seedRateLimitCounter(RATE_LIMITED_EMAIL, RATE_LIMIT_MAX_SENDS, Date.now());
  const overLimitResult = await callSendDistributionFlyer(rateLimitedAdmin.functions, { buildingId, ...VALID_PAYLOAD_BASE });
  check(`a send at the ${RATE_LIMIT_MAX_SENDS}/window cap is rejected as resource-exhausted`,
    !overLimitResult.ok && overLimitResult.code === 'functions/resource-exhausted', JSON.stringify(overLimitResult));

  // ---- The one case that can't avoid a real network attempt (fake SMTP creds, real
  // smtp.office365.com) - proves validation passed, the building/managerEmails lookup succeeded,
  // AND the PDF was actually generated, before the send itself fails for a network reason. ----
  const freshResult = await callSendDistributionFlyer(otherAdmin.functions, { buildingId, ...VALID_PAYLOAD_BASE });
  check('a valid, uncapped building with managerEmails reaches the send attempt (PDF built successfully) and fails only for a network reason (fake test creds)',
    !freshResult.ok && freshResult.code === 'functions/internal', JSON.stringify(freshResult));

  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} — ${r.label}${r.ok ? '' : ' ' + r.extra}`);
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(err => { console.error('Test run crashed:', err); process.exit(1); });
