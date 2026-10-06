// Verifies firestore.rules against the local Firestore emulator.
// Run via `npm run test:rules` (starts the emulator, runs this, shuts it down).
const fs = require('fs');
const path = require('path');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');
const { doc, setDoc, getDoc, getDocs, collection, addDoc, deleteDoc, updateDoc, query, where } = require('firebase/firestore');

const RULES_PATH = path.join(__dirname, '..', 'firestore.rules');
const ALLOWED_EMAIL = 'esgtradeflex@gmail.com';
const OTHER_EMAIL = 'someone.else@gmail.com';

const validSubmission = {
  buildingId: 'building-1', buildingName: 'Test Tower',
  tenantId: 'tenant-1', tenantName: 'Test Co', level: 'Level 4',
  name: 'Jane Doe', email: 'jane@example.com', programId: 'recycling-sorting', score: 88,
};

const validAttempt = {
  buildingId: 'building-1', buildingName: 'Test Tower',
  tenantId: 'tenant-1', tenantName: 'Test Co', level: 'Level 4',
  name: 'Jane Doe', email: 'jane@example.com', programId: 'recycling-sorting',
};

// Recycling Sorting submissions now require a deterministic doc id (2026-10-02 - "one real result
// per person per building") - mirrors the exact formula firestore.rules checks, so a genuinely
// valid payload's write actually succeeds instead of being rejected only on this new id condition.
function submissionDocId(data){
  return `${data.programId}__${data.buildingId}__${data.email.toLowerCase()}`;
}

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
  await record('non-allowlisted signed-in user CANNOT set itemOverrides on a building (same write rule as the name field, no separate schema for it)', () =>
    assertFails(setDoc(doc(otherUser, 'buildings', 'building-new'), { itemOverrides: { 'pc-box': { stream: 'mr' } } }, { merge: true })));
  await record('allowlisted user CAN set itemOverrides on a building', () =>
    assertSucceeds(setDoc(doc(allowedUser, 'buildings', 'building-new'), { itemOverrides: { 'pc-box': { stream: 'mr' } } }, { merge: true })));

  await record('anon can create a valid submission', () =>
    assertSucceeds(setDoc(doc(anon, 'submissions', submissionDocId(validSubmission)), validSubmission)));
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

  // hasReasonableSizes()'s avoided/total/correctCount/duration_seconds/device_type bounds — added
  // after a pre-production audit found these 5 fields were on the field allowlist with NO type
  // or size check at all, unlike everything else in hasReasonableSizes(). A direct API write
  // (bypassing this app's own client UI entirely) could otherwise attach an arbitrarily large
  // nested map/array to any of them, up to Firestore's 1MB-per-doc ceiling, with no rate limit in
  // front of submissions.create to stop a scripted flood of near-1MB documents.
  await record('anon CANNOT create a submission with a non-numeric avoided count (type confusion)', () =>
    assertFails(addDoc(collection(anon, 'submissions'), { ...validSubmission, avoided: { huge: 'x'.repeat(100000) } })));
  await record('anon CANNOT create a submission with an absurdly large avoided count', () =>
    assertFails(addDoc(collection(anon, 'submissions'), { ...validSubmission, avoided: 999999999 })));
  await record('anon CANNOT create a submission with a negative total', () =>
    assertFails(addDoc(collection(anon, 'submissions'), { ...validSubmission, total: -1 })));
  await record('anon CANNOT create a submission with an out-of-range duration_seconds (more than a day)', () =>
    assertFails(addDoc(collection(anon, 'submissions'), { ...validSubmission, duration_seconds: 999999 })));
  await record('anon CANNOT create a submission with an oversized device_type string', () =>
    assertFails(addDoc(collection(anon, 'submissions'), { ...validSubmission, device_type: 'x'.repeat(51) })));
  await record('anon CAN create a submission with realistic avoided/total/duration_seconds/device_type values', () => {
    const data = { ...validSubmission, email: 'jane-realistic@example.com', avoided: 20, total: 25, duration_seconds: 180, device_type: 'mobile-touch' };
    return assertSucceeds(setDoc(doc(anon, 'submissions', submissionDocId(data)), data));
  });
  await record('anon CANNOT create a submission missing programId', () => {
    const bad = { ...validSubmission }; delete bad.programId;
    return assertFails(addDoc(collection(anon, 'submissions'), bad));
  });
  await record('anon can create a submission carrying a linkId with no expiresAt (permanent link)', () =>
    testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'links', 'link-no-expiry'), { programId: 'recycling-sorting', buildingId: 'building-1', tenantId: null });
    }).then(() => {
      const data = { ...validSubmission, email: 'jane-linknoexpiry@example.com', linkId: 'link-no-expiry' };
      return assertSucceeds(setDoc(doc(anon, 'submissions', submissionDocId(data)), data));
    }));
  await record('anon can create a submission carrying a linkId that has not expired yet', () =>
    testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'links', 'link-future'), { programId: 'recycling-sorting', buildingId: 'building-1', tenantId: null, expiresAt: new Date(Date.now() + 3600000) });
    }).then(() => {
      const data = { ...validSubmission, email: 'jane-linkfuture@example.com', linkId: 'link-future' };
      return assertSucceeds(setDoc(doc(anon, 'submissions', submissionDocId(data)), data));
    }));
  await record('anon CANNOT create a submission carrying a linkId that already expired', () =>
    testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'links', 'link-past'), { programId: 'recycling-sorting', buildingId: 'building-1', tenantId: null, expiresAt: new Date(Date.now() - 3600000) });
    }).then(() => assertFails(addDoc(collection(anon, 'submissions'), { ...validSubmission, linkId: 'link-past' }))));
  await record('allowlisted user CAN revoke a link early by setting expiresAt to now, blocking further submissions against it', () =>
    testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'links', 'link-to-revoke'), { programId: 'recycling-sorting', buildingId: 'building-1', tenantId: null, expiresAt: new Date(Date.now() + 3600000) });
    })
      .then(() => assertSucceeds(updateDoc(doc(allowedUser, 'links', 'link-to-revoke'), { expiresAt: new Date(Date.now() - 1000) })))
      .then(() => assertFails(addDoc(collection(anon, 'submissions'), { ...validSubmission, linkId: 'link-to-revoke' }))));

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
  await record('anon CANNOT create an attempt missing programId', () => {
    const bad = { ...validAttempt }; delete bad.programId;
    return assertFails(addDoc(collection(anon, 'attempts'), bad));
  });
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

  // ---- Program catalog ----
  await record('anon can read programs (public catalog)', () =>
    assertSucceeds(getDoc(doc(anon, 'programs', 'recycling-sorting'))));
  await record('anon CANNOT write to programs', () =>
    assertFails(setDoc(doc(anon, 'programs', 'hacked'), { name: 'Hacked', status: 'active' })));
  await record('non-allowlisted signed-in user CANNOT write to programs', () =>
    assertFails(setDoc(doc(otherUser, 'programs', 'hacked'), { name: 'Hacked', status: 'active' })));
  await record('allowlisted user CAN create a program', () =>
    assertSucceeds(setDoc(doc(allowedUser, 'programs', 'organics-focus'), { name: 'Organics Focus', file: 'organics-training.html', kind: 'game', status: 'active' })));
  await record('allowlisted user CAN archive a program', () =>
    assertSucceeds(setDoc(doc(allowedUser, 'programs', 'organics-focus'), { status: 'archived' }, { merge: true })));

  // ---- Enrollments (building <-> program) ----
  await record('anon can read enrollments (id-gate needs this before showing the form)', () =>
    testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'enrollments', 'recycling-sorting__building-1'), { programId: 'recycling-sorting', buildingId: 'building-1' });
    }).then(() => assertSucceeds(getDoc(doc(anon, 'enrollments', 'recycling-sorting__building-1')))));
  await record('anon CANNOT write to enrollments', () =>
    assertFails(setDoc(doc(anon, 'enrollments', 'recycling-sorting__building-1'), { programId: 'recycling-sorting', buildingId: 'building-1' })));
  await record('non-allowlisted signed-in user CANNOT write to enrollments', () =>
    assertFails(setDoc(doc(otherUser, 'enrollments', 'recycling-sorting__building-1'), { programId: 'recycling-sorting', buildingId: 'building-1' })));
  await record('allowlisted user CAN create an enrollment', () =>
    assertSucceeds(setDoc(doc(allowedUser, 'enrollments', 'recycling-sorting__building-1'), { programId: 'recycling-sorting', buildingId: 'building-1', itemOverrides: {} })));
  await record('allowlisted user CAN deactivate an enrollment (soft-delete, not a real delete)', () =>
    assertSucceeds(setDoc(doc(allowedUser, 'enrollments', 'recycling-sorting__building-1'), { active: false }, { merge: true })));

  // ---- Distribution links (tenant-scoped / expiring) ----
  await record('anon can read a link (must resolve it before the id-gate knows the building)', () =>
    testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'links', 'link-1'), { programId: 'recycling-sorting', buildingId: 'building-1', tenantId: null });
    }).then(() => assertSucceeds(getDoc(doc(anon, 'links', 'link-1')))));
  await record('anon CANNOT create a link', () =>
    assertFails(setDoc(doc(anon, 'links', 'link-hacked'), { programId: 'recycling-sorting', buildingId: 'building-1' })));
  await record('allowlisted user CAN create a link', () =>
    assertSucceeds(setDoc(doc(allowedUser, 'links', 'link-2'), { programId: 'recycling-sorting', buildingId: 'building-1', tenantId: 'tenant-1' })));
  await record('allowlisted user CAN revoke a link by updating expiresAt', () =>
    assertSucceeds(updateDoc(doc(allowedUser, 'links', 'link-2'), { expiresAt: new Date() })));
  await record('nobody, not even the allowlisted user, can delete a link', () =>
    assertFails(deleteDoc(doc(allowedUser, 'links', 'link-2'))));

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

  // ---- Super Admin tier (Workstream 15, Part 3, 2026-10-06): a plain Admin can read /admins and
  // /superAdmins (needed by the Roles screen) but CANNOT write to either — only a Super Admin can
  // grant/revoke Admins or other Super Admins. Tightened from the previous behavior where any
  // existing admin could grant another admin (a real privilege-escalation gap).
  const PLAIN_ADMIN_EMAIL = 'plain-admin@example.com';
  const plainAdmin = testEnv.authenticatedContext('u3b', { email: PLAIN_ADMIN_EMAIL }).firestore();
  const SUPER_ADMIN_EMAIL = 'super-admin@example.com';
  const superAdminUser = testEnv.authenticatedContext('u3c', { email: SUPER_ADMIN_EMAIL }).firestore();

  await record('the owner CAN grant a plain admin via /admins', () =>
    assertSucceeds(setDoc(doc(allowedUser, 'admins', PLAIN_ADMIN_EMAIL), { addedAt: 'now', addedBy: ALLOWED_EMAIL })));
  await record('a plain admin CAN read the /admins list (needed by the Roles screen)', () =>
    assertSucceeds(getDocs(collection(plainAdmin, 'admins'))));
  await record('a plain admin CANNOT grant another admin via /admins (no longer anyone-admin-can-grant)', () =>
    assertFails(setDoc(doc(plainAdmin, 'admins', 'someone-else@example.com'), { addedAt: 'now', addedBy: PLAIN_ADMIN_EMAIL })));
  await record('a plain admin CANNOT revoke an existing admin via /admins either', () =>
    assertFails(deleteDoc(doc(plainAdmin, 'admins', PLAIN_ADMIN_EMAIL))));
  await record('a plain admin CANNOT self-grant super admin access by writing to /superAdmins', () =>
    assertFails(setDoc(doc(plainAdmin, 'superAdmins', PLAIN_ADMIN_EMAIL), { addedAt: 'now' })));
  await record('a plain admin CAN read the /superAdmins list too (same "see but can\'t change" reasoning)', () =>
    assertSucceeds(getDocs(collection(plainAdmin, 'superAdmins'))));

  await record('the owner CAN grant a new super admin via /superAdmins', () =>
    assertSucceeds(setDoc(doc(allowedUser, 'superAdmins', SUPER_ADMIN_EMAIL), { addedAt: 'now', addedBy: ALLOWED_EMAIL })));
  // Regression check for a real production bug found 2026-10-07: a Super Admin with NO separate
  // /admins doc of their own (the normal case - Super Admin is meant to be a standing grant, not a
  // second doc an admin also needs) got "This account doesn't have access" on every admin page,
  // because isAllowedReviewer() - which every admin page's gate reads /admins and /superAdmins
  // through - only ever checked /admins, never /superAdmins. Fixed by having isAllowedReviewer()
  // also accept a /superAdmins doc. These 3 checks lock that fix in.
  await record('a super admin with NO /admins doc of their own CAN still read /admins (isAllowedReviewer must accept superAdmins too)', () =>
    assertSucceeds(getDocs(collection(superAdminUser, 'admins'))));
  await record('...and CAN read /superAdmins the same way', () =>
    assertSucceeds(getDocs(collection(superAdminUser, 'superAdmins'))));
  await record('...and CAN read submissions too (isAllowedReviewer gates this everywhere else in the app)', () =>
    assertSucceeds(getDocs(collection(superAdminUser, 'submissions'))));
  await record('that newly-granted super admin CAN now grant a plain admin via /admins (self-governing tier unlocks admin management too)', () =>
    assertSucceeds(setDoc(doc(superAdminUser, 'admins', 'granted-by-new-super-admin@example.com'), { addedAt: 'now', addedBy: SUPER_ADMIN_EMAIL })));
  await record('...and CAN grant another super admin too', () =>
    assertSucceeds(setDoc(doc(superAdminUser, 'superAdmins', 'second-super-admin@example.com'), { addedAt: 'now', addedBy: SUPER_ADMIN_EMAIL })));
  await record('the owner CAN revoke a super admin via /superAdmins', () =>
    assertSucceeds(deleteDoc(doc(allowedUser, 'superAdmins', SUPER_ADMIN_EMAIL))));
  await record('after revocation, that former super admin CANNOT grant an admin anymore', () =>
    assertFails(setDoc(doc(superAdminUser, 'admins', 'should-fail@example.com'), { addedAt: 'now', addedBy: SUPER_ADMIN_EMAIL })));

  // Clean up the admins this block granted, so the global "the global allowlisted admin is
  // completely unaffected" check further below still sees a clean picture if it ever enumerates.
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await deleteDoc(doc(db, 'admins', PLAIN_ADMIN_EMAIL)).catch(() => {});
    await deleteDoc(doc(db, 'admins', 'granted-by-new-super-admin@example.com')).catch(() => {});
    await deleteDoc(doc(db, 'superAdmins', 'second-super-admin@example.com')).catch(() => {});
  });

  // ---- Per-building scoped access via /buildingAccess (roadmap Workstream 1, Step B) ----
  // A scoped client is granted access to exactly ONE building — never full reviewer rights —
  // while the existing global allowlist above must keep working completely unchanged.
  const SCOPED_CLIENT_EMAIL = 'scoped-client@example.com';
  const scopedClient = testEnv.authenticatedContext('u4', { email: SCOPED_CLIENT_EMAIL }).firestore();

  let scopedSubmissionId, otherBuildingSubmissionId, scopedAttemptId;
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'buildings', 'building-scoped'), { name: 'Scoped Tower' });
    await setDoc(doc(db, 'buildings', 'building-other'), { name: 'Other Tower' });
    scopedSubmissionId = (await addDoc(collection(db, 'submissions'), { ...validSubmission, buildingId: 'building-scoped' })).id;
    otherBuildingSubmissionId = (await addDoc(collection(db, 'submissions'), { ...validSubmission, buildingId: 'building-other' })).id;
    scopedAttemptId = (await addDoc(collection(db, 'attempts'), { ...validAttempt, buildingId: 'building-scoped' })).id;
  });

  await record('a signed-in user with no /buildingAccess grant at all CANNOT read a submission by direct get', () =>
    assertFails(getDoc(doc(scopedClient, 'submissions', scopedSubmissionId))));
  await record('a non-admin user CANNOT self-grant building access by writing to /buildingAccess', () =>
    assertFails(setDoc(doc(scopedClient, 'buildingAccess', `${SCOPED_CLIENT_EMAIL}__building-scoped`), { email: SCOPED_CLIENT_EMAIL, buildingId: 'building-scoped' })));
  await record('the owner CAN grant a scoped client access to one building via /buildingAccess', () =>
    assertSucceeds(setDoc(doc(allowedUser, 'buildingAccess', `${SCOPED_CLIENT_EMAIL}__building-scoped`), { email: SCOPED_CLIENT_EMAIL, buildingId: 'building-scoped', addedAt: 'now', addedBy: ALLOWED_EMAIL })));

  await record('once granted, the scoped client CAN read a submission from THEIR granted building by direct get', () =>
    assertSucceeds(getDoc(doc(scopedClient, 'submissions', scopedSubmissionId))));
  await record('the scoped client CANNOT read a submission from a DIFFERENT building by direct get', () =>
    assertFails(getDoc(doc(scopedClient, 'submissions', otherBuildingSubmissionId))));
  await record('the scoped client CAN read an attempt from their granted building', () =>
    assertSucceeds(getDoc(doc(scopedClient, 'attempts', scopedAttemptId))));

  await record('the scoped client CANNOT run an unfiltered (no buildingId) list query on submissions — Firestore rejects the whole query, not just the disallowed rows', () =>
    assertFails(getDocs(collection(scopedClient, 'submissions'))));
  await record('the scoped client CAN run a submissions query filtered to their own granted building', () =>
    assertSucceeds(getDocs(query(collection(scopedClient, 'submissions'), where('buildingId', 'in', ['building-scoped'])))));
  await record('the scoped client CANNOT query submissions filtered to a building they were not granted', () =>
    assertFails(getDocs(query(collection(scopedClient, 'submissions'), where('buildingId', 'in', ['building-other'])))));

  await record('the global allowlisted admin is completely unaffected — still reads everything with the exact same unfiltered query as before', () =>
    assertSucceeds(getDocs(collection(allowedUser, 'submissions'))));

  await record('the scoped client still CANNOT write to buildings (view-only, no config/edit rights)', () =>
    assertFails(setDoc(doc(scopedClient, 'buildings', 'building-scoped'), { name: 'Hacked' }, { merge: true })));
  await record('the scoped client still CANNOT delete a submission (view-only, delete stays reviewer-only)', () =>
    assertFails(deleteDoc(doc(scopedClient, 'submissions', scopedSubmissionId))));

  await record('the scoped client CAN read their own /buildingAccess grant doc', () =>
    assertSucceeds(getDoc(doc(scopedClient, 'buildingAccess', `${SCOPED_CLIENT_EMAIL}__building-scoped`))));
  await record("the scoped client CANNOT read someone else's /buildingAccess grant doc", () =>
    testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'buildingAccess', 'other-client@example.com__building-other'), { email: 'other-client@example.com', buildingId: 'building-other' });
    }).then(() => assertFails(getDoc(doc(scopedClient, 'buildingAccess', 'other-client@example.com__building-other')))));
  await record('the scoped client CANNOT revoke/modify their own /buildingAccess grant (grant management is admin-only)', () =>
    assertFails(deleteDoc(doc(scopedClient, 'buildingAccess', `${SCOPED_CLIENT_EMAIL}__building-scoped`))));

  await record("the owner CAN revoke the scoped client's access by deleting the /buildingAccess doc", () =>
    assertSucceeds(deleteDoc(doc(allowedUser, 'buildingAccess', `${SCOPED_CLIENT_EMAIL}__building-scoped`))));
  await record('after revocation, the scoped client CANNOT read that submission anymore', () =>
    assertFails(getDoc(doc(scopedClient, 'submissions', scopedSubmissionId))));

  // ---- sendInductionEmail's rate-limit counters (functions/index.js) — Admin-SDK-only ----
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'emailRateLimits', ALLOWED_EMAIL), { count: 1, windowStart: Date.now() });
  });
  await record('even the global admin CANNOT read their own /emailRateLimits counter via the client SDK (Admin-SDK-only, by design)', () =>
    assertFails(getDoc(doc(allowedUser, 'emailRateLimits', ALLOWED_EMAIL))));
  await record('a non-admin CANNOT write an /emailRateLimits counter to fake up their own quota', () =>
    assertFails(setDoc(doc(otherUser, 'emailRateLimits', OTHER_EMAIL), { count: 0, windowStart: Date.now() })));

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
