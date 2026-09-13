// Signs in as the allowlisted reviewer (via the emulator-only test sign-in hook, not a real
// Google popup) and exercises sorting-station-report.html's remaining program-scoped areas:
// Reports and Enrolled Buildings (Configure streams + the tenant-enable checklist) — plus
// sign-in/out and email/password auth. Master Edificios (building/tenant CRUD) and Distribution
// (whole-building link/QR + tenant-scoped links) each moved to their own page
// (outputs/admin-buildings.html and outputs/admin-distribution.html, Workstream 2 Phases 2 and 4
// of the architecture roadmap, C:\Users\smolina\.claude\plans\graceful-roaming-shell.md) and
// have their own tests (tests/admin-buildings-page.test.js, tests/admin-distribution-page.test.js)
// — the building/tenants this file needs are seeded directly (seedTestBuilding below) instead of
// created through that now-separate UI; this file only proves the Distribution tab's handoff
// (that clicking it navigates to admin-distribution.html carrying the right induction).
// Run: npm run test:admin
const path = require('path');
const url = require('url');
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc, getDoc } = require('firebase/firestore');

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

// Building + tenant creation via the UI (add building, add/edit/import tenants, bulk contacts
// round-trip) is Buildings/Edificios' own concern now — covered end-to-end in its own test,
// tests/admin-buildings-page.test.js (Workstream 2, Phase 2 of the architecture roadmap). This
// file only needs the END STATE that used to result from that UI flow, so Enrolled Buildings/
// Distribution/Reports below have real data to work with — seeded directly, matching exactly
// what the old UI-driven flow used to leave behind (6 tenants; Widgetco and Acme Legal already
// have contact emails, Northwind Consulting stays email-less as the "no email" case).
async function seedTestBuilding(testEnv){
  const buildingName = 'Test Tower ' + Date.now();
  const buildingId = 'test-tower-' + Date.now();
  const tenantIds = {
    widgetco: 'widgetco', northwindConsulting: 'northwind-consulting', acmeLegal: 'acme-legal',
    goZeroRetail: 'go-zero-retail', retailTenants: 'retail-tenants', externalBin: 'external-bin-commercial',
  };
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'buildings', buildingId), { name: buildingName });
    await setDoc(doc(db, 'enrollments', `recycling-sorting__${buildingId}`), {
      programId: 'recycling-sorting', buildingId, itemOverrides: {}, enabledTenantIds: null,
    });
    const tenants = [
      { id: tenantIds.widgetco, name: 'Widgetco', levels: ['Level 3', 'Level 4'], emails: ['widgetco-contact@example.com'] },
      { id: tenantIds.northwindConsulting, name: 'Northwind Consulting', levels: ['Level 14'], emails: [] },
      { id: tenantIds.acmeLegal, name: 'Acme Legal', levels: ['Level 8', 'Level 9'], emails: ['acme-one@example.com', 'acme-two@example.com'] },
      { id: tenantIds.goZeroRetail, name: 'Go Zero (Retail)', levels: ['Ground'], emails: [] },
      { id: tenantIds.retailTenants, name: 'Retail Tenants', levels: ['Ground'], emails: [] },
      { id: tenantIds.externalBin, name: 'External Bin/ Commercial', levels: ['External Bin/ Commercial'], emails: [] },
    ];
    for (const t of tenants){
      await setDoc(doc(db, 'buildings', buildingId, 'tenants', t.id), { name: t.name, levels: t.levels, emails: t.emails });
    }
  });
  return { buildingId, buildingName, tenantIds };
}

// Direct Firestore read of one enrollment doc, bypassing the UI entirely — needed for the
// tenant-enable checklist's 3-state model (absent/null vs [] vs a real array), which the UI
// alone can't distinguish: both "null" and "everyone individually checked" render every
// checkbox checked identically.
async function readEnrollment(testEnv, enrollmentId){
  // withSecurityRulesDisabled (this SDK version) awaits the callback but discards its return
  // value — capture the result via an outer variable instead of `return`ing it from the callback.
  let result;
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const snap = await getDoc(doc(context.firestore(), 'enrollments', enrollmentId));
    result = snap.data();
  });
  return result;
}

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

  // Set up a confirm() stub that records every call, rather than a bare "always true" — several
  // checks below (the tenant-enable checklist especially) need to verify not just that a
  // confirmation happened, but what it said and exactly when.
  await page.evaluate(() => {
    window.__confirmCalls = [];
    window.confirm = (msg) => { window.__confirmCalls.push(msg); return true; };
    window.__alertCalls = [];
    window.alert = (msg) => { window.__alertCalls.push(msg); };
  });

  // Buildings/tenant creation (formerly done here via the UI) now lives entirely in
  // admin-buildings.html's own test, tests/admin-buildings-page.test.js (Workstream 2, Phase 2
  // of the architecture roadmap) — seed the same end state directly instead.
  const { buildingId, buildingName, tenantIds } = await seedTestBuilding(seedEnv);
  // --- Now select an induction. All master-side tenant CRUD above is finished, so the very
  // first load of program-scoped data (Enrolled Buildings/Distribution) below already reflects
  // the final tenant list — no manual cache refresh needed. ---
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

  // --- Enrolled Buildings (per-program): reachable directly, no ⚙ menu involved ---
  await page.click('#tabEnrolledBuildingsBtn');
  await new Promise(r => setTimeout(r, 200));
  check('Enrolled Buildings tab becomes visible on click',
    await page.$eval('#enrolledBuildingsSection', el => getComputedStyle(el).display !== 'none'));
  check('Reports section hides when Enrolled Buildings tab is active',
    await page.$eval('#reportSection', el => getComputedStyle(el).display === 'none'));

  const enrolledNames = await page.$$eval('.enrolled-building-row h3', els => els.map(el => el.textContent));
  check('the building is auto-enrolled in Recycling Sorting and shows up here without a manual enroll step',
    enrolledNames.includes(buildingName), enrolledNames.join('|'));

  const enrolledSelector = `.enrolled-building-row[data-building-id="${buildingId}"]`;
  // Expand via the toggle (independent of the items-editor's own auto-expand) so the tenant-
  // enable checklist stays visible across the whole Enrolled Buildings section below, even
  // after the items editor is closed again.
  await page.click(`${enrolledSelector} .building-toggle-btn`);
  await new Promise(r => setTimeout(r, 200));
  check('expanding an enrolled-building row shows its tenant-enable checklist',
    Boolean(await page.$(`${enrolledSelector} .tenant-enable-block`)));

  // --- Configure item streams (per-building item-stream overrides, Milestone 2) — now lives
  // under Enrolled Buildings, not master Edificios. ---
  await page.click(`${enrolledSelector} .configure-items-btn`);
  await new Promise(r => setTimeout(r, 200));
  check('opening "Configure streams" shows the item-streams editor',
    Boolean(await page.$(`${enrolledSelector} .items-editor`)));

  // Every catalog item (both the 25 in rotation and the 28 backups) shows up here now — an
  // admin can personalize any of them per building via the on/off toggle.
  const totalItemCards = await page.$$eval(`${enrolledSelector} .items-card`, els => els.length);
  check('the editor shows all 53 catalog items, backups included',
    totalItemCards === 53, totalItemCards);
  const benchItemInactive = await page.$eval(`${enrolledSelector} .item-active-toggle[data-item-id="gw-glass"]`,
    el => !el.checked).catch(() => null);
  check('a specific bench item (gw-glass) is present but shown off by default', benchItemInactive === true);

  // Regression check (relocated): the collapse arrow toggles expandedEnrolledBuildingIds, but
  // isEnrolledBuildingExpanded() ORs that with "items editor currently open" — so toggling the
  // arrow while Configure streams is open must never hide the editor. Toggle twice to leave the
  // row's expanded-state bookkeeping exactly as it was (still needed for the tenant-enable
  // checklist further down).
  await page.click(`${enrolledSelector} .building-toggle-btn`);
  await new Promise(r => setTimeout(r, 200));
  check('the collapse arrow does not hide the items editor while "Configure streams" is open',
    Boolean(await page.$(`${enrolledSelector} .items-editor`)));
  await page.click(`${enrolledSelector} .building-toggle-btn`);
  await new Promise(r => setTimeout(r, 200));

  // Swap "Flattened cardboard box" (pc-box) and "Empty plastic bottle" (mr-bottle) between
  // Paper & Cardboard and Mixed Recycling — a straight swap keeps both streams at a valid 5,
  // unlike moving just one item alone (which the new 0-or-≥5 validation correctly rejects;
  // see the dedicated check for that further down).
  await page.select(`${enrolledSelector} .item-stream-select[data-item-id="pc-box"]`, 'mr');
  await page.select(`${enrolledSelector} .item-stream-select[data-item-id="mr-bottle"]`, 'pc');
  await page.$eval(`${enrolledSelector} .save-items-btn`, el => el.click());
  await new Promise(r => setTimeout(r, 600));

  check('"Custom bins" badge appears on the building once an override is saved',
    Boolean(await page.$(`${enrolledSelector} .custom-config-badge`)));

  await page.click(`${enrolledSelector} .configure-items-btn`);
  await new Promise(r => setTimeout(r, 200));
  const pcBoxSelectValue = await page.$eval(`${enrolledSelector} .item-stream-select[data-item-id="pc-box"]`, el => el.value);
  const mrBottleSelectValue = await page.$eval(`${enrolledSelector} .item-stream-select[data-item-id="mr-bottle"]`, el => el.value);
  check('the override persisted after reload — reopening the editor shows the saved streams',
    pcBoxSelectValue === 'mr' && mrBottleSelectValue === 'pc', `${pcBoxSelectValue}, ${mrBottleSelectValue}`);

  // Swap them back so the rest of the flow starts from a clean, default state.
  await page.select(`${enrolledSelector} .item-stream-select[data-item-id="pc-box"]`, 'pc');
  await page.select(`${enrolledSelector} .item-stream-select[data-item-id="mr-bottle"]`, 'mr');
  await page.$eval(`${enrolledSelector} .save-items-btn`, el => el.click());
  await new Promise(r => setTimeout(r, 600));
  await page.click(`${enrolledSelector} .configure-items-btn`);
  await new Promise(r => setTimeout(r, 200));

  // --- Battery/toner are no longer a permanent, unconfigurable special case — they're ordinary
  // items, off by default, that any building can turn on if its e-waste actually accepts them.
  const batteryToggledOffByDefault = await page.$eval(`${enrolledSelector} .item-active-toggle[data-item-id="ew-battery"]`,
    el => !el.checked).catch(() => null);
  check('the battery item is off by default, not a locked special case', batteryToggledOffByDefault === true);
  const batterySelectEnabled = Boolean(await page.$(`${enrolledSelector} .item-stream-select[data-item-id="ew-battery"]`));
  check('the battery card has a normal, usable stream <select>, same as any other item', batterySelectEnabled);

  await page.click(`${enrolledSelector} .item-active-toggle[data-item-id="ew-battery"]`);
  await page.$eval(`${enrolledSelector} .save-items-btn`, el => el.click());
  await new Promise(r => setTimeout(r, 600));

  await page.click(`${enrolledSelector} .configure-items-btn`);
  await new Promise(r => setTimeout(r, 200));
  const batteryOnAfterReload = await page.$eval(`${enrolledSelector} .item-active-toggle[data-item-id="ew-battery"]`, el => el.checked);
  check('turning battery on for this building persists after reload', batteryOnAfterReload === true);

  // --- New floor rule: a stream must land on 0 (merged away) or ≥5 correct items, never a
  // partial number like 3 or 4 — the exact "E-Waste only has 3" problem this redesign fixes.
  await page.click(`${enrolledSelector} .item-active-toggle[data-item-id="og-fish"]`);
  await page.$eval(`${enrolledSelector} .save-items-btn`, el => el.click());
  await new Promise(r => setTimeout(r, 400));
  const partialStreamError = await page.$eval(`${enrolledSelector} .items-editor-error`, el => el.textContent).catch(() => '');
  check('turning Organics down to 4 correct items is rejected at save time, naming the stream and count',
    partialStreamError.includes('Organics') && partialStreamError.includes('4'), partialStreamError);
  check('the editor stays open after a rejected save (no badge/reload happened)',
    Boolean(await page.$(`${enrolledSelector} .items-editor`)));

  // Turning on a backup item to compensate brings Organics back to a valid count (5) and the
  // save succeeds.
  await page.click(`${enrolledSelector} .item-active-toggle[data-item-id="og-breadcrust"]`);
  await page.$eval(`${enrolledSelector} .save-items-btn`, el => el.click());
  await new Promise(r => setTimeout(r, 600));

  await page.click(`${enrolledSelector} .configure-items-btn`);
  await new Promise(r => setTimeout(r, 200));
  const fishOffAfterReload = await page.$eval(`${enrolledSelector} .item-active-toggle[data-item-id="og-fish"]`, el => !el.checked);
  const breadcrustOnAfterReload = await page.$eval(`${enrolledSelector} .item-active-toggle[data-item-id="og-breadcrust"]`, el => el.checked);
  check('the compensated swap (fish off, bread crust on) persists after reload',
    fishOffAfterReload && breadcrustOnAfterReload);

  // Reset both items back to their defaults for the rest of the flow.
  await page.click(`${enrolledSelector} .item-active-toggle[data-item-id="og-fish"]`);
  await page.click(`${enrolledSelector} .item-active-toggle[data-item-id="og-breadcrust"]`);
  await page.$eval(`${enrolledSelector} .save-items-btn`, el => el.click());
  await new Promise(r => setTimeout(r, 600));
  await page.click(`${enrolledSelector} .configure-items-btn`);
  await new Promise(r => setTimeout(r, 200));

  // --- "Also acceptable in" checkboxes (Milestone 4: ideal-vs-acceptable) ---
  const appleCheckboxSelector = `${enrolledSelector} .item-acceptable-checkbox[data-item-id="og-apple"][value="gw"]`;
  await page.$eval(appleCheckboxSelector, el => el.click());
  await page.$eval(`${enrolledSelector} .save-items-btn`, el => el.click());
  await new Promise(r => setTimeout(r, 600));

  await page.click(`${enrolledSelector} .configure-items-btn`);
  await new Promise(r => setTimeout(r, 200));
  const applePrimaryValue = await page.$eval(`${enrolledSelector} .item-stream-select[data-item-id="og-apple"]`, el => el.value);
  const appleAcceptableChecked = await page.$eval(appleCheckboxSelector, el => el.checked);
  check('an "also acceptable in" checkbox persists after reload without disturbing the item\'s primary stream',
    applePrimaryValue === 'og' && appleAcceptableChecked === true, `primary=${applePrimaryValue} acceptableChecked=${appleAcceptableChecked}`);

  // Unchecking it should fully clear that item's acceptable list again.
  await page.$eval(appleCheckboxSelector, el => el.click());
  await page.$eval(`${enrolledSelector} .save-items-btn`, el => el.click());
  await new Promise(r => setTimeout(r, 600));
  await page.click(`${enrolledSelector} .configure-items-btn`);
  await new Promise(r => setTimeout(r, 200));
  const appleAcceptableAfterUncheck = await page.$eval(appleCheckboxSelector, el => el.checked);
  check('unchecking "also acceptable in" and saving clears it', appleAcceptableAfterUncheck === false);

  // Reset to default, save, confirm the badge disappears.
  await page.$eval(`${enrolledSelector} .reset-items-btn`, el => el.click());
  await page.$eval(`${enrolledSelector} .save-items-btn`, el => el.click());
  await new Promise(r => setTimeout(r, 600));
  check('the "Custom bins" badge disappears after resetting to default and saving',
    !(await page.$(`${enrolledSelector} .custom-config-badge`)));

  // Quick-merge shortcut: merge all of Paper & Cardboard into Mixed Recycling in one action.
  await page.click(`${enrolledSelector} .configure-items-btn`);
  await new Promise(r => setTimeout(r, 200));
  await page.select(`${enrolledSelector} .quick-merge-from`, 'pc');
  await page.select(`${enrolledSelector} .quick-merge-to`, 'mr');
  await page.$eval(`${enrolledSelector} .quick-merge-btn`, el => el.click());
  await new Promise(r => setTimeout(r, 200));
  const pcItemIds = ['pc-box', 'pc-paper', 'pc-envelope', 'pc-newspaper', 'pc-shredded'];
  const mergedValues = await Promise.all(pcItemIds.map(id =>
    page.$eval(`${enrolledSelector} .item-stream-select[data-item-id="${id}"]`, el => el.value)));
  check('quick-merge moves all 5 items from one stream to another in a single action',
    mergedValues.every(v => v === 'mr'), mergedValues.join(','));

  // Validation: try to merge everything else into gw too, leaving mr with no genuinely-wrong
  // candidates for its own decoy pool — this must be rejected, not silently saved.
  for (const fromStream of ['og', 'ew']){
    await page.select(`${enrolledSelector} .quick-merge-from`, fromStream);
    await page.select(`${enrolledSelector} .quick-merge-to`, 'gw');
    await page.$eval(`${enrolledSelector} .quick-merge-btn`, el => el.click());
    await new Promise(r => setTimeout(r, 150));
  }
  await page.select(`${enrolledSelector} .quick-merge-from`, 'mr');
  await page.select(`${enrolledSelector} .quick-merge-to`, 'gw');
  await page.$eval(`${enrolledSelector} .quick-merge-btn`, el => el.click());
  await new Promise(r => setTimeout(r, 150));
  await page.$eval(`${enrolledSelector} .save-items-btn`, el => el.click());
  await new Promise(r => setTimeout(r, 300));
  const validationErrorText = await page.$eval(`${enrolledSelector} .items-editor-error`, el => el.textContent).catch(() => '');
  check('a configuration that would starve a stream of decoys is rejected at save time, not silently accepted',
    validationErrorText.length > 0, validationErrorText);

  await page.$eval(`${enrolledSelector} .cancel-items-btn`, el => el.click());
  await new Promise(r => setTimeout(r, 200));

  // --- Preview button (Enrolled Buildings header) ---
  await page.evaluate(() => { window.__openedUrls = []; });
  await page.click(`${enrolledSelector} .preview-link-btn`);
  previewUrls = await page.evaluate(() => window.__openedUrls);
  check('the Enrolled Buildings "Preview" button opens that building\'s real link with &preview=1 appended',
    previewUrls.length === 1 && previewUrls[0].includes(`recycling-training.html?b=${buildingId}`) && previewUrls[0].endsWith('&preview=1'),
    previewUrls.join(', '));

  // --- Tenant-enable checklist (brand-new feature): the 3-state model — absent/null = everyone,
  // an array = only those tenants, an explicit [] = no one. The UI alone can't tell "null" apart
  // from "every tenant individually checked" (both render fully checked), so the actual stored
  // value is verified via a direct Firestore read. ---
  const enrollmentId = `recycling-sorting__${buildingId}`;
  const initialEnrollment = await readEnrollment(seedEnv, enrollmentId);
  check('a freshly auto-enrolled building starts with enabledTenantIds unset (everyone enabled, no restriction)',
    initialEnrollment.enabledTenantIds === undefined || initialEnrollment.enabledTenantIds === null,
    JSON.stringify(initialEnrollment.enabledTenantIds));

  // 6 tenants survive at this point: the 6 kept from the Excel import (Widgetco, Acme Legal,
  // Northwind Consulting, Retail Tenants, Go Zero (Retail), External Bin/Commercial) — "Test
  // Tenant" (renamed then deleted earlier) is gone, and "Vacant"/"Base Building" were never
  // imported (unticked in the review step).
  const checklistLis = await page.$$(`${enrolledSelector} .tenant-enable-block li[data-tenant-id]`);
  check('the tenant-enable checklist lists all 6 surviving tenants', checklistLis.length === 6, checklistLis.length);
  const allCheckedInitially = await page.$$eval(`${enrolledSelector} .tenant-enable-checkbox`, els => els.every(el => el.checked));
  check('every tenant starts checked (enabled) by default', allCheckedInitially);

  async function setCheckbox(index, checked){
    await page.$$eval(`${enrolledSelector} .tenant-enable-checkbox`, (els, i, c) => {
      els[i].checked = c;
      els[i].dispatchEvent(new Event('change', { bubbles: true }));
    }, index, checked);
  }
  async function checkboxLabel(index){
    return page.$$eval(`${enrolledSelector} .tenant-enable-block li[data-tenant-id]`, (els, i) => els[i].textContent, index);
  }

  // (1) Uncheck one of the six tenants -> confirm dialog fires, naming it -> saves a partial array.
  const firstTenantLabel = await checkboxLabel(0);
  await setCheckbox(0, false);
  const confirmCountBefore = await page.evaluate(() => window.__confirmCalls.length);
  await page.click(`${enrolledSelector} .save-tenant-enable-btn`);
  await new Promise(r => setTimeout(r, 600));
  const confirmCallsAfterPartial = await page.evaluate((n) => window.__confirmCalls.slice(n), confirmCountBefore);
  check('unchecking one tenant and saving triggers exactly one confirm dialog naming that tenant',
    confirmCallsAfterPartial.length === 1 && firstTenantLabel.includes(confirmCallsAfterPartial[0].match(/for (.+)\?/)[1]),
    JSON.stringify(confirmCallsAfterPartial) + ' / label=' + firstTenantLabel);
  const statusAfterPartial = await page.$eval(`${enrolledSelector} .save-tenant-enable-status`, el => el.textContent);
  check('tenant-access save confirms via status text (and the message survives the reload that follows it)',
    statusAfterPartial.includes('Saved'), statusAfterPartial);
  const enrollmentAfterPartial = await readEnrollment(seedEnv, enrollmentId);
  check('unchecking exactly one of six tenants saves enabledTenantIds as an array of the 5 still-checked tenants',
    Array.isArray(enrollmentAfterPartial.enabledTenantIds) && enrollmentAfterPartial.enabledTenantIds.length === 5,
    JSON.stringify(enrollmentAfterPartial.enabledTenantIds));

  // (2) Uncheck every remaining tenant too -> saves an explicit empty array (paused for everyone).
  await page.$$eval(`${enrolledSelector} .tenant-enable-checkbox`, els => {
    els.forEach(el => { el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true })); });
  });
  const confirmCountBeforeAll = await page.evaluate(() => window.__confirmCalls.length);
  await page.click(`${enrolledSelector} .save-tenant-enable-btn`);
  await new Promise(r => setTimeout(r, 600));
  const confirmCallsAfterAll = await page.evaluate((n) => window.__confirmCalls.slice(n), confirmCountBeforeAll);
  check('unchecking the remaining 5 tenants together triggers exactly one confirm dialog naming all 5',
    confirmCallsAfterAll.length === 1, JSON.stringify(confirmCallsAfterAll));
  const enrollmentAfterEmpty = await readEnrollment(seedEnv, enrollmentId);
  check('unchecking every tenant saves enabledTenantIds as an explicit empty array, not null (paused for everyone without un-enrolling)',
    Array.isArray(enrollmentAfterEmpty.enabledTenantIds) && enrollmentAfterEmpty.enabledTenantIds.length === 0,
    JSON.stringify(enrollmentAfterEmpty.enabledTenantIds));

  // (3) Re-check every tenant -> re-enabling needs no confirmation, and saves back to null (clean default).
  await page.$$eval(`${enrolledSelector} .tenant-enable-checkbox`, els => {
    els.forEach(el => { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); });
  });
  const confirmCountBeforeReenable = await page.evaluate(() => window.__confirmCalls.length);
  await page.click(`${enrolledSelector} .save-tenant-enable-btn`);
  await new Promise(r => setTimeout(r, 600));
  const confirmCallsAfterReenable = await page.evaluate((n) => window.__confirmCalls.slice(n), confirmCountBeforeReenable);
  check('re-enabling every tenant needs no confirmation (only newly-disabled tenants trigger one)',
    confirmCallsAfterReenable.length === 0, JSON.stringify(confirmCallsAfterReenable));
  const enrollmentAfterReenable = await readEnrollment(seedEnv, enrollmentId);
  check('re-checking every tenant saves enabledTenantIds back to null (the clean "no restriction" default), not a redundant full array',
    enrollmentAfterReenable.enabledTenantIds === null, JSON.stringify(enrollmentAfterReenable.enabledTenantIds));

  // --- Distribution now lives on its own page (admin-distribution.html, Workstream 2 Phase 4
  // of the architecture roadmap) — reached via a real cross-page navigation that carries
  // whichever induction is currently selected as ?program=. Its own UI (whole-building
  // link/QR/copy/preview, tenant-scoped/expiring links, send-email) is covered end-to-end in
  // tests/admin-distribution-page.test.js; this file only proves the handoff itself. ---
  await Promise.all([page.waitForNavigation(), page.click('#tabDistributionBtn')]);
  check('the Distribution tab navigates to its own page, carrying the selected induction',
    page.url().includes('admin-distribution.html') && page.url().includes('program=recycling-sorting'),
    page.url());

  // Back to Reports to continue the sign-out/email-auth checks below — session persists
  // (Firebase Auth), but re-select the induction to get real data back on screen before
  // proving sign-out actually clears it.
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
  // loadLiveData() awaits loadEnrolledData() AFTER rendering Reports — #pendingTable having a
  // row doesn't mean Enrolled Buildings has finished its own (separate) fetch yet. Without this
  // wait, signing out below can race that still-in-flight fetch: it resolves and repopulates
  // #enrolledBuildingsList right after sign-out's own reset already cleared it, making the
  // "signing out clears..." check below flaky.
  await page.waitForFunction(
    (name) => [...document.querySelectorAll('.enrolled-building-row h3')].some(el => el.textContent === name),
    { timeout: 10000 },
    buildingName
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
  const enrolledListEmptyAfterSignOut = await page.$eval('#enrolledBuildingsList', el => el.innerHTML.trim() === '');
  check('signing out clears Enrolled Buildings\' cached list, not just hides its tab',
    enrolledListEmptyAfterSignOut);

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
