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

const validAttempt = {
  buildingId: 'building-1', buildingName: 'Test Tower',
  tenantId: 'tenant-1', tenantName: 'Test Co', level: 'Level 4',
  name: 'Jane Doe', email: 'jane@example.com',
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
  await record('non-allowlisted signed-in user CANNOT write to buildings', () =>
    assertFails(setDoc(doc(otherUser, 'buildings', 'building-3'), { name: 'Nope' })));
  await record('allowlisted user CAN create a building', () =>
    assertSucceeds(setDoc(doc(allowedUser, 'buildings', 'building-new'), { name: 'New Tower' })));
  await record('allowlisted user CAN create a tenant under a building', () =>
    assertSucceeds(setDoc(doc(allowedUser, 'buildings', 'building-new', 'tenants', 'tenant-new'), { name: 'New Co', levels: ['Level 1'] })));
  await record('anon CANNOT create a tenant under a building', () =>
    assertFails(setDoc(doc(anon, 'buildings', 'building-new', 'tenants', 'tenant-hacked'), { name: 'Hacked', levels: [] })));

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
  await record('anon CANNOT create a submission with score above 100 (a forged/tampered write)', () =>
    assertFails(addDoc(collection(anon, 'submissions'), { ...validSubmission, score: 150 })));
  await record('anon CANNOT create a submission with a negative score', () =>
    assertFails(addDoc(collection(anon, 'submissions'), { ...validSubmission, score: -5 })));
  await record('anon CANNOT create a submission with a malformed email', () =>
    assertFails(addDoc(collection(anon, 'submissions'), { ...validSubmission, email: 'not-an-email' })));
  await record('anon CANNOT create a submission with an oversized name (storage/rendering abuse)', () =>
    assertFails(addDoc(collection(anon, 'submissions'), { ...validSubmission, name: 'x'.repeat(201) })));
  await record('anon CANNOT read submissions', () =>
    assertFails(getDocs(collection(anon, 'submissions'))));
  await record('non-allowlisted signed-in user CANNOT read submissions', () =>
    assertFails(getDocs(collection(otherUser, 'submissions'))));
  await record('allowlisted user CAN read submissions', () =>
    assertSucceeds(getDocs(collection(allowedUser, 'submissions'))));

  await record('anon can create a valid attempt', () =>
    assertSucceeds(addDoc(collection(anon, 'attempts'), validAttempt)));
  await record('anon CANNOT create an attempt missing tenantId', () => {
    const bad = { ...validAttempt }; delete bad.tenantId;
    return assertFails(addDoc(collection(anon, 'attempts'), bad));
  });
  await record('anon CANNOT create an attempt with a malformed email', () =>
    assertFails(addDoc(collection(anon, 'attempts'), { ...validAttempt, email: 'not-an-email' })));
  await record('non-allowlisted signed-in user CANNOT read attempts', () =>
    assertFails(getDocs(collection(otherUser, 'attempts'))));
  await record('allowlisted user CAN read attempts', () =>
    assertSucceeds(getDocs(collection(allowedUser, 'attempts'))));
  await record('nobody, not even the allowlisted user, can delete an attempt', () =>
    testEnv.withSecurityRulesDisabled(async (context) => {
      const ref = await addDoc(collection(context.firestore(), 'attempts'), validAttempt);
      return assertFails(deleteDoc(doc(allowedUser, 'attempts', ref.id)));
    }));

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

  // ---- Dynamic admins: granting/revoking access via the /admins collection ----
  // (mirrors what the report's Admins panel does — no rules edit/redeploy for this)
  const NEW_ADMIN_EMAIL = 'newadmin@example.com';
  const newAdminUser = testEnv.authenticatedContext('u3', { email: NEW_ADMIN_EMAIL }).firestore();

  await record('a not-yet-added user CANNOT read submissions', () =>
    assertFails(getDocs(collection(newAdminUser, 'submissions'))));
  await record('a non-admin user CANNOT self-grant admin access by writing to /admins', () =>
    assertFails(setDoc(doc(newAdminUser, 'admins', NEW_ADMIN_EMAIL), { addedAt: 'now' })));
  await record('the owner CAN grant another admin via /admins', () =>
    assertSucceeds(setDoc(doc(allowedUser, 'admins', NEW_ADMIN_EMAIL), { addedAt: 'now', addedBy: ALLOWED_EMAIL })));
  await record('once granted, that user CAN read submissions', () =>
    assertSucceeds(getDocs(collection(newAdminUser, 'submissions'))));
  await record('once granted, that user CAN also create a building (full reviewer rights)', () =>
    assertSucceeds(setDoc(doc(newAdminUser, 'buildings', 'building-by-new-admin'), { name: 'Granted Tower' })));
  await record('the owner CAN revoke that admin via /admins', () =>
    assertSucceeds(deleteDoc(doc(allowedUser, 'admins', NEW_ADMIN_EMAIL))));
  await record('after revocation, that user CANNOT read submissions anymore', () =>
    assertFails(getDocs(collection(newAdminUser, 'submissions'))));

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
