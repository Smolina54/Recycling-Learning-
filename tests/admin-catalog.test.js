// Verifies the admin panel's Catalog tab (part of the multi-program plan, see
// C:\Users\smolina\.claude\plans\serene-dreaming-puppy.md): registering an induction only
// creates a `programs` catalog entry (never designs/creates the induction itself), and
// archiving is a soft-delete — the entry disappears from active use but is never deleted and
// can be unarchived. Run: npm run test:catalog-admin
const path = require('path');
const url = require('url');
const puppeteer = require('puppeteer-core');

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const REPORT_URL = `${url.pathToFileURL(path.join(__dirname, '..', 'outputs', 'sorting-station-report.html')).href}?emulator=1`;
const ALLOWED_EMAIL = 'esgtradeflex@gmail.com';

const results = [];
function check(label, cond, extra){ results.push({label, ok: Boolean(cond), extra: extra || ''}); }

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
  // loadLiveData() now also awaits refreshProgramSelector() (an extra Firestore round-trip
  // added by the multi-program plan) before showing #adminTabs — wait for it to actually
  // become visible rather than guessing a fixed duration.
  await page.waitForFunction(
    () => getComputedStyle(document.getElementById('adminTabs')).display !== 'none',
    { timeout: 10000 }
  );
  check('admin tabs appear after signing in', true);

  await page.click('#settingsBtn');
  await new Promise(r => setTimeout(r, 100));
  await page.click('#tabCatalogBtn');
  await new Promise(r => setTimeout(r, 300));
  check('Catalog tab becomes visible on click',
    await page.$eval('#catalogSection', el => getComputedStyle(el).display !== 'none'));
  check('Buildings section hides when Catalog tab is active',
    await page.$eval('#buildingsSection', el => getComputedStyle(el).display === 'none'));

  check('no inductions registered yet', (await page.$eval('#programsList', el => el.textContent)).includes('No inductions registered yet'));

  // Stub confirm() to accept the "register" and "archive" dialogs this flow triggers.
  await page.evaluate(() => { window.confirm = () => true; });

  const programName = 'Organics Focus ' + Date.now();
  await page.type('#newProgramName', programName);
  await page.type('#newProgramDescription', 'A focused induction on organics sorting.');
  await page.type('#newProgramFile', 'organics-training.html');
  await page.select('#newProgramKind', 'game');
  await page.click('#addProgramBtn');
  await new Promise(r => setTimeout(r, 600));

  const status = await page.$eval('#catalogStatus', el => el.textContent);
  check('program status message confirms the add', status.includes(programName), status);

  let listText = await page.$eval('#programsList', el => el.textContent);
  check('new program appears in the list with its description and file',
    listText.includes(programName) && listText.includes('organics-training.html'), listText);
  check('newly added program is not shown as archived', !listText.includes(`${programName} (archived)`));

  await page.click('.archive-program-btn');
  await new Promise(r => setTimeout(r, 600));
  listText = await page.$eval('#programsList', el => el.textContent);
  check('archiving marks the program as archived, does not remove it from the list',
    listText.includes(programName) && listText.includes('(archived)'), listText);
  check('an archived program shows an Unarchive button, not Archive',
    Boolean(await page.$('.unarchive-program-btn')) && !(await page.$('.archive-program-btn')));

  await page.click('.unarchive-program-btn');
  await new Promise(r => setTimeout(r, 600));
  listText = await page.$eval('#programsList', el => el.textContent);
  check('unarchiving brings it back to active, Archive button reappears',
    listText.includes(programName) && !listText.includes('(archived)') && Boolean(await page.$('.archive-program-btn')), listText);

  // --- Building enrollment is scoped per selected program (multi-program plan) ---
  await page.click('#settingsBtn');
  await new Promise(r => setTimeout(r, 100));
  await page.click('#tabBuildingsBtn');
  await new Promise(r => setTimeout(r, 300));

  const buildingName = 'Test Tower Enroll ' + Date.now();
  await page.type('#newBuildingName', buildingName);
  await page.click('#addBuildingBtn');
  await new Promise(r => setTimeout(r, 600));
  let buildingNames = await page.$$eval('.building-row h3', els => els.map(el => el.textContent));
  check('a newly created building appears while Recycling Sorting is selected (auto-enrolled there)',
    buildingNames.includes(buildingName), buildingNames.join('|'));

  // Switch the top selector to the Organics program just registered.
  const programValue = await page.$$eval('#programSelector option', (opts, name) =>
    (opts.find(o => o.textContent.includes(name)) || {}).value, programName);
  await page.select('#programSelector', programValue);
  await new Promise(r => setTimeout(r, 600));

  buildingNames = await page.$$eval('.building-row h3', els => els.map(el => el.textContent));
  check('that same building does NOT appear under Organics Focus — it was never enrolled there',
    !buildingNames.includes(buildingName), buildingNames.join('|') || '(none)');
  check('"Configure streams" is not offered for a non-Recycling program (no per-building content to configure)',
    !(await page.$('.configure-items-btn')));

  const enrollValue = await page.$$eval('#enrollBuildingSelect option', (opts, name) =>
    (opts.find(o => o.textContent === name) || {}).value, buildingName);
  check('the not-yet-enrolled building is offered in the "enroll existing building" picker', Boolean(enrollValue), enrollValue);
  await page.select('#enrollBuildingSelect', enrollValue);
  await page.click('#enrollBuildingBtn');
  await new Promise(r => setTimeout(r, 600));

  buildingNames = await page.$$eval('.building-row h3', els => els.map(el => el.textContent));
  check('after enrolling, the building now appears under Organics Focus too', buildingNames.includes(buildingName), buildingNames.join('|'));

  const orgLinkText = await page.$$eval('.building-row', (rows, name) => {
    const row = rows.find(r => r.querySelector('h3').textContent === name);
    return row ? row.querySelector('.building-link-text').textContent : '';
  }, buildingName);
  check('the link generated under Organics Focus points at organics-training.html, not the recycling page',
    orgLinkText.includes('organics-training.html?b='), orgLinkText);

  // --- Generate/revoke a tenant-scoped, time-limited distribution link (multi-program plan) ---
  const rowHandleForLinks = await page.$$eval('.building-row', (rows, name) =>
    rows.findIndex(r => r.querySelector('h3').textContent === name), buildingName);
  const rowSelector = `.building-row:nth-of-type(${rowHandleForLinks + 1})`;
  await page.select(`${rowSelector} .new-link-expiry`, '7');
  await page.click(`${rowSelector} .generate-link-btn`);
  await new Promise(r => setTimeout(r, 600));

  let linksListText = await page.$eval(`${rowSelector} .generate-link-block .tenant-list`, el => el.textContent);
  check('a generated link appears in the active-links list, scoped "Whole building"',
    linksListText.includes('Whole building') && linksListText.includes('expires'), linksListText);

  const genLinkUrl = await page.$eval(`${rowSelector} .generate-link-block .copy-link-btn`, el => el.dataset.link);
  check('the generated link URL uses the ?l= token form, points at the right program file',
    genLinkUrl.includes('organics-training.html?l='), genLinkUrl);

  await page.click(`${rowSelector} .revoke-link-btn`);
  await new Promise(r => setTimeout(r, 600));
  linksListText = await page.$eval(`${rowSelector} .generate-link-block .tenant-list`, el => el.textContent);
  check('after revoking, the link no longer appears in the active-links list',
    !linksListText.includes('Whole building'), linksListText);

  await page.click('.remove-enrollment-btn');
  await new Promise(r => setTimeout(r, 600));
  buildingNames = await page.$$eval('.building-row h3', els => els.map(el => el.textContent));
  check('after "Remove from this induction", the building disappears from Organics Focus again',
    !buildingNames.includes(buildingName), buildingNames.join('|') || '(none)');

  // Switch back to Recycling Sorting — the building's OTHER enrollment must be untouched.
  await page.select('#programSelector', 'recycling-sorting');
  await new Promise(r => setTimeout(r, 600));
  buildingNames = await page.$$eval('.building-row h3', els => els.map(el => el.textContent));
  check('removing the Organics Focus enrollment left the Recycling Sorting enrollment intact',
    buildingNames.includes(buildingName), buildingNames.join('|'));
}

main().catch((err) => { console.error('Test harness crashed:', err); process.exit(1); });
