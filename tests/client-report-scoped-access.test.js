// Verifies a real bug found in a pre-production audit: outputs/client-report.html had NO
// /buildingAccess scoping at all — a building-scoped admin (granted access to specific buildings,
// see firestore.rules' canReviewBuilding()) could check ANY enrolled building in the report
// generator's checklist, and Firestore rejects a submissions/attempts query outright if it
// includes even one building outside their grant (rules can only permit a query if every document
// it could return is provably allowed) — the whole report generation then failed with a generic
// "Something went wrong," with no way for the admin to know why.
//
// Fixed via filterToGrantedBuildings(): fetch this user's own buildingAccess grants right after
// sign-in and, if any exist, narrow the checklist to just those buildings. An empty grant list
// means "global reviewer, show everything" (the same assumption this app's buildingAccess design
// already makes elsewhere) — verified below as a negative control so the normal/global-admin path
// is provably unaffected by this fix.
// Run: npm run test:client-report-scoped
const path = require('path');
const url = require('url');
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc } = require('firebase/firestore');

const EDGE_PATH = process.env.TEST_BROWSER_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const REPORT_PATH = path.join(__dirname, '..', 'outputs', 'client-report.html');
const RULES_PATH = path.join(__dirname, '..', 'firestore.rules');
const OWNER_EMAIL = 'esgtradeflex@gmail.com';
const SCOPED_CLIENT_EMAIL = 'scoped-report-client@example.com';
const NO_GRANT_EMAIL = 'no-grant-report-client@example.com';
const PASSWORD = 'test-password-123';
const BUILDING_A = 'client-report-scoped-building-a';
const BUILDING_B = 'client-report-scoped-building-b';

const results = [];
function check(label, cond, extra){ results.push({ label, ok: Boolean(cond), extra: extra || '' }); }

async function seed(){
  const testEnv = await initializeTestEnvironment({
    projectId: 'esg-1-98f35',
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'buildings', BUILDING_A), { name: 'Granted Tower' });
    await setDoc(doc(db, 'buildings', BUILDING_B), { name: 'Ungranted Tower' });
    await setDoc(doc(db, 'enrollments', `recycling-sorting__${BUILDING_A}`), { programId: 'recycling-sorting', buildingId: BUILDING_A, active: true });
    await setDoc(doc(db, 'enrollments', `recycling-sorting__${BUILDING_B}`), { programId: 'recycling-sorting', buildingId: BUILDING_B, active: true });
    await setDoc(doc(db, 'buildingAccess', `${SCOPED_CLIENT_EMAIL}__${BUILDING_A}`), {
      email: SCOPED_CLIENT_EMAIL, buildingId: BUILDING_A, addedAt: new Date(), addedBy: OWNER_EMAIL,
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

  // "Failed to load admins"-style 400s are expected for a non-global signed-in account, same as
  // the sibling scoped-report-access.test.js — harmless, unrelated to what this test checks.
  const unexpectedErrors = consoleErrors.filter(e =>
    !e.includes('Failed to load resource') && !e.includes('400') && !e.includes('403'));
  check('no UNEXPECTED console/page errors during the whole flow', unexpectedErrors.length === 0, unexpectedErrors.join(' || '));

  console.log('\n--- RESULTS ---');
  let allOk = true;
  for (const r of results){
    console.log(`${r.ok ? 'PASS' : 'FAIL'} — ${r.label}${r.extra ? ' :: ' + r.extra : ''}`);
    if (!r.ok) allOk = false;
  }
  process.exit(allOk ? 0 : 1);
}

async function checklistNames(page){
  return page.$$eval('#buildingChecklist .building-check-row span', els => els.map(el => el.textContent.trim()));
}

async function runFlow(page){
  await page.goto(`${url.pathToFileURL(REPORT_PATH).href}?program=recycling-sorting&emulator=1`, { waitUntil: 'domcontentloaded' });
  // Page auto-signs in as the owner on load (?emulator=1 convenience) — switch to the scoped
  // client explicitly, same __testSignIn hook already used elsewhere in this project's tests.
  await page.evaluate((email, password) => window.__testSignIn(email, password), SCOPED_CLIENT_EMAIL, PASSWORD);
  // Wait for a REAL building row specifically, not just "any child" — the empty-state message
  // (<p>No buildings enrolled...</p>) is also 1 child, so a generic children.length>0 check can
  // resolve on a transient render (e.g. while the owner's own auto sign-in is still settling)
  // before the scoped user's real data has actually loaded, racing the assertion below.
  await page.waitForFunction(() => document.querySelectorAll('#buildingChecklist .building-check-row').length > 0, { timeout: 10000 });

  const scopedNames = await checklistNames(page);
  check('a building-scoped admin sees ONLY their granted building in the checklist',
    scopedNames.length === 1 && scopedNames[0] === 'Granted Tower', JSON.stringify(scopedNames));

  // ---- Negative control: signed in, zero /buildingAccess grant at all — must see everything,
  // proving the normal/global-admin path is unaffected by this fix. ----
  await page.evaluate((email, password) => window.__testSignIn(email, password), NO_GRANT_EMAIL, PASSWORD);
  // Same reasoning as above — wait for exactly the 2-row state this account should end up with,
  // not just "any content", so a transient in-between render can't satisfy the wait early.
  await page.waitForFunction(() => document.querySelectorAll('#buildingChecklist .building-check-row').length === 2, { timeout: 10000 });

  const unscopedNames = await checklistNames(page);
  check('a signed-in user with NO grant at all sees every enrolled building (treated as a global reviewer)',
    unscopedNames.length === 2 && unscopedNames.includes('Granted Tower') && unscopedNames.includes('Ungranted Tower'),
    JSON.stringify(unscopedNames));
}

main().catch((err) => { console.error('Test harness crashed:', err); process.exit(1); });
