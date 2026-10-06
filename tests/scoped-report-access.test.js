// Verifies the Reports tab's Workstream-1-Step-C fallback in outputs/sorting-station-report.html:
// loadScopedLiveData()/loadLiveData() — a signed-in user who is NOT a global reviewer, but does
// have a /buildingAccess grant for one specific building, should see ONLY that building's
// submissions in the report (not another building's), while a global reviewer's own path is
// completely unaffected (already covered by tests/firestore-rules.test.js at the rules level —
// this test drives the real page/UI on top of that, proving the fallback query actually wires up).
// Run: npm run test:scoped-report
const path = require('path');
const url = require('url');
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc, addDoc, collection } = require('firebase/firestore');

const EDGE_PATH = process.env.TEST_BROWSER_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const REPORT_PATH = path.join(__dirname, '..', 'outputs', 'sorting-station-report.html');
const RULES_PATH = path.join(__dirname, '..', 'firestore.rules');
const OWNER_EMAIL = 'esgtradeflex@gmail.com';
const SCOPED_CLIENT_EMAIL = 'scoped-client@example.com';
const NO_GRANT_EMAIL = 'no-grant-client@example.com';
const PASSWORD = 'test-password-123';

const results = [];
function check(label, cond, extra){ results.push({ label, ok: Boolean(cond), extra: extra || '' }); }

async function selectProgram(page, programId){
  await page.waitForFunction(
    (id) => document.querySelector(`#programSelector option[value="${id}"]`) !== null,
    { timeout: 10000 },
    programId
  );
  await page.select('#programSelector', programId);
}

async function seed(){
  const testEnv = await initializeTestEnvironment({
    projectId: 'esg-1-98f35',
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'buildings', 'building-a'), { name: 'Building A' });
    await setDoc(doc(db, 'buildings', 'building-b'), { name: 'Building B' });
    const person = (buildingId) => ({
      buildingId, buildingName: buildingId, tenantId: 'tenant-1', tenantName: 'Tenant',
      level: 'Level 1', name: 'Jane Doe', email: 'jane@example.com',
      programId: 'recycling-sorting', score: 90, timestamp: new Date(),
    });
    await addDoc(collection(db, 'submissions'), person('building-a'));
    await addDoc(collection(db, 'submissions'), person('building-b'));
    await setDoc(doc(db, 'buildingAccess', `${SCOPED_CLIENT_EMAIL}__building-a`), {
      email: SCOPED_CLIENT_EMAIL, buildingId: 'building-a', addedAt: new Date(), addedBy: OWNER_EMAIL,
    });
  });
  return testEnv;
}

async function main(){
  const seedEnv = await seed();
  const browser = await puppeteer.launch({ executablePath: EDGE_PATH, headless: true });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

  try {
    await runFlow(page);
  } catch (err) {
    console.error('CRASHED — dumping diagnostics:', err.message);
    await page.screenshot({ path: path.join(__dirname, '..', 'debug-crash.png') }).catch(() => {});
    await browser.close();
    await seedEnv.cleanup();
    process.exit(1);
  }

  await browser.close();
  await seedEnv.cleanup();

  // "Failed to load admins" is expected here: a scoped (non-global) client legitimately cannot
  // read /admins per firestore.rules, and the page tries to load that list for every signed-in
  // user regardless of role — harmless, unrelated to the Reports data this test actually checks.
  const unexpectedErrors = consoleErrors.filter(e =>
    !e.includes('Failed to load resource') && !e.includes('400') && !e.includes('Failed to load admins'));
  check('no UNEXPECTED console/page errors during the whole flow', unexpectedErrors.length === 0, unexpectedErrors.join(' || '));

  console.log('\n--- RESULTS ---');
  let allOk = true;
  for (const r of results){
    console.log(`${r.ok ? 'PASS' : 'FAIL'} — ${r.label}${r.extra ? ' :: ' + r.extra : ''}`);
    if (!r.ok) allOk = false;
  }
  process.exit(allOk ? 0 : 1);
}

async function runFlow(page){
  await page.goto(`${url.pathToFileURL(REPORT_PATH).href}?emulator=1`, { waitUntil: 'domcontentloaded' });
  // Page auto-signs in as the owner on load (?emulator=1 convenience) — switch to the scoped
  // client explicitly, same __testSignIn hook, just a different account.
  await page.evaluate((email, password) => window.__testSignIn(email, password), SCOPED_CLIENT_EMAIL, PASSWORD);
  await page.waitForFunction(() => document.getElementById('programSelectorRow') &&
    getComputedStyle(document.getElementById('programSelectorRow')).display !== 'none', { timeout: 10000 });

  await selectProgram(page, 'recycling-sorting');
  await page.waitForFunction(
    () => /^\d+$/.test(document.querySelector('#kpiRow .kpi-tile:nth-child(1) .kpi-value')?.textContent.trim() || ''),
    { timeout: 10000 }
  );

  const submissionsKpi = await page.$eval('#kpiRow .kpi-tile:nth-child(1) .kpi-value', el => el.textContent.trim());
  check('scoped client sees exactly 1 submission (their granted building only), not both', submissionsKpi === '1', submissionsKpi);

  const authStatusText = await page.$eval('#authStatus', el => el.textContent);
  check('no "not authorised" message shown for a validly-scoped client', !authStatusText.includes("isn't authorised"), authStatusText);

  // A pre-production audit found "Delete these submissions" was shown to scoped admins even
  // though firestore.rules restricts delete to isAllowedReviewer() only — they could confirm a
  // destructive-sounding prompt and then just get a generic failure, since they can never
  // actually succeed. Confirmed hidden for a scoped client, still shown for the global owner.
  const deleteBtnDisplayScoped = await page.$eval('#deleteBtn', el => getComputedStyle(el).display);
  check('"Delete these submissions" is hidden for a building-scoped (non-global) reviewer', deleteBtnDisplayScoped === 'none', deleteBtnDisplayScoped);

  // ---- Negative control: signed in, but zero /buildingAccess grant at all ----
  // Workstream 15 Part 3's immediate post-sign-in gate fires before the page ever shows the
  // program selector — a genuinely unauthorized account (no admin role, no buildingAccess grant)
  // gets signed straight back out with a clear denial, rather than being left signed in to stare
  // at an "isn't authorised" message the way it used to. No selectProgram() call needed here
  // anymore: by the time any program could be picked, the gate has already signed the user out.
  await page.evaluate((email, password) => window.__testSignIn(email, password), NO_GRANT_EMAIL, PASSWORD);
  await page.waitForFunction(
    () => (document.getElementById('authStatus')?.textContent || '').includes("doesn't have access"),
    { timeout: 10000 }
  );
  const noGrantStatusText = await page.$eval('#authStatus', el => el.textContent);
  check('a signed-in user with NO grant at all is signed back out with a clear denial message (Workstream 15 Part 3 gate)', noGrantStatusText.includes("doesn't have access"), noGrantStatusText);

  const signedOutAfterGate = await page.$eval('#signInBtn', el => getComputedStyle(el).display !== 'none');
  check('...and is actually signed out, not just shown a message while still signed in', signedOutAfterGate);
}

main().catch((err) => { console.error('Test harness crashed:', err); process.exit(1); });
