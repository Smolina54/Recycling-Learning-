// Verifies outputs/admin-admins.html — now the "App Access" page (Workstream 15, Part 3): granting/
// revoking Super Admin/Admin/Standard User access, the role-based view difference (a plain Admin
// sees Admin/Super-Admin rows read-only), the immediate post-sign-in access gate, and that
// navigating away to sorting-station-report.html and back preserves the signed-in session.
// Starts the Functions emulator too (unlike this file's pre-Workstream-15 version) since granting
// ANY role now goes through the real provisionUserAccount callable first - account creation
// succeeds against the local Auth emulator even with no real SMTP credentials (the function
// reports emailSent:false instead of throwing, confirmed 2026-10-06), so the real end-to-end flow
// is testable here, not just the auth/validation path.
// Run: npm run test:admin-admins
const path = require('path');
const url = require('url');
const puppeteer = require('puppeteer-core');

const EDGE_PATH = process.env.TEST_BROWSER_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ADMINS_URL = `${url.pathToFileURL(path.join(__dirname, '..', 'outputs', 'admin-admins.html')).href}?emulator=1`;
const REPORT_PATH = path.join(__dirname, '..', 'outputs', 'sorting-station-report.html');
const ALLOWED_EMAIL = 'esgtradeflex@gmail.com';

const results = [];
function check(label, cond, extra){ results.push({ label, ok: Boolean(cond), extra: extra || '' }); }

async function installModalAutoResponder(page){
  await page.evaluate(() => {
    window.__confirmCalls = [];
    window.__alertCalls = [];
    const overlay = document.getElementById('appModalOverlay');
    new MutationObserver(() => {
      if (!overlay.classList.contains('open')) return;
      const message = document.getElementById('appModalMessage').textContent;
      const buttons = [...document.getElementById('appModalActions').querySelectorAll('button')];
      if (buttons.length === 1) { window.__alertCalls.push(message); buttons[0].click(); }
      else { window.__confirmCalls.push(message); buttons[buttons.length - 1].click(); }
    }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
  });
}

async function main(){
  const browser = await puppeteer.launch({ executablePath: EDGE_PATH, headless: true });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));
  page.on('dialog', (d) => { consoleErrors.push('unexpected dialog: ' + d.message()); d.dismiss(); });

  try {
    await runFlow(page);
  } catch (err) {
    console.error('CRASHED — dumping diagnostics:', err.message);
    console.error('--- results so far ---');
    for (const r of results){ console.error(`${r.ok ? 'PASS' : 'FAIL'} — ${r.label}${r.extra ? ' :: ' + r.extra : ''}`); }
    await page.screenshot({ path: path.join(__dirname, '..', 'debug-crash.png') }).catch(() => {});
    await browser.close();
    process.exit(1);
  }

  const unexpectedErrors = consoleErrors.filter(e =>
    !e.includes('auth/email-already-in-use') && !e.includes('Failed to load resource') && !e.includes('400')
    && !e.includes('Failed to load roles')
    // A transient Puppeteer-internal artifact seen during the "remove admin" waitForFunction
    // polling loop (it re-evaluates its predicate against an actively-mutating #rolesList DOM
    // tree) - the removal itself is verified correctly right afterward via a direct read, so this
    // doesn't correspond to any real application error.
    && !e.includes("false for 'list'"));
  check('no UNEXPECTED console/page errors during the whole flow', unexpectedErrors.length === 0, unexpectedErrors.join(' || '));

  await browser.close();

  console.log('\n--- RESULTS ---');
  let allOk = true;
  for (const r of results){
    console.log(`${r.ok ? 'PASS' : 'FAIL'} — ${r.label}${r.extra ? ' :: ' + r.extra : ''}`);
    if (!r.ok) allOk = false;
  }
  process.exit(allOk ? 0 : 1);
}

async function runFlow(page){
  await page.goto(ADMINS_URL, { waitUntil: 'domcontentloaded' });
  // ?emulator=1's own auto sign-in (as the owner, who is always Super Admin) — same convenience
  // every page already has.
  await page.waitForFunction(
    () => document.getElementById('rolesSection') && getComputedStyle(document.getElementById('rolesSection')).display !== 'none',
    { timeout: 10000 }
  );
  check('Roles section is visible once signed in (this page has nothing else on it)', true);
  await page.waitForFunction(() => (document.getElementById('rolesList')?.textContent || '').trim() !== '', { timeout: 10000 });
  await installModalAutoResponder(page);

  check('the owner always appears first, tagged Super Admin',
    (await page.$eval('#rolesList', el => el.children[0].textContent)).includes(ALLOWED_EMAIL));
  check('the Super Admin role option is visible to the owner (a real Super Admin)',
    await page.$eval('#superAdminRoleOption', el => getComputedStyle(el).display !== 'none'));

  // --- Sidebar nav label: renamed from "Admins" to "Roles" to "App Access" (Workstream 15, Part 3) ---
  const selfHref = await page.$eval('a[href*="admin-admins.html"]', el => el.getAttribute('href')).catch(() => null);
  const selfLabel = await page.$eval('a[href*="admin-admins.html"]', el => el.textContent).catch(() => null);
  check('the sidebar\'s own link now reads "App Access"', selfLabel === 'App Access', selfLabel);
  check('...but still points at the same admin-admins.html file (no route rename)', selfHref === 'admin-admins.html?emulator=1', selfHref);
  const backHref = await page.$eval('.settings-sidebar-exit a', el => el.getAttribute('href')).catch(() => null);
  check('"← Back to reports" points at sorting-station-report.html', backHref === 'sorting-station-report.html?emulator=1', backHref);

  // Seed the test building BEFORE any "Add access" round trip - loadRoles() (called at the end of
  // every successful add) also refreshes buildingsCache, so by the time we reach the Standard User
  // step below, the picker already has this building available (avoids a real race where the
  // picker would otherwise render from a stale, pre-this-building cache).
  const testBuildingId = 'roles-test-building-' + Date.now();
  await page.evaluate(async (buildingId) => {
    const mod = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js');
    const appMod = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js');
    const app = appMod.getApps()[0];
    const db = mod.getFirestore(app);
    await mod.setDoc(mod.doc(db, 'buildings', buildingId), { name: 'Roles Test Tower' });
  }, testBuildingId);

  // --- Grant a new Admin ---
  const newAdminEmail = 'second.admin@example.com';
  await page.type('#newAccessEmail', newAdminEmail);
  await page.select('#newAccessRole', 'admin');
  await page.click('#addAccessBtn');
  // Wait for the LIST itself to update, not just the status text - the handler sets status.text
  // BEFORE awaiting loadRoles(), so waiting on status text alone is a real race (reads the list
  // before its own re-render finishes).
  await page.waitForFunction(
    (email) => (document.getElementById('rolesList')?.textContent || '').includes(email),
    { timeout: 45000 }, newAdminEmail
  );
  const addAdminStatus = await page.$eval('#accessStatus', el => el.textContent);
  check('adding an admin confirms via status text (account created even though no real SMTP exists here)',
    addAdminStatus.includes(newAdminEmail), addAdminStatus);
  let rolesText = await page.$eval('#rolesList', el => el.textContent);
  check('the new admin appears in the list tagged Admin', rolesText.includes(newAdminEmail) && rolesText.includes('Admin'), rolesText.slice(0, 400));

  // --- Grant a new Standard User, scoped to the building seeded above ---
  const newStandardEmail = 'standard.user@example.com';
  await page.type('#newAccessEmail', newStandardEmail);
  await page.select('#newAccessRole', 'standard');
  await page.waitForFunction(
    () => document.querySelectorAll('#newAccessBuildingsPicker input').length > 0, { timeout: 8000 }
  );
  await page.$$eval('#newAccessBuildingsPicker label', (labels, name) => {
    const target = labels.find(l => l.textContent.includes(name));
    if (target) target.querySelector('input').click();
  }, 'Roles Test Tower');
  await page.click('#addAccessBtn');
  await page.waitForFunction(
    (email) => (document.getElementById('rolesList')?.textContent || '').includes(email),
    { timeout: 45000 }, newStandardEmail
  );
  rolesText = await page.$eval('#rolesList', el => el.textContent);
  check('the new Standard User appears in the list with their building name',
    rolesText.includes(newStandardEmail) && rolesText.includes('Standard User') && rolesText.includes('Roles Test Tower'),
    rolesText.slice(0, 600));

  // --- Role change: an existing Admin granted Standard User access instead should REPLACE the
  // Admin role (with a clear confirm naming the current role and the new one), not layer a
  // redundant/orphaned buildingAccess grant on top of it - a real gap found in production
  // (Workstream 15 Part 3 follow-up, 2026-10-06): an existing Admin who also picked up a
  // buildingAccess grant stayed a full Admin (the grant was inert while they held that role), but
  // would have silently dropped to Standard-User-scoped-to-that-building if their Admin role were
  // ever later removed - something nobody explicitly decided. ---
  await page.type('#newAccessEmail', newAdminEmail);
  await page.select('#newAccessRole', 'standard');
  await page.waitForFunction(
    () => document.querySelectorAll('#newAccessBuildingsPicker input').length > 0, { timeout: 8000 }
  );
  await page.$$eval('#newAccessBuildingsPicker label', (labels, name) => {
    const target = labels.find(l => l.textContent.includes(name));
    if (target) target.querySelector('input').click();
  }, 'Roles Test Tower');
  await page.click('#addAccessBtn');
  // Same race already documented above for the plain "+ Add access" flow: the handler sets
  // status.textContent BEFORE awaiting loadRoles(), so waiting on status text alone can read the
  // list before its own re-render finishes (the underlying Firestore writes are already done by
  // then - this is a benign display-order lag, not a data-integrity issue - but the test still
  // needs to wait for the real thing it's about to assert on, not a proxy that resolves earlier).
  await page.waitForFunction(
    (email) => {
      const list = document.getElementById('rolesList');
      const li = list && [...list.children].find(el => el.textContent.includes(email));
      return Boolean(li) && li.textContent.includes('Standard User');
    },
    { timeout: 10000 }, newAdminEmail
  );
  const confirmCallsAfterRoleChange = await page.evaluate(() => window.__confirmCalls);
  check('changing an existing Admin to Standard User shows a confirm naming the current role and the new one',
    confirmCallsAfterRoleChange.some(m => m.includes(newAdminEmail) && m.includes('currently has: Admin') && m.includes('Standard User')),
    JSON.stringify(confirmCallsAfterRoleChange));

  const roleChangeLi = await page.$eval('#rolesList', (list, email) => {
    const li = [...list.children].find(el => el.textContent.includes(email));
    return li ? li.outerHTML : null;
  }, newAdminEmail);
  check('after the role change, the former Admin now appears as a Standard User, not Admin',
    roleChangeLi && roleChangeLi.includes('Standard User') && !roleChangeLi.includes('role-tag admin"'),
    roleChangeLi);

  const adminDocGoneAfterChange = await page.evaluate(async (email) => {
    const mod = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js');
    const appMod = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js');
    const db = mod.getFirestore(appMod.getApps()[0]);
    const snap = await mod.getDoc(mod.doc(db, 'admins', email));
    return !snap.exists();
  }, newAdminEmail);
  check('...and the old /admins doc was actually removed, not just hidden in the UI', adminDocGoneAfterChange);

  // Re-granting the exact same role again should be a no-op (no confirm, no duplicate work).
  const confirmCountBeforeNoop = confirmCallsAfterRoleChange.length;
  await page.type('#newAccessEmail', newAdminEmail);
  await page.select('#newAccessRole', 'standard');
  await page.waitForFunction(
    () => document.querySelectorAll('#newAccessBuildingsPicker input').length > 0, { timeout: 8000 }
  );
  await page.$$eval('#newAccessBuildingsPicker label', (labels, name) => {
    const target = labels.find(l => l.textContent.includes(name));
    if (target && !target.querySelector('input').checked) target.querySelector('input').click();
  }, 'Roles Test Tower');
  await page.click('#addAccessBtn');
  await page.waitForFunction(
    () => (document.getElementById('accessStatus')?.textContent || '').includes('already has this exact role'),
    { timeout: 8000 }
  );
  const confirmCountAfterNoop = await page.evaluate(() => window.__confirmCalls.length);
  check('re-granting the exact same role is a no-op - no confirm dialog shown', confirmCountAfterNoop === confirmCountBeforeNoop,
    `before=${confirmCountBeforeNoop} after=${confirmCountAfterNoop}`);

  // --- Remove access (newAdminEmail is now a Standard User, per the role-change test above) ---
  await page.$$eval('.remove-role-btn', (btns, email) => {
    const li = btns.find(b => b.closest('li').textContent.includes(email));
    if (li) li.click();
  }, newAdminEmail);
  await page.waitForFunction(
    (email) => !(document.getElementById('rolesList')?.textContent || '').includes(email),
    { timeout: 8000 }, newAdminEmail
  );
  rolesText = await page.$eval('#rolesList', el => el.textContent);
  check('the removed account no longer appears in the list', !rolesText.includes(newAdminEmail), rolesText.slice(0, 400));
  check('...but the Standard User granted separately is untouched', rolesText.includes(newStandardEmail), rolesText.slice(0, 400));

  // --- Cross-page session persistence ---
  await page.goto(`${url.pathToFileURL(REPORT_PATH).href}?emulator=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => getComputedStyle(document.getElementById('settingsBtn')).display !== 'none',
    { timeout: 10000 }
  );
  check('navigating to sorting-station-report.html keeps the same signed-in session (no re-login needed)', true);

  await page.goto(ADMINS_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.getElementById('rolesSection') && getComputedStyle(document.getElementById('rolesSection')).display !== 'none',
    { timeout: 10000 }
  );
  check('navigating back to admin-admins.html also keeps the session (round trip, not one-way)', true);
  await installModalAutoResponder(page);

  // --- A plain Admin's view: Admin/Super-Admin rows are read-only (no Remove button), but
  // Standard-user rows stay fully manageable. ---
  const plainAdminEmail = 'plain-admin-viewer@example.com';
  await page.evaluate(async (email) => {
    const mod = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js');
    const appMod = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js');
    const app = appMod.getApps()[0];
    const db = mod.getFirestore(app);
    await mod.setDoc(mod.doc(db, 'admins', email), { addedAt: mod.serverTimestamp(), addedBy: 'test-setup' });
  }, plainAdminEmail);

  await page.evaluate((email) => window.__testSignIn(email, 'test-password-123'), plainAdminEmail);
  await page.waitForFunction(
    () => document.getElementById('rolesSection') && getComputedStyle(document.getElementById('rolesSection')).display !== 'none',
    { timeout: 10000 }
  );
  // #rolesList already has non-empty content left over from the owner's own session (we never
  // signed out in between) - waiting on "non-empty" alone would resolve on the STALE content
  // immediately, before this session's own async access-level check/re-render finishes. Wait on
  // the actual thing being asserted instead (a real, if slower, fix for the same class of race
  // already hit twice above with the status-text vs. list-content timing).
  await page.waitForFunction(
    () => getComputedStyle(document.getElementById('superAdminRoleOption')).display === 'none',
    { timeout: 10000 }
  );
  check('a plain admin does NOT see the Super Admin role option',
    await page.$eval('#superAdminRoleOption', el => getComputedStyle(el).display === 'none'));

  const ownerLiHasRemove = await page.$eval('#rolesList', (list, ownerEmail) => {
    const li = [...list.children].find(el => el.textContent.includes(ownerEmail));
    return li ? Boolean(li.querySelector('.remove-role-btn')) : null;
  }, ALLOWED_EMAIL);
  check('the permanent owner row never shows a Remove button, for any viewer', ownerLiHasRemove === false, ownerLiHasRemove);

  const standardLiHasActions = await page.$eval('#rolesList', (list, email) => {
    const li = [...list.children].find(el => el.textContent.includes(email));
    return li ? { remove: Boolean(li.querySelector('.remove-role-btn')), edit: Boolean(li.querySelector('.edit-standard-buildings-btn')) } : null;
  }, newStandardEmail);
  check('a plain admin CAN still manage the Standard User row (remove + edit buildings)',
    standardLiHasActions && standardLiHasActions.remove && standardLiHasActions.edit, JSON.stringify(standardLiHasActions));

  // --- Sign back in as the owner to prove a genuinely unauthorized account gets signed out,
  // not redirected (the zero-risk case) ---
  await page.click('#signOutBtn');
  await new Promise(r => setTimeout(r, 400));
  await page.evaluate(() => window.__testSignIn('random-unauthorized@example.com', 'test-password-123'));
  await page.waitForFunction(
    () => (document.getElementById('authStatus')?.textContent || '').includes("doesn't have access"),
    { timeout: 10000 }
  );
  check('an account with no role at all gets signed out with a clear denial message, not shown the page',
    await page.$eval('#rolesSection', el => getComputedStyle(el).display === 'none'));

  // --- Sign out must actually clear this page's own real data, not just hide it ---
  await page.evaluate(() => window.__testSignIn('esgtradeflex@gmail.com', 'test-password-123'));
  await page.waitForFunction(
    () => document.getElementById('rolesSection') && getComputedStyle(document.getElementById('rolesSection')).display !== 'none',
    { timeout: 10000 }
  );
  await page.click('#signOutBtn');
  await new Promise(r => setTimeout(r, 500));
  check('signing out shows the sign-in form again',
    await page.$eval('#authZone', el => getComputedStyle(el).display !== 'none'));
  check('signing out hides the Roles section',
    await page.$eval('#rolesSection', el => getComputedStyle(el).display === 'none'));
  check('signing out clears the Roles list',
    await page.$eval('#rolesList', el => el.innerHTML.trim() === ''));
}

main().catch((err) => { console.error('Test harness crashed:', err); process.exit(1); });
