// Verifies outputs/admin-catalog.html — the Catalog tab's own page since Workstream 2, Phase 3 of
// the architecture roadmap (C:\Users\smolina\.claude\plans\graceful-roaming-shell.md): registering
// an induction only creates a `programs` catalog entry (never designs/creates the induction
// itself), archiving is a soft-delete (can be unarchived), and cross-page session persistence
// (Firebase Auth's own IndexedDB-backed persistence, already proven for admin-admins.html) also
// holds for this page. Enrollment/distribution scoping against a registered program stays in
// tests/admin-catalog.test.js (that flow lives in sorting-station-report.html, not here).
// Run: npm run test:admin-catalog-page
const path = require('path');
const url = require('url');
const puppeteer = require('puppeteer-core');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');

const EDGE_PATH = process.env.TEST_BROWSER_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CATALOG_URL = `${url.pathToFileURL(path.join(__dirname, '..', 'outputs', 'admin-catalog.html')).href}?emulator=1`;
const REPORT_PATH = path.join(__dirname, '..', 'outputs', 'sorting-station-report.html');
const ALLOWED_EMAIL = 'esgtradeflex@gmail.com';

// This suite's very first assertion needs a genuinely EMPTY programs collection (the "No
// inductions registered yet" empty state) — true by construction when this ran against its own
// fresh emulator, but no longer guaranteed once multiple suites share one long-lived emulator
// (npm run test:all, see tests/run-all.js). Wipe Firestore first so this check stays valid
// regardless of what any earlier suite in the same run already registered; every other suite
// seeds its own uniquely-named fixtures and doesn't depend on state surviving from before this
// one, so clearing here doesn't risk breaking anything later in the sequence either.
async function clearFirestoreBeforeStart(){
  const testEnv = await initializeTestEnvironment({ projectId: 'esg-1-98f35' });
  await testEnv.clearFirestore();
  await testEnv.cleanup();
}

const results = [];
function check(label, cond, extra){ results.push({ label, ok: Boolean(cond), extra: extra || '' }); }

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

  // Same harmless race as tests/admin-admins.test.js: ?emulator=1's own auto sign-in re-fires on
  // every navigation, and its loadPrograms() can resolve a moment after sign-out already ran.
  const unexpectedErrors = consoleErrors.filter(e =>
    !e.includes('auth/email-already-in-use') && !e.includes('Failed to load resource') && !e.includes('400')
    && !e.includes('Failed to load the induction catalog'));
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
  await clearFirestoreBeforeStart();
  await page.goto(CATALOG_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.getElementById('catalogSection') && getComputedStyle(document.getElementById('catalogSection')).display !== 'none',
    { timeout: 10000 }
  );
  check('Catalog section is visible once signed in (this page has nothing else on it)', true);
  await page.waitForFunction(() => (document.getElementById('programsList')?.textContent || '').trim() !== '', { timeout: 10000 });
  check('no inductions registered yet', (await page.$eval('#programsList', el => el.textContent)).includes('No inductions registered yet'));

  // --- Sidebar nav: links to the still-not-split-out... no, now split-out pages, and back ---
  const buildingsHref = await page.$eval('a[href*="admin-buildings.html"]', el => el.getAttribute('href')).catch(() => null);
  check('the Buildings sidebar link points at admin-buildings.html', buildingsHref === 'admin-buildings.html?emulator=1', buildingsHref);
  const adminsHref = await page.$eval('a[href*="admin-admins.html"]', el => el.getAttribute('href')).catch(() => null);
  check('the Admins sidebar link points at admin-admins.html', adminsHref === 'admin-admins.html?emulator=1', adminsHref);
  const backHref = await page.$eval('.settings-sidebar-exit a', el => el.getAttribute('href')).catch(() => null);
  check('"← Back to reports" points at sorting-station-report.html', backHref === 'sorting-station-report.html?emulator=1', backHref);

  // Workstream 11 replaced window.alert()/window.confirm() with a real in-page modal
  // (#appModalOverlay) — there's no native dialog to stub anymore. Instead, auto-respond to the
  // custom modal the same way the old stub did (always "confirm"/"OK"), recording each message
  // into the same __confirmCalls/__alertCalls arrays other assertions in this file may read from.
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

  // --- Register, archive, unarchive — exactly like the old in-page tab used to ---
  const programName = 'Organics Focus ' + Date.now();
  await page.type('#newProgramName', programName);
  await page.type('#newProgramDescription', 'A focused induction on organics sorting.');
  await page.type('#newProgramFile', 'organics-training.html');
  await page.select('#newProgramKind', 'game');
  await page.click('#addProgramBtn');
  await page.waitForFunction(
    () => !['', 'Adding…'].includes(document.getElementById('catalogStatus').textContent),
    { timeout: 10000 }
  );
  const status = await page.$eval('#catalogStatus', el => el.textContent);
  check('program status message confirms the add', status.includes(programName), status);

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

  // --- Cross-page session persistence, same proof as tests/admin-admins.test.js ---
  await page.goto(`${url.pathToFileURL(REPORT_PATH).href}?emulator=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => getComputedStyle(document.getElementById('settingsBtn')).display !== 'none',
    { timeout: 10000 }
  );
  check('navigating to sorting-station-report.html keeps the same signed-in session (no re-login needed)', true);

  await page.goto(CATALOG_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.getElementById('catalogSection') && getComputedStyle(document.getElementById('catalogSection')).display !== 'none',
    { timeout: 10000 }
  );
  check('navigating back to admin-catalog.html also keeps the session (round trip, not one-way)', true);

  // loadPrograms() (fire-and-forget from onAuthStateChanged) hasn't necessarily populated
  // #programsList again yet on this fresh page load — wait for it, otherwise it can still be
  // in flight when #signOutBtn is clicked next and repopulate the list right after sign-out
  // clears it (a race, not a real bug — same class as tests/admin-admins.test.js's own
  // documented "Failed to load admins" race).
  await page.waitForFunction(() => (document.getElementById('programsList')?.textContent || '').trim() !== '', { timeout: 10000 });

  // --- Sign out must actually clear this page's own real data, not just hide it ---
  await page.click('#signOutBtn');
  await new Promise(r => setTimeout(r, 500));
  check('signing out shows the sign-in form again',
    await page.$eval('#authZone', el => getComputedStyle(el).display !== 'none'));
  check('signing out hides the Catalog section',
    await page.$eval('#catalogSection', el => getComputedStyle(el).display === 'none'));
  check('signing out clears the programs list',
    await page.$eval('#programsList', el => el.innerHTML.trim() === ''));
}

main().catch((err) => { console.error('Test harness crashed:', err); process.exit(1); });
