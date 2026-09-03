// Verifies the admin panel's Catalog tab (part of the multi-program plan, see
// C:\Users\smolina\.claude\plans\serene-dreaming-puppy.md): registering an induction only
// creates a `programs` catalog entry (never designs/creates the induction itself), archiving
// is a soft-delete (can be unarchived), and — since the nav rework, see that plan's "Rework
// needed after Sergio's review" — that enrollment (Enrolled Buildings tab) and distribution
// links (Distribution tab) are correctly scoped per selected induction. Run: npm run test:catalog-admin
const path = require('path');
const url = require('url');
const puppeteer = require('puppeteer-core');

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const REPORT_URL = `${url.pathToFileURL(path.join(__dirname, '..', 'outputs', 'sorting-station-report.html')).href}?emulator=1`;
const ALLOWED_EMAIL = 'esgtradeflex@gmail.com';

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
  await page.goto(REPORT_URL, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 300));

  const signInResult = await page.evaluate(async (email) => {
    try { await window.__testSignIn(email, 'test-password-123'); return 'ok'; }
    catch (err) { return 'ERROR: ' + err.message; }
  }, ALLOWED_EMAIL);
  check('test sign-in hook resolved without throwing', signInResult === 'ok', signInResult);

  // The ⚙ settings button (and with it, Buildings/Admins/Catalog) appears as soon as sign-in
  // succeeds — independent of any induction being selected. #programTabs (Reports/Enrolled
  // Buildings/Distribution) deliberately stays hidden until a real induction is picked, so it
  // is NOT the right thing to wait on here.
  await page.waitForFunction(
    () => getComputedStyle(document.getElementById('settingsBtn')).display !== 'none',
    { timeout: 10000 }
  );
  check('the ⚙ settings button (and therefore Catalog) is reachable right after sign-in, with no induction selected yet',
    await page.$eval('#programTabs', el => getComputedStyle(el).display === 'none'));

  await page.click('#settingsBtn');
  await new Promise(r => setTimeout(r, 100));
  await page.click('#tabCatalogBtn');
  await new Promise(r => setTimeout(r, 300));
  check('Catalog tab becomes visible on click, without needing an induction selected first',
    await page.$eval('#catalogSection', el => getComputedStyle(el).display !== 'none'));
  check('Buildings section hides when Catalog tab is active',
    await page.$eval('#buildingsSection', el => getComputedStyle(el).display === 'none'));

  // tabCatalogBtn's click handler calls refreshProgramSelector() (which populates #programsList
  // via loadPrograms()) without awaiting it — wait for that fire-and-forget fetch to actually
  // resolve (i.e. for the list to render SOMETHING) before reading it, rather than racing it.
  await page.waitForFunction(
    () => (document.getElementById('programsList').textContent || '').trim() !== '',
    { timeout: 10000 }
  );
  check('no inductions registered yet', (await page.$eval('#programsList', el => el.textContent)).includes('No inductions registered yet'));

  // Stub confirm() to accept the "register" and "archive" dialogs this flow triggers.
  await page.evaluate(() => { window.confirm = () => true; });

  const programName = 'Organics Focus ' + Date.now();
  await page.type('#newProgramName', programName);
  await page.type('#newProgramDescription', 'A focused induction on organics sorting.');
  await page.type('#newProgramFile', 'organics-training.html');
  await page.select('#newProgramKind', 'game');
  await page.click('#addProgramBtn');
  // This is the very first Firestore write of the whole flow, against a freshly-booted
  // emulator — it can take noticeably longer than the usual ~600ms settle time used elsewhere
  // in this file. Wait for the status text to actually leave "Adding…" rather than racing it.
  await page.waitForFunction(
    () => !['', 'Adding…'].includes(document.getElementById('catalogStatus').textContent),
    { timeout: 10000 }
  );

  const status = await page.$eval('#catalogStatus', el => el.textContent);
  check('program status message confirms the add', status.includes(programName), status);

  // catalogStatus is set synchronously, BEFORE the addProgramBtn handler's own
  // `await refreshProgramSelector()` (a second, separate Firestore round-trip) actually
  // repopulates #programsList — reading/clicking into the list right after the status wait
  // races that repaint. page.click() (unlike page.waitForSelector) does one querySelector
  // with no retry, so it throws immediately if the button isn't in the DOM yet.
  await page.waitForFunction(
    (name) => (document.getElementById('programsList').textContent || '').includes(name),
    { timeout: 10000 },
    programName
  );

  let listText = await page.$eval('#programsList', el => el.textContent);
  check('new program appears in the list with its description and file',
    listText.includes(programName) && listText.includes('organics-training.html'), listText);
  check('newly added program is not shown as archived', !listText.includes(`${programName} (archived)`));

  await page.click('.archive-program-btn');
  await page.waitForFunction(
    () => (document.getElementById('programsList').textContent || '').includes('(archived)'),
    { timeout: 10000 }
  );
  listText = await page.$eval('#programsList', el => el.textContent);
  check('archiving marks the program as archived, does not remove it from the list',
    listText.includes(programName) && listText.includes('(archived)'), listText);
  check('an archived program shows an Unarchive button, not Archive',
    Boolean(await page.$('.unarchive-program-btn')) && !(await page.$('.archive-program-btn')));

  await page.click('.unarchive-program-btn');
  await page.waitForFunction(
    () => !(document.getElementById('programsList').textContent || '').includes('(archived)'),
    { timeout: 10000 }
  );
  listText = await page.$eval('#programsList', el => el.textContent);
  check('unarchiving brings it back to active, Archive button reappears',
    listText.includes(programName) && !listText.includes('(archived)') && Boolean(await page.$('.archive-program-btn')), listText);

  // --- Create a building (master Edificios, program-agnostic) before selecting any induction,
  // so the very first load of program-scoped data below already reflects it. ---
  await page.click('#settingsBtn');
  await new Promise(r => setTimeout(r, 100));
  await page.click('#tabBuildingsBtn');
  await new Promise(r => setTimeout(r, 300));

  const buildingName = 'Test Tower Enroll ' + Date.now();
  await page.type('#newBuildingName', buildingName);
  await page.click('#addBuildingBtn');
  await new Promise(r => setTimeout(r, 600));
  let buildingNames = await page.$$eval('.building-row h3', els => els.map(el => el.textContent));
  check('the newly created building appears in master Edificios', buildingNames.includes(buildingName), buildingNames.join('|'));
  const buildingId = await page.$$eval('.building-row', (rows, name) => {
    const row = rows.find(r => r.querySelector('h3') && r.querySelector('h3').textContent === name);
    return row ? row.dataset.buildingId : null;
  }, buildingName);

  // --- Building enrollment is scoped per selected program (multi-program plan). Select
  // Recycling Sorting first — the building was auto-enrolled there at creation time. ---
  await selectProgram(page, 'recycling-sorting');
  await page.waitForFunction(
    () => getComputedStyle(document.getElementById('programTabs')).display !== 'none',
    { timeout: 10000 }
  );
  // #programTabs is shown synchronously by the change handler, BEFORE it awaits loadLiveData()
  // (which is what actually fetches/renders Enrolled Buildings) — wait for the building we just
  // created (auto-enrolled in Recycling Sorting) to actually show up before reading the list.
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

  // Switch the top selector to the Organics program just registered.
  const programValue = await page.$$eval('#programSelector option', (opts, name) =>
    (opts.find(o => o.textContent.includes(name)) || {}).value, programName);
  await selectProgram(page, programValue);
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

  // --- Distribution: same enrolled set, but the whole-building link/QR/generate-link UI ---
  await page.click('#tabDistributionBtn');
  await new Promise(r => setTimeout(r, 300));
  const distributionSelector = `.distribution-building-row[data-building-id="${buildingId}"]`;
  check('the enrolled building appears under Distribution for Organics Focus', Boolean(await page.$(distributionSelector)));

  const orgLinkText = await page.$eval(`${distributionSelector} .building-link-text`, el => el.textContent);
  check('the link generated under Organics Focus points at organics-training.html, not the recycling page',
    orgLinkText.includes('organics-training.html?b='), orgLinkText);

  // --- Generate/revoke a tenant-scoped, time-limited distribution link (multi-program plan) ---
  await page.select(`${distributionSelector} .new-link-expiry`, '7');
  await page.click(`${distributionSelector} .generate-link-btn`);
  await new Promise(r => setTimeout(r, 600));

  let linksListText = await page.$eval(`${distributionSelector} .generate-link-block .tenant-list`, el => el.textContent);
  check('a generated link appears in the active-links list, scoped "Whole building"',
    linksListText.includes('Whole building') && linksListText.includes('expires'), linksListText);

  const genLinkUrl = await page.$eval(`${distributionSelector} .generate-link-block .copy-link-btn`, el => el.dataset.link);
  check('the generated link URL uses the ?l= token form, points at the right program file',
    genLinkUrl.includes('organics-training.html?l='), genLinkUrl);

  await page.click(`${distributionSelector} .revoke-link-btn`);
  await new Promise(r => setTimeout(r, 600));
  linksListText = await page.$eval(`${distributionSelector} .generate-link-block .tenant-list`, el => el.textContent);
  check('after revoking, the link no longer appears in the active-links list',
    !linksListText.includes('Whole building'), linksListText);

  // --- Remove the Organics Focus enrollment; the building's OTHER enrollment must be untouched ---
  await page.click('#tabEnrolledBuildingsBtn');
  await new Promise(r => setTimeout(r, 200));
  await page.evaluate(() => { window.confirm = () => true; });
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
