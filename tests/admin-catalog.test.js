// Verifies per-program scoping in outputs/sorting-station-report.html — Enrolled Buildings
// filters strictly by whichever induction is selected in the top program selector (part of the
// multi-program plan, see C:\Users\smolina\.claude\plans\serene-dreaming-puppy.md), and the
// Distribution tab's cross-page handoff (Workstream 2 Phase 4) carries a non-default induction
// correctly too. Registering/archiving inductions moved to its own page
// (outputs/admin-catalog.html, Workstream 2 Phase 3 of the architecture roadmap, see
// C:\Users\smolina\.claude\plans\graceful-roaming-shell.md) and is covered end-to-end in
// tests/admin-catalog-page.test.js; Distribution's own UI moved to admin-distribution.html and
// is covered end-to-end in tests/admin-distribution-page.test.js — this file seeds a program
// directly via Firestore instead of driving either separate page's UI. Run: npm run test:catalog-admin
const path = require('path');
const url = require('url');
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc } = require('firebase/firestore');

// Override via TEST_BROWSER_PATH if this machine's security software blocks Edge automation
// (e.g. a corporate EDR flagging --remote-debugging-port on msedge.exe specifically).
const EDGE_PATH = process.env.TEST_BROWSER_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const REPORT_URL = `${url.pathToFileURL(path.join(__dirname, '..', 'outputs', 'sorting-station-report.html')).href}?emulator=1`;
const RULES_PATH = path.join(__dirname, '..', 'firestore.rules');
const ALLOWED_EMAIL = 'esgtradeflex@gmail.com';

// Building creation (add/edit/delete) is Buildings/Edificios' own page now
// (outputs/admin-buildings.html, Workstream 2 Phase 2 of the architecture roadmap) — this file
// only needs a real building to test per-program enrollment scoping against, seeded directly.
// Registering an induction is admin-catalog.html's own page now (Workstream 2 Phase 3) — seed
// that directly too, rather than driving a UI that no longer lives on this page.
async function seedTestBuildingAndProgram(){
  const testEnv = await initializeTestEnvironment({
    projectId: 'esg-1-98f35',
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  const buildingName = 'Test Tower Enroll ' + Date.now();
  const buildingId = 'test-tower-enroll-' + Date.now();
  const programName = 'Organics Focus ' + Date.now();
  const programId = 'organics-focus-' + Date.now();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'buildings', buildingId), { name: buildingName });
    await setDoc(doc(db, 'enrollments', `recycling-sorting__${buildingId}`), {
      programId: 'recycling-sorting', buildingId, itemOverrides: {}, enabledTenantIds: null,
    });
    await setDoc(doc(db, 'programs', programId), {
      name: programName, description: 'A focused induction on organics sorting.',
      file: 'organics-training.html', kind: 'game', status: 'active',
    });
  });
  return { testEnv, buildingId, buildingName, programId, programName };
}

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
    !e.includes('auth/email-already-in-use') && !e.includes('Failed to load resource') && !e.includes('400'));
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
  // --- A building and a second program, seeded directly (their own pages' UIs are covered by
  // tests/admin-buildings-page.test.js and tests/admin-catalog-page.test.js respectively). ---
  const { buildingId, buildingName, programId, programName } = await seedTestBuildingAndProgram();
  check('the seeded building and program exist', Boolean(buildingId) && Boolean(programId), `${buildingId} / ${programId}`);

  await page.goto(REPORT_URL, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 300));

  const signInResult = await page.evaluate(async (email) => {
    try { await window.__testSignIn(email, 'test-password-123'); return 'ok'; }
    catch (err) { return 'ERROR: ' + err.message; }
  }, ALLOWED_EMAIL);
  check('test sign-in hook resolved without throwing', signInResult === 'ok', signInResult);

  // #programTabs (Reports/Enrolled Buildings/Distribution) deliberately stays hidden until a
  // real induction is picked.
  await page.waitForFunction(
    () => getComputedStyle(document.getElementById('settingsBtn')).display !== 'none',
    { timeout: 10000 }
  );
  check('the ⚙ settings button is reachable right after sign-in, with no induction selected yet',
    await page.$eval('#programTabs', el => getComputedStyle(el).display === 'none'));

  // window.confirm's native dialog would otherwise fight the generic "unexpected dialog"
  // handler at the top of this file — stubbed once, up front, since several actions below
  // (revoking a link, removing an enrollment) trigger it.
  await page.evaluate(() => { window.confirm = () => true; });

  // --- Building enrollment is scoped per selected program (multi-program plan). Select
  // Recycling Sorting first — the building was auto-enrolled there at seed time. ---
  await selectProgram(page, 'recycling-sorting');
  await page.waitForFunction(
    () => getComputedStyle(document.getElementById('programTabs')).display !== 'none',
    { timeout: 10000 }
  );
  // #programTabs is shown synchronously by the change handler, BEFORE it awaits loadLiveData()
  // (which is what actually fetches/renders Enrolled Buildings) — wait for the building we just
  // seeded (auto-enrolled in Recycling Sorting) to actually show up before reading the list.
  await page.waitForFunction(
    (name) => [...document.querySelectorAll('.enrolled-building-row h3')].some(el => el.textContent === name),
    { timeout: 10000 },
    buildingName
  );
  await page.click('#tabEnrolledBuildingsBtn');
  await new Promise(r => setTimeout(r, 300));
  let enrolledNames = await page.$$eval('.enrolled-building-row h3', els => els.map(el => el.textContent));
  check('the new building appears under Enrolled Buildings while Recycling Sorting is selected (auto-enrolled there)',
    enrolledNames.includes(buildingName), enrolledNames.join('|'));

  // Switch the top selector to the Organics program seeded directly above.
  await selectProgram(page, programId);
  // Same race as above: #programTabs/viewingBadge update synchronously, before loadEnrolledData()
  // (async) actually refetches. Organics Focus starts with zero enrolled buildings, so wait for
  // its real empty-state message rather than reading a still-stale (Recycling Sorting) render.
  await page.waitForFunction(
    () => (document.getElementById('enrolledBuildingsList').textContent || '').includes('No buildings enrolled in this induction yet'),
    { timeout: 10000 }
  ).catch(() => {});
  check('the "Viewing: …" badge updates to the newly selected induction',
    (await page.$eval('#viewingBadge', el => el.textContent)) === `Viewing: ${programName}`);

  // Switching the induction always resets the active tab to Reports (programSelector's own
  // change handler calls showTab('reports')) — re-open Enrolled Buildings, otherwise the
  // section below is display:none and page.click() on anything inside it throws "Node is
  // either not clickable or not an Element" rather than the "no element found" it'd throw
  // for a genuinely missing one.
  await page.click('#tabEnrolledBuildingsBtn');
  await new Promise(r => setTimeout(r, 200));

  enrolledNames = await page.$$eval('.enrolled-building-row h3', els => els.map(el => el.textContent));
  check('that same building does NOT appear under Organics Focus — it was never enrolled there',
    !enrolledNames.includes(buildingName), enrolledNames.join('|') || '(none)');
  check('"Configure streams" is not offered for a non-Recycling program (no per-building content to configure)',
    !(await page.$('.configure-items-btn')));
  check('the "Custom bins" badge is also never shown for a non-Recycling program',
    !(await page.$('.custom-config-badge')));

  const enrollValue = await page.$$eval('#enrollBuildingSelect option', (opts, name) =>
    (opts.find(o => o.textContent === name) || {}).value, buildingName);
  check('the not-yet-enrolled building is offered in the "enroll existing building" picker', Boolean(enrollValue), enrollValue);
  await page.select('#enrollBuildingSelect', enrollValue);
  await page.click('#enrollBuildingBtn');
  await new Promise(r => setTimeout(r, 600));

  enrolledNames = await page.$$eval('.enrolled-building-row h3', els => els.map(el => el.textContent));
  check('after enrolling, the building now appears under Organics Focus too', enrolledNames.includes(buildingName), enrolledNames.join('|'));

  // --- Distribution now lives on its own page (admin-distribution.html, Workstream 2 Phase 4)
  // — prove the tab's handoff carries the CORRECT non-default induction (Organics, not
  // Recycling Sorting); tests/admin-buildings.test.js already proves the same handoff for the
  // default program, and tests/admin-distribution-page.test.js covers the page's own UI
  // (whole-building link/QR/generate/revoke) end-to-end. ---
  await Promise.all([page.waitForNavigation(), page.click('#tabDistributionBtn')]);
  check('the Distribution tab navigates to its own page, carrying the non-default induction too',
    page.url().includes('admin-distribution.html') && page.url().includes(`program=${programId}`),
    page.url());

  // Back to Reports to continue the enrollment-removal check below — session persists
  // (Firebase Auth), but re-select Organics to get its Enrolled Buildings list back on screen.
  await page.goto(REPORT_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => getComputedStyle(document.getElementById('settingsBtn')).display !== 'none',
    { timeout: 10000 }
  );
  // The confirm() stub set earlier doesn't survive a fresh page.goto() — this is a genuinely
  // new JS context, not the same page — so it needs reapplying before removeEnrollmentBtn
  // (below) triggers its own confirm() dialog.
  await page.evaluate(() => { window.confirm = () => true; });
  await selectProgram(page, programId);
  await page.waitForFunction(
    (name) => [...document.querySelectorAll('.enrolled-building-row h3')].some(el => el.textContent === name),
    { timeout: 10000 },
    buildingName
  );

  // --- Remove the Organics Focus enrollment; the building's OTHER enrollment must be untouched ---
  await page.click('#tabEnrolledBuildingsBtn');
  await new Promise(r => setTimeout(r, 200));
  await page.click(`.enrolled-building-row[data-building-id="${buildingId}"] .remove-enrollment-btn`);
  await new Promise(r => setTimeout(r, 600));
  enrolledNames = await page.$$eval('.enrolled-building-row h3', els => els.map(el => el.textContent));
  check('after "Remove from this induction", the building disappears from Organics Focus again',
    !enrolledNames.includes(buildingName), enrolledNames.join('|') || '(none)');

  // Switch back to Recycling Sorting — the building's OTHER enrollment must be untouched.
  await selectProgram(page, 'recycling-sorting');
  await page.waitForFunction(
    (name) => [...document.querySelectorAll('.enrolled-building-row h3')].some(el => el.textContent === name),
    { timeout: 10000 },
    buildingName
  ).catch(() => {});
  enrolledNames = await page.$$eval('.enrolled-building-row h3', els => els.map(el => el.textContent));
  check('removing the Organics Focus enrollment left the Recycling Sorting enrollment intact',
    enrolledNames.includes(buildingName), enrolledNames.join('|'));
}

main().catch((err) => { console.error('Test harness crashed:', err); process.exit(1); });
