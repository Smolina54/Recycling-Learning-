// Verifies firestore.rules against the local Firestore emulator.
// Run via `npm run test:rules` (starts the emulator, runs this, shuts it down).
const fs = require('fs');
const path = require('path');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');
const { doc, setDoc, getDoc, getDocs, collection, addDoc, deleteDoc, updateDoc } = require('firebase/firestore');

const RULES_PATH = path.join(__dirname, '..', 'firestore.rules');
const ALLOWED_EMAIL = 'smolina@tradeflex.com.au';
const OTHER_EMAIL = 'someone.else@gmail.com';

const validSubmission = {
  buildingId: 'building-1', buildingName: 'Test Tower',
  tenantId: 'tenant-1', tenantName: 'Test Co', level: 'Level 4',
  name: 'Jane Doe', email: 'jane@example.com', score: 88,
};

const results = [];
function record(label, fn){
  return fn().then(
    () => { results.push({label, ok: true}); },
    (err) => { results.push({label, ok: false, error: err.message}); }
  );
}

async function main(){
  const testEnv = await initializeTestEnvironment({
    projectId: 'sorting-station-test',
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
  });

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'buildings', 'building-1'), { name: 'Test Tower' });
    await setDoc(doc(db, 'buildings', 'building-1', 'tenants', 'tenant-1'), { name: 'Test Co', levels: ['Level 4'] });
  });

  const anon = testEnv.unauthenticatedContext().firestore();
  const allowedUser = testEnv.authenticatedContext('u1', { email: ALLOWED_EMAIL }).firestore();
  const otherUser = testEnv.authenticatedContext('u2', { email: OTHER_EMAIL }).firestore();

  await record('anon can read buildings (public)', () =>
    assertSucceeds(getDoc(doc(anon, 'buildings', 'building-1'))));
  await record('anon can read tenants subcollection (public)', () =>
    assertSucceeds(getDocs(collection(anon, 'buildings', 'building-1', 'tenants'))));
  await record('anon CANNOT write to buildings', () =>
    assertFails(setDoc(doc(anon, 'buildings', 'building-2'), { name: 'Hacked' })));

  await record('anon can create a valid submission', () =>
    assertSucceeds(addDoc(collection(anon, 'submissions'), validSubmission)));
  await record('anon CANNOT create a submission missing email', () =>
    assertFails(addDoc(collection(anon, 'submissions'), { ...validSubmission, email: '' })));
  await record('anon CANNOT create a submission missing buildingId', () => {
    const bad = { ...validSubmission }; delete bad.buildingId;
    return assertFails(addDoc(collection(anon, 'submissions'), bad));
  });
  await record('anon CANNOT create a submission with non-numeric score', () =>
    assertFails(addDoc(collection(anon, 'submissions'), { ...validSubmission, score: '88' })));
  await record('anon CANNOT read submissions', () =>
    assertFails(getDocs(collection(anon, 'submissions'))));
  await record('non-allowlisted signed-in user CANNOT read submissions', () =>
    assertFails(getDocs(collection(otherUser, 'submissions'))));
  await record('allowlisted user CAN read submissions', () =>
    assertSucceeds(getDocs(collection(allowedUser, 'submissions'))));

  let targetId;
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const ref = await addDoc(collection(context.firestore(), 'submissions'), validSubmission);
    targetId = ref.id;
  });
  await record('allowlisted user CAN delete a submission', () =>
    assertSucceeds(deleteDoc(doc(allowedUser, 'submissions', targetId))));

  let targetId2;
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const ref = await addDoc(collection(context.firestore(), 'submissions'), validSubmission);
    targetId2 = ref.id;
  });
  await record('non-allowlisted user CANNOT delete a submission', () =>
    assertFails(deleteDoc(doc(otherUser, 'submissions', targetId2))));
  await record('allowlisted user CANNOT update a submission (updates always denied)', () =>
    assertFails(updateDoc(doc(allowedUser, 'submissions', targetId2), { score: 100 })));

  await testEnv.cleanup();

  console.log('\n--- RESULTS ---');
  let allOk = true;
  for (const r of results){
    console.log(`${r.ok ? 'PASS' : 'FAIL'} — ${r.label}${r.ok ? '' : ' :: ' + r.error}`);
    if (!r.ok) allOk = false;
  }
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => { console.error('Test harness crashed:', err); process.exit(1); });
