// Signs in as the allowlisted reviewer (via the emulator-only test sign-in hook, not a real
// Google popup) and exercises sorting-station-report.html's one remaining area, Reports — plus
// sign-in/out and email/password auth. Master Edificios (building/tenant CRUD), Distribution
// (whole-building link/QR + tenant-scoped links), and Enrolled Buildings (Configure streams +
// the tenant-enable checklist) each moved to their own page (outputs/admin-buildings.html,
// outputs/admin-distribution.html, outputs/admin-enrolled-buildings.html — Workstream 2 Phases
// 2, 4, and 5 of the architecture roadmap, C:\Users\smolina\.claude\plans\graceful-roaming-shell.md)
// and have their own tests — this file only proves the Distribution/Enrolled Buildings tabs'
// cross-page handoff (that clicking either navigates to its own page, carrying the right
// induction).
// Run: npm run test:admin
const path = require('path');
const url = require('url');
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc } = require('firebase/firestore');

// Known limitation: hardcoded to Sergio's installed Edge path — single-machine internal tool, not solved with OS-detection.
// Override via TEST_BROWSER_PATH if this machine's security software blocks Edge automation
// (e.g. a corporate EDR flagging --remote-debugging-port on msedge.exe specifically).
const EDGE_PATH = process.env.TEST_BROWSER_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const REPORT_URL = `${url.pathToFileURL(path.join(__dirname, '..', 'outputs', 'sorting-station-report.html')).href}?emulator=1`;
const RULES_PATH = path.join(__dirname, '..', 'firestore.rules');
const ALLOWED_EMAIL = 'esgtradeflex@gmail.com';
const XSS_PAYLOAD = '<img src=x onerror="window.__xssFired = true">';

const results = [];
function check(label, cond, extra){ results.push({label, ok: Boolean(cond), extra: extra || ''}); }

// refreshProgramSelector() (called from onAuthStateChanged, fire-and-forget) is what actually
// populates #programSelector's <option>s — it hasn't necessarily finished by the time #settingsBtn
// itself becomes visible (that happens synchronously, earlier in the same handler). Selecting
// before the target <option> exists is a silent no-op in Puppeteer (no matching value -> nothing
// selected, no 'change' event with real data), so always wait for the specific option first.
async function selectProgram(page, programId){
  await page.waitForFunction(
    (id) => document.querySelector(`#programSelector option[value="${id}"]`) !== null,
    { timeout: 10000 },
    programId
  );
  await page.select('#programSelector', programId);
}

// Seeds one attempt (no matching submission -> shows in "Pending completion") and one
// submission (-> shows in "Completed") — an anonymous, unauthenticated trainee could write
// exactly either of these (name/tenantName are free text, only bounded/shape-checked by
// firestore.rules) — both with a "name" that's a real XSS payload, not just a suspicious
// string. Both should render as inert text, never execute.
// projectId MUST match the real esg-1-98f35 used in firebaseConfig — see game-regression.test.js.
async function seedMaliciousAttempt(){
  const testEnv = await initializeTestEnvironment({
    projectId: 'esg-1-98f35',
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'attempts', 'xss-test-attempt'), {
      buildingId: 'xss-test-building', buildingName: 'XSS Test Tower',
      tenantId: 'xss-test-tenant', tenantName: XSS_PAYLOAD,
      level: 'Level 1', name: XSS_PAYLOAD, email: 'xss-test@example.com',
      programId: 'recycling-sorting', startedAt: new Date().toISOString(),
    });
    await setDoc(doc(db, 'submissions', 'xss-test-submission'), {
      buildingId: 'xss-test-building-2', buildingName: XSS_PAYLOAD,
      tenantId: 'xss-test-tenant-2', tenantName: 'XSS Test Co',
      level: 'Level 1', name: XSS_PAYLOAD, email: 'xss-test-2@example.com',
      programId: 'recycling-sorting', score: 80, avoided: 20, total: 25,
      timestamp: new Date().toISOString(),
    });
    // A submission from a building where pc-box (default stream "pc") was reconfigured to
    // "mr" — the "most commonly missed items" list should label it Mixed Recycling here, not
    // its global-default Paper & Cardboard (the mislabeling bug fixed alongside Milestone 2's
    // item-streams editor). Marked as missed (0) so it's guaranteed a spot in the top-8 ranking.
    await setDoc(doc(db, 'submissions', 'override-config-submission'), {
      buildingId: 'override-config-building', buildingName: 'Override Config Tower',
      tenantId: 'override-config-tenant', tenantName: 'Override Co',
      level: 'Level 1', name: 'Pat Doe', email: 'pat@example.com',
      programId: 'recycling-sorting', score: 96, avoided: 24, total: 25,
      items: { 'pc-box': 0 },
      itemOverridesSnapshot: JSON.stringify({ 'pc-box': { stream: 'mr' } }),
      timestamp: new Date().toISOString(),
    });
  });
  return testEnv; // not cleaned up here — same reasoning as game-regression.test.js
}

// Building/tenant creation, Distribution's own UI, and Enrolled Buildings' own UI (Configure
// streams, the tenant-enable checklist, the enroll picker) all moved to their own pages and
// have their own tests (tests/admin-buildings-page.test.js, tests/admin-distribution-page.test.js,
// tests/admin-enrolled-buildings-page.test.js) — this file no longer needs a real building at
// all, just an induction selected, to prove Reports and the two tabs' cross-page handoffs.

async function main(){
  const seedEnv = await seedMaliciousAttempt();
  const browser = await puppeteer.launch({ executablePath: EDGE_PATH, headless: true });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));
  page.on('dialog', (d) => { consoleErrors.push('unexpected dialog: ' + d.message()); d.dismiss(); });

  try {
    await runFlow(page, seedEnv, consoleErrors);
  } catch (err) {
    console.error('CRASHED — dumping diagnostics:', err.message);
    await page.screenshot({ path: path.join(__dirname, '..', 'debug-crash.png') }).catch(() => {});
    await browser.close();
    process.exit(1);
  }

  await finishAndReport(page, browser, consoleErrors, seedEnv);
}

async function runFlow(page, seedEnv, consoleErrors){
  await page.goto(REPORT_URL, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 300));

  check('the Google sign-in button is present',
    Boolean(await page.$('#signInBtn')));
  check('an email/password sign-in option is present (no Microsoft button — dropped, unused)',
    Boolean(await page.$('#showEmailSignInBtn')) && !(await page.$('#signInMicrosoftBtn')));
  check('the email/password fields stay collapsed until asked for (clean initial screen — just two buttons)',
    await page.$eval('#emailSignInForm', el => getComputedStyle(el).display === 'none'));

  const signInResult = await page.evaluate(async (email) => {
    try { await window.__testSignIn(email, 'test-password-123'); return 'ok'; }
    catch (err) { return 'ERROR: ' + err.message; }
  }, ALLOWED_EMAIL);
  check('test sign-in hook resolved without throwing', signInResult === 'ok', signInResult);

  // The ⚙ settings button (and Sign out) now appear as soon as sign-in succeeds, independent
  // of any induction being selected — that's the new post-sign-in signal, since #programTabs
  // deliberately stays hidden until a real induction is picked (no default selection anymore).
  await page.waitForFunction(
    () => getComputedStyle(document.getElementById('settingsBtn')).display !== 'none',
    { timeout: 10000 }
  );
  const authStatusText = await page.$eval('#authStatus', el => el.textContent);
  check('the ⚙ settings button appears after signing in, before any induction is selected', true, authStatusText);

  // onAuthStateChanged fires refreshProgramSelector() as fire-and-forget async work — wait for
  // it to actually populate #programSelector's options before inspecting them.
  await page.waitForFunction(
    () => document.querySelector('#programSelector option[value="recycling-sorting"]') !== null,
    { timeout: 10000 }
  );
  check('the induction selector row appears, with its placeholder option selected and disabled',
    await page.$eval('#programSelectorRow', el => getComputedStyle(el).display !== 'none') &&
    await page.$eval('#programSelector', el => el.selectedIndex >= 0 && el.value === '' && Boolean(el.options[el.selectedIndex]) && el.options[el.selectedIndex].disabled));
  check('the program tabs (Reports/Enrolled Buildings/Distribution) stay hidden until an induction is actually chosen',
    await page.$eval('#programTabs', el => getComputedStyle(el).display === 'none'));

  await selectProgram(page, 'recycling-sorting');
  await page.waitForFunction(
    () => getComputedStyle(document.getElementById('programTabs')).display !== 'none',
    { timeout: 10000 }
  );
  // #programTabs is shown synchronously by the change handler, BEFORE it awaits loadLiveData() —
  // so its visibility alone doesn't mean the Reports data has actually finished loading yet.
  // Wait for the seeded "Pending completion" row to actually render before reading it below.
  await page.waitForFunction(
    () => document.querySelector('#pendingTable tr') !== null,
    { timeout: 10000 }
  );
  check('Reports tab is active by default once an induction is selected',
    await page.$eval('#tabReportsBtn', el => el.classList.contains('active')));
  check('the "Viewing: …" badge names the selected induction',
    (await page.$eval('#viewingBadge', el => el.textContent)) === 'Viewing: Recycling Sorting');

  // --- XSS check: a malicious trainee-submitted name must render as inert text, never run ---
  const xssFired = await page.evaluate(() => window.__xssFired === true);
  check('a malicious attempt/submission "name" does NOT execute as script anywhere in the report', !xssFired);

  const pendingText = await page.$eval('#pendingTable', el => el.textContent);
  const pendingEmptyVisible = await page.$eval('#pendingEmpty', el => getComputedStyle(el).display !== 'none');
  check('...and shows up as literal escaped text in Pending completion (proves it rendered, not silently dropped)',
    pendingText.includes('<img src=x'), `emptyVisible=${pendingEmptyVisible} text="${pendingText.slice(0, 300)}"`);
  const pendingHasRealImgTag = await page.$$eval('#pendingTable img', els => els.length > 0);
  check('...and no real <img> element was created from it in Pending completion', !pendingHasRealImgTag);

  const completedText = await page.$eval('#completedTable', el => el.textContent);
  check('...and shows up as literal escaped text in Completed too',
    completedText.includes('<img src=x'), completedText.slice(0, 300));
  const completedHasRealImgTag = await page.$$eval('#completedTable img', els => els.length > 0);
  check('...and no real <img> element was created from it in Completed', !completedHasRealImgTag);

  const missedListText = await page.$eval('#missedList', el => el.textContent).catch(() => '');
  check('the "most commonly missed items" list labels a reconfigured item by its actual building-specific stream, not the global default',
    missedListText.includes('Flattened cardboard box') && missedListText.includes('Mixed Recycling') && !missedListText.includes('Paper & Cardboard'),
    missedListText.slice(0, 400));

  // --- The Overview "Preview the training" button: no building/tenant to pick, opens the
  // trainer with preview=1 and no ?b= at all. ---
  await page.evaluate(() => { window.__openedUrls = []; window.open = (u) => { window.__openedUrls.push(u); return null; }; });
  await page.$eval('#previewTrainingBtn', el => el.click());
  let previewUrls = await page.evaluate(() => window.__openedUrls);
  check('the Overview "Preview the training" button opens the trainer with preview=1 and no building',
    previewUrls.length === 1 && previewUrls[0].includes('recycling-training.html?preview=1') && !previewUrls[0].includes('?b='),
    previewUrls.join(', '));

  // --- Distribution now lives on its own page (admin-distribution.html, Workstream 2 Phase 4
  // of the architecture roadmap) — reached via a real cross-page navigation that carries
  // whichever induction is currently selected as ?program=. Its own UI (whole-building
  // link/QR/copy/preview, tenant-scoped/expiring links, send-email) is covered end-to-end in
  // tests/admin-distribution-page.test.js; this file only proves the handoff itself. ---
  await Promise.all([page.waitForNavigation(), page.click('#tabDistributionBtn')]);
  check('the Distribution tab navigates to its own page, carrying the selected induction',
    page.url().includes('admin-distribution.html') && page.url().includes('program=recycling-sorting'),
    page.url());

  // Back to Reports to prove Enrolled Buildings' own handoff too — session persists (Firebase
  // Auth), but re-select the induction since navigating away loses the page's own JS state.
  await page.goto(REPORT_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => getComputedStyle(document.getElementById('settingsBtn')).display !== 'none',
    { timeout: 10000 }
  );
  await selectProgram(page, 'recycling-sorting');
  await page.waitForFunction(
    () => document.querySelector('#pendingTable tr') !== null,
    { timeout: 10000 }
  );

  // --- Enrolled Buildings now lives on its own page (admin-enrolled-buildings.html, Workstream
  // 2 Phase 5 of the architecture roadmap) — same real cross-page navigation as Distribution.
  // Its own UI (Configure streams, the tenant-enable checklist, the enrol picker) is covered
  // end-to-end in tests/admin-enrolled-buildings-page.test.js; this file only proves the
  // handoff itself. ---
  await Promise.all([page.waitForNavigation(), page.click('#tabEnrolledBuildingsBtn')]);
  check('the Enrolled Buildings tab navigates to its own page, carrying the selected induction',
    page.url().includes('admin-enrolled-buildings.html') && page.url().includes('program=recycling-sorting'),
    page.url());

  // Back to Reports to continue the sign-out/email-auth checks below.
  await page.goto(REPORT_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => getComputedStyle(document.getElementById('settingsBtn')).display !== 'none',
    { timeout: 10000 }
  );
  await selectProgram(page, 'recycling-sorting');
  await page.waitForFunction(
    () => document.querySelector('#pendingTable tr') !== null,
    { timeout: 10000 }
  );

  // Building rename/soft-delete (and confirming a deleted building's real link shows the
  // invalid-link fallback) are Buildings/Edificios' own concerns now — covered end-to-end in
  // tests/admin-buildings-page.test.js.
  // Admins management (grant/revoke a reviewer) now has its own page and its own test —
  // see tests/admin-admins.test.js. Nothing left to check for it on this page.

  // --- Sign out must actually clear real data from the screen, not just hide a tab ---
  await page.click('#signOutBtn');
  await new Promise(r => setTimeout(r, 500));
  const reportSectionVisible = await page.$eval('#reportSection', el => getComputedStyle(el).display !== 'none');
  check('signing out hides the Reports section entirely, not just the Buildings tab', !reportSectionVisible);
  const kpiRowEmptyAfterSignOut = await page.$eval('#kpiRow', el => el.innerHTML.trim() === '');
  check('signing out clears the KPI numbers, not just hides them', kpiRowEmptyAfterSignOut);
  const completedTableEmptyAfterSignOut = await page.$eval('#completedTable', el => el.innerHTML.trim() === '');
  check('signing out clears the Completed table\'s real names/emails', completedTableEmptyAfterSignOut);
  check('signing out hides the program tabs',
    await page.$eval('#programTabs', el => getComputedStyle(el).display === 'none'));
  check('signing out hides the induction selector row and clears its options',
    await page.$eval('#programSelectorRow', el => getComputedStyle(el).display === 'none') &&
    (await page.$eval('#programSelector', el => el.innerHTML.trim())) === '');
  check('signing out clears and hides the "Viewing: …" badge',
    await page.$eval('#viewingBadge', el => getComputedStyle(el).display === 'none' && el.textContent === ''));

  // --- Email/Password sign-in: Firebase's own auth, no external Google/Microsoft account needed ---
  const emailAdmin = 'email-login-admin@example.com';
  const emailAdminPassword = 'test-password-123';

  await page.evaluate(async (email) => { await window.__testSignIn(email, 'test-password-123'); }, ALLOWED_EMAIL);
  await page.waitForFunction(
    () => getComputedStyle(document.getElementById('settingsBtn')).display !== 'none',
    { timeout: 10000 }
  );
  await selectProgram(page, 'recycling-sorting');
  await page.waitForFunction(
    () => getComputedStyle(document.getElementById('programTabs')).display !== 'none',
    { timeout: 10000 }
  );
  // Granting this admin is now admin-admins.html's own job (see tests/admin-admins.test.js) —
  // here it's just a precondition for the real thing this block tests (email/password sign-in),
  // so seed it directly rather than driving a page that isn't this one.
  await seedEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'admins', emailAdmin), { addedAt: 'now', addedBy: ALLOWED_EMAIL });
  });

  // Stand-in for Sergio creating this person's login in Firebase Console.
  await page.evaluate(async (email, password) => { await window.__testSignIn(email, password); }, emailAdmin, emailAdminPassword);
  await new Promise(r => setTimeout(r, 800));
  await page.click('#signOutBtn');
  await new Promise(r => setTimeout(r, 500));

  // The real thing: sign in through the actual email/password form, not a test bypass.
  // The form starts collapsed (just a "Sign in with email" button) until clicked.
  await page.click('#showEmailSignInBtn');
  await new Promise(r => setTimeout(r, 200));
  check('the email/password form reveals after clicking its button (starts collapsed for a cleaner initial screen)',
    await page.$eval('#emailSignInForm', el => getComputedStyle(el).display !== 'none'));
  await page.type('#emailSignInEmail', emailAdmin);
  await page.type('#emailSignInPassword', emailAdminPassword);
  await page.click('#emailSignInForm button[type=submit]');
  const settingsBtnShownAfterEmailSignIn = await page.waitForFunction(
    () => getComputedStyle(document.getElementById('settingsBtn')).display !== 'none',
    { timeout: 10000 }
  ).then(() => true).catch(() => false);

  const authStatusAfterEmailSignIn = await page.$eval('#authStatus', el => el.textContent);
  check('signing in through the real email/password form works for a Firestore-granted admin',
    settingsBtnShownAfterEmailSignIn, authStatusAfterEmailSignIn);
  check('the email/password form collapses back after a successful sign-in (not left sitting on screen)',
    await page.$eval('#emailSignInForm', el => getComputedStyle(el).display === 'none'));
  check('the "Sign in with email" button also hides once signed in',
    await page.$eval('#showEmailSignInBtn', el => getComputedStyle(el).display === 'none'));

  // Close the loop: this newly-granted admin can also select an induction and reach its data,
  // proving the sign-in isn't just cosmetically successful.
  await selectProgram(page, 'recycling-sorting');
  const programTabsShownForNewAdmin = await page.waitForFunction(
    () => getComputedStyle(document.getElementById('programTabs')).display !== 'none',
    { timeout: 10000 }
  ).then(() => true).catch(() => false);
  check('the newly-granted admin can select an induction and reach the program tabs like any other admin',
    programTabsShownForNewAdmin);
}

async function finishAndReport(page, browser, consoleErrors, seedEnv){
  // Both are harmless side-effects of re-running this test against a still-warm emulator with
  // the same fixed test email each time: the SDK-level error, and the browser's own raw network
  // log line for the failed create-user request underneath it (can't be suppressed from app code).
  const unexpectedErrors = consoleErrors.filter(e =>
    !e.includes('auth/email-already-in-use') && !e.includes('Failed to load resource') && !e.includes('400')
    && !e.includes('Clipboard write failed') && !e.includes('Could not copy automatically')
    // Expected: this suite doesn't start the Functions emulator (only firestore,auth), so the
    // "Send via email" test's real fetch to sendInductionEmail is expected to fail — that's the
    // exact graceful-failure path being tested, not a real bug.
    && !e.includes('sendInductionEmail') && !e.includes('CORS policy'));
  check('no UNEXPECTED console/page errors during the whole flow', unexpectedErrors.length === 0, unexpectedErrors.join(' || '));

  await browser.close();
  if (seedEnv) await seedEnv.cleanup();

  console.log('\n--- RESULTS ---');
  let allOk = true;
  for (const r of results){
    console.log(`${r.ok ? 'PASS' : 'FAIL'} — ${r.label}${r.extra ? ' :: ' + r.extra : ''}`);
    if (!r.ok) allOk = false;
  }
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => { console.error('Test harness crashed:', err); process.exit(1); });
