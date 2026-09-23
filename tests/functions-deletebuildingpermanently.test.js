// Verifies deleteBuildingPermanently's auth + archive-first gate + name-confirmation + full
// cascade-delete behavior against the local Functions emulator — a real, deliberately destructive
// admin-only operation (Workstream 10 in the plan), so this test seeds real data directly via
// Firestore (bypassing rules, same technique as functions-sendinductionemail.test.js's
// seedRateLimitCounter) and asserts it's ACTUALLY gone afterward, not just that the call returned
// ok:true.
//
// Run: npm run test:functions-delete-building
// On this machine, port 5001 (firebase.json's default Functions emulator port) may already be
// taken by an unrelated project's dev server — run instead with:
//   firebase --config firebase.local-test.json emulators:exec --only firestore,auth,functions "node tests/functions-deletebuildingpermanently.test.js"
const fs = require('fs');
const path = require('path');
const { initializeApp } = require('firebase/app');
const { getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signInWithEmailAndPassword } = require('firebase/auth');
const {
  getFirestore, connectFirestoreEmulator, doc, getDoc, getDocs, collection, setDoc,
} = require('firebase/firestore');
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

async function callDelete(functions, payload) {
  const fn = httpsCallable(functions, 'deleteBuildingPermanently');
  try {
    const result = await fn(payload);
    return { ok: true, data: result.data };
  } catch (err) {
    return { ok: false, code: err.code, message: err.message };
  }
}

// Bypasses firestore.rules entirely (same reasoning as seedRateLimitCounter in
// functions-sendinductionemail.test.js — several of these collections deny client writes
// outright, e.g. links/attempts, so there's no other way to seed them for this test).
async function withRulesDisabled(fn) {
  const testEnv = await initializeTestEnvironment({
    projectId: 'esg-1-98f35',
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  await testEnv.withSecurityRulesDisabled(fn);
  await testEnv.cleanup();
}

// Seeds a building doc, N tenants, N submissions, N attempts, one link, one enrollment, and one
// buildingAccess grant — everything the cascade delete needs to touch. Returns nothing; the
// caller re-reads via the normal SDK (rules re-enabled) to prove what survived/was deleted.
async function seedBuildingData(buildingId, name, { active, submissionCount = 2, attemptCount = 2 }) {
  await withRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'buildings', buildingId), { name, active });
    await setDoc(doc(db, 'buildings', buildingId, 'tenants', 't1'), { name: 'Tenant One', active: true });
    await setDoc(doc(db, 'buildings', buildingId, 'tenants', 't2'), { name: 'Tenant Two', active: true });
    for (let i = 0; i < submissionCount; i++) {
      await setDoc(doc(db, 'submissions', `${buildingId}-sub-${i}`), { buildingId, programId: 'recycling-sorting', score: 80 });
    }
    for (let i = 0; i < attemptCount; i++) {
      await setDoc(doc(db, 'attempts', `${buildingId}-att-${i}`), { buildingId, programId: 'recycling-sorting' });
    }
    await setDoc(doc(db, 'links', `${buildingId}-link-1`), { buildingId, programId: 'recycling-sorting' });
    await setDoc(doc(db, 'enrollments', `recycling-sorting__${buildingId}`), { buildingId, programId: 'recycling-sorting', active: true });
    await setDoc(doc(db, 'buildingAccess', `manager@example.com__${buildingId}`), { email: 'manager@example.com', buildingId });
  });
}

async function collectionCountForBuilding(db, collectionName, buildingId) {
  const testEnv = await initializeTestEnvironment({
    projectId: 'esg-1-98f35',
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  let count = 0;
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const { getDocs: getDocsRaw, collection: collectionRaw, query: queryRaw, where: whereRaw } = require('firebase/firestore');
    const snap = await getDocsRaw(queryRaw(collectionRaw(context.firestore(), collectionName), whereRaw('buildingId', '==', buildingId)));
    count = snap.size;
  });
  await testEnv.cleanup();
  return count;
}

async function main() {
  const VALID_BUILDING_ID = 'test-tower-' + Date.now();
  await seedBuildingData(VALID_BUILDING_ID, 'Test Tower', { active: false });

  const anon = await makeClient('anon', null, null);
  const anonResult = await callDelete(anon.functions, { buildingId: VALID_BUILDING_ID, confirmName: 'Test Tower' });
  check('unauthenticated call is rejected', !anonResult.ok && anonResult.code === 'functions/unauthenticated', JSON.stringify(anonResult));

  const random = await makeClient('random', RANDOM_EMAIL, PASSWORD);
  const randomResult = await callDelete(random.functions, { buildingId: VALID_BUILDING_ID, confirmName: 'Test Tower' });
  check('non-admin signed-in call is rejected', !randomResult.ok && randomResult.code === 'functions/permission-denied', JSON.stringify(randomResult));

  const owner = await makeClient('owner', OWNER_EMAIL, PASSWORD);
  await setDoc(doc(owner.db, 'admins', OTHER_ADMIN_EMAIL), { addedBy: OWNER_EMAIL });
  const otherAdmin = await makeClient('otherAdmin', OTHER_ADMIN_EMAIL, PASSWORD);

  // --- Still-active building: server-side archive-first gate ---
  const ACTIVE_BUILDING_ID = 'active-tower-' + Date.now();
  await seedBuildingData(ACTIVE_BUILDING_ID, 'Active Tower', { active: true, submissionCount: 1, attemptCount: 1 });
  const activeResult = await callDelete(otherAdmin.functions, { buildingId: ACTIVE_BUILDING_ID, confirmName: 'Active Tower' });
  check('admin call on a still-active building is rejected (archive-first gate)',
    !activeResult.ok && activeResult.code === 'functions/failed-precondition', JSON.stringify(activeResult));
  const activeSubsAfter = await collectionCountForBuilding(otherAdmin.db, 'submissions', ACTIVE_BUILDING_ID);
  check('the still-active building\'s data survived the rejected call', activeSubsAfter === 1, String(activeSubsAfter));

  // --- Wrong confirmName ---
  const wrongNameResult = await callDelete(otherAdmin.functions, { buildingId: VALID_BUILDING_ID, confirmName: 'Not The Real Name' });
  check('wrong confirmName is rejected', !wrongNameResult.ok && wrongNameResult.code === 'functions/failed-precondition', JSON.stringify(wrongNameResult));
  const survivedSubs = await collectionCountForBuilding(otherAdmin.db, 'submissions', VALID_BUILDING_ID);
  check('data survives a wrong-name-rejected call', survivedSubs === 2, String(survivedSubs));

  // --- Cross-building isolation control, seeded alongside the real deletion below ---
  const OTHER_BUILDING_ID = 'other-tower-' + Date.now();
  await seedBuildingData(OTHER_BUILDING_ID, 'Other Tower', { active: false, submissionCount: 1, attemptCount: 1 });

  // --- Happy path ---
  const happyResult = await callDelete(otherAdmin.functions, { buildingId: VALID_BUILDING_ID, confirmName: 'Test Tower' });
  check('correct name on an archived building succeeds', happyResult.ok && happyResult.data && happyResult.data.ok === true, JSON.stringify(happyResult));
  if (happyResult.ok) {
    const c = happyResult.data.deletedCounts;
    check('deletedCounts matches what was seeded',
      c.submissions === 2 && c.attempts === 2 && c.links === 1 && c.enrollments === 1 && c.buildingAccess === 1 && c.tenants === 2,
      JSON.stringify(c));
  }
  const buildingDocAfter = await getDoc(doc(otherAdmin.db, 'buildings', VALID_BUILDING_ID));
  check('the building doc itself is gone', !buildingDocAfter.exists());
  const tenantsAfter = await getDocs(collection(otherAdmin.db, 'buildings', VALID_BUILDING_ID, 'tenants'));
  check('the tenants subcollection is gone too (recursiveDelete)', tenantsAfter.empty, String(tenantsAfter.size));
  const subsAfter = await collectionCountForBuilding(otherAdmin.db, 'submissions', VALID_BUILDING_ID);
  const attemptsAfter = await collectionCountForBuilding(otherAdmin.db, 'attempts', VALID_BUILDING_ID);
  const linksAfter = await collectionCountForBuilding(otherAdmin.db, 'links', VALID_BUILDING_ID);
  check('submissions are actually gone', subsAfter === 0, String(subsAfter));
  check('attempts are actually gone', attemptsAfter === 0, String(attemptsAfter));
  check('links are actually gone', linksAfter === 0, String(linksAfter));

  // --- Cross-building isolation ---
  const otherSubsAfter = await collectionCountForBuilding(otherAdmin.db, 'submissions', OTHER_BUILDING_ID);
  check('an unrelated building\'s data survives untouched', otherSubsAfter === 1, String(otherSubsAfter));

  // --- Chunking correctness: >400 submissions for one building ---
  const CHUNK_BUILDING_ID = 'chunk-tower-' + Date.now();
  await withRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'buildings', CHUNK_BUILDING_ID), { name: 'Chunk Tower', active: false });
    const writes = [];
    for (let i = 0; i < 420; i++) {
      writes.push(setDoc(doc(db, 'submissions', `${CHUNK_BUILDING_ID}-sub-${i}`), { buildingId: CHUNK_BUILDING_ID, programId: 'recycling-sorting' }));
    }
    await Promise.all(writes);
  });
  const chunkResult = await callDelete(otherAdmin.functions, { buildingId: CHUNK_BUILDING_ID, confirmName: 'Chunk Tower' });
  check('420-submission building deletes successfully (chunked past the 400-per-page limit)',
    chunkResult.ok && chunkResult.data.deletedCounts.submissions === 420, JSON.stringify(chunkResult.ok ? chunkResult.data.deletedCounts : chunkResult));
  const chunkSubsAfter = await collectionCountForBuilding(otherAdmin.db, 'submissions', CHUNK_BUILDING_ID);
  check('every one of the 420 submissions is actually gone, not just the first page', chunkSubsAfter === 0, String(chunkSubsAfter));

  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} — ${r.label}${r.ok ? '' : ' ' + r.extra}`);
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(err => { console.error('Test run crashed:', err); process.exit(1); });
