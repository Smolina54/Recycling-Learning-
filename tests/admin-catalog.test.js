// Verifies that sorting-station-report.html's Distribution and Enrolled Buildings tabs' cross-
// page handoffs (Workstream 2, Phases 4 and 5 of the architecture roadmap, see
// C:\Users\smolina\.claude\plans\graceful-roaming-shell.md) carry a NON-DEFAULT induction
// correctly, not just 'recycling-sorting' — tests/admin-buildings.test.js already proves the
// same handoffs for the default program, which alone wouldn't catch a bug where the wrong id
// gets passed. Per-program enrollment scoping (enrol/remove, cross-program isolation,
// "Configure streams"/"Custom bins" gating to Recycling-Sorting-only) is covered end-to-end
// against the real UI in tests/admin-enrolled-buildings-page.test.js — this file just seeds a
// second registered program directly via Firestore, no building needed.
// Run: npm run test:catalog-admin
const path = require('path');
const url = require('url');
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc } = require('firebase/firestore');

const EDGE_PATH = process.env.TEST_BROWSER_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const REPORT_URL = `${url.pathToFileURL(path.join(__dirname, '..', 'outputs', 'sorting-station-report.html')).href}?emulator=1`;
const RULES_PATH = path.join(__dirname, '..', 'firestore.rules');
const ALLOWED_EMAIL = 'esgtradeflex@gmail.com';

// Registering an induction is admin-catalog.html's own job now (Workstream 2 Phase 3) — seed
// it directly rather than driving that separate page's UI.
async function seedProgram(){
  const testEnv = await initializeTestEnvironment({
    projectId: 'esg-1-98f35',
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  const programName = 'Organics Focus ' + Date.now();
  const programId = 'organics-focus-' + Date.now();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'programs', programId), {
      name: programName, description: 'A focused induction on organics sorting.',
      file: 'organics-training.html', kind: 'game', status: 'active',
    });
  });
  return { testEnv, programId, programName };
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
    !e.includes('auth/email-already-in-use') && !e.includes('Failed to load resource') && !e.includes('400')
    // Expected: #adminIframe's src gets reassigned when switching tabs while the previously-
    // loaded page's own emulator-only auto-sign-in convenience call can still be in flight —
    // the browser aborts that request as part of navigating the frame away, logged right as it's
    // torn down. Not a real bug — see the matching comment in tests/admin-buildings.test.js.
    && !e.includes('Local auto sign-in failed')
    // Expected: with the shell AND an embedded iframe each running their own independent
    // getFirestore()/connectFirestoreEmulator(), one can occasionally hit the local emulator
    // mid-startup and log a transient "Could not reach Cloud Firestore backend... offline mode"
    // warning — the SDK auto-retries and every real assertion in this test still passes. See
    // the matching comment in tests/admin-buildings.test.js.
    && !e.includes('Could not reach Cloud Firestore backend'));
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
  const { programId } = await seedProgram();
  check('the seeded program exists', Boolean(programId), programId);

  await page.goto(REPORT_URL, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 300));

  const signInResult = await page.evaluate(async (email) => {
    try { await window.__testSignIn(email, 'test-password-123'); return 'ok'; }
    catch (err) { return 'ERROR: ' + err.message; }
  }, ALLOWED_EMAIL);
  check('test sign-in hook resolved without throwing', signInResult === 'ok', signInResult);

  await page.waitForFunction(
    () => getComputedStyle(document.getElementById('settingsBtn')).display !== 'none',
    { timeout: 10000 }
  );

  await selectProgram(page, programId);
  await page.waitForFunction(
    () => getComputedStyle(document.getElementById('programTabs')).display !== 'none',
    { timeout: 10000 }
  );
  // This freshly-seeded program has zero submissions/attempts, so Reports renders its empty
  // state (renderReport() returns before ever touching #pendingTable/#pendingEmpty) rather than
  // a real pending row — wait for either shape rather than assuming data exists.
  await page.waitForFunction(
    () => document.querySelector('#pendingTable tr') !== null ||
      getComputedStyle(document.getElementById('emptyState')).display !== 'none',
    { timeout: 10000 }
  );

  // --- Distribution/Enrolled Buildings now render IN PLACE via #adminIframe (Workstream 3,
  // Item A) instead of a full navigation — prove the handoff still carries the non-default
  // induction (Organics, not Recycling Sorting) correctly, and that the top-level page never
  // navigates away. tests/admin-buildings.test.js already proves the same handoff for the
  // default program; tests/admin-distribution-page.test.js / admin-enrolled-buildings-page.test.js
  // cover each page's own UI end-to-end. ---
  const urlBeforeTabSwitch = page.url();
  await page.click('#tabDistributionBtn');
  await page.waitForFunction(
    () => document.getElementById('adminIframe')?.src.includes('admin-distribution.html'),
    { timeout: 10000 }
  );
  let iframeSrc = await page.$eval('#adminIframe', el => el.src);
  check('the Distribution tab loads its own page into the iframe (no top-level navigation), carrying the non-default induction too',
    page.url() === urlBeforeTabSwitch && iframeSrc.includes('admin-distribution.html') && iframeSrc.includes(`program=${programId}`),
    `pageUrl=${page.url()} iframeSrc=${iframeSrc}`);

  // --- Enrolled Buildings: same proof, same reasoning. ---
  await page.click('#tabEnrolledBuildingsBtn');
  await page.waitForFunction(
    () => document.getElementById('adminIframe')?.src.includes('admin-enrolled-buildings.html'),
    { timeout: 10000 }
  );
  iframeSrc = await page.$eval('#adminIframe', el => el.src);
  check('the Enrolled Buildings tab loads its own page into the iframe (no top-level navigation), carrying the non-default induction too',
    page.url() === urlBeforeTabSwitch && iframeSrc.includes('admin-enrolled-buildings.html') && iframeSrc.includes(`program=${programId}`),
    `pageUrl=${page.url()} iframeSrc=${iframeSrc}`);
}

main().catch((err) => { console.error('Test harness crashed:', err); process.exit(1); });
