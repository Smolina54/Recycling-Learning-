// Verifies the "Preview" feature added for the admin report (2026-08-28): trying the training
// out from the admin panel must never write real attempts/submissions, and the general
// "Preview the training" button (no building) must skip the id-gate entirely.
// Run: npm run test:preview (wraps this in `firebase emulators:exec` so Firestore is live but local).
const path = require('path');
const url = require('url');
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc, getDocs, collection } = require('firebase/firestore');

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const GAME_PATH = path.join(__dirname, '..', 'outputs', 'recycling-training.html');
const RULES_PATH = path.join(__dirname, '..', 'firestore.rules');
const TEST_BUILDING_ID = 'preview-test-building';
const TEST_TENANT_ID = 'preview-test-tenant';

const results = [];
function check(label, cond, extra){ results.push({label, ok: Boolean(cond), extra: extra || ''}); }

async function seedTestBuilding(){
  const testEnv = await initializeTestEnvironment({
    projectId: 'esg-1-98f35', // must match the real firebaseConfig.projectId — see game-regression.test.js
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'buildings', TEST_BUILDING_ID), { name: 'Preview Test Tower' });
    await setDoc(doc(db, 'buildings', TEST_BUILDING_ID, 'tenants', TEST_TENANT_ID), { name: 'Preview Test Co', levels: ['Level 1'] });
  });
  return testEnv;
}

async function countDocs(testEnv, collectionName){
  let count = 0;
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const snap = await getDocs(collection(context.firestore(), collectionName));
    count = snap.size;
  });
  return count;
}

async function main(){
  const seedEnv = await seedTestBuilding();
  const browser = await puppeteer.launch({ executablePath: EDGE_PATH, headless: true });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

  try {
    await runFlow(page, seedEnv);
  } catch (err) {
    console.error('CRASHED — dumping diagnostics:', err.message);
    await page.screenshot({ path: path.join(__dirname, '..', 'debug-crash.png') }).catch(() => {});
    await browser.close();
    process.exit(1);
  }

  const unexpectedErrors = consoleErrors.filter(e => !e.includes('Failed to load resource') && !e.includes('400'));
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

async function runFlow(page, seedEnv){
  // --- General preview (no building at all) — used by the report's Overview "Preview the
  // training" button — must skip the id-gate entirely, straight to the game. ---
  await page.goto(`${url.pathToFileURL(GAME_PATH).href}?preview=1&emulator=1`, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 500));
  check('general preview (no ?b=) skips the id-gate and shows the main app directly',
    await page.$eval('#mainApp', el => getComputedStyle(el).display !== 'none'));
  check('the preview banner is visible so nobody mistakes this for a real session',
    await page.$eval('#previewBanner', el => getComputedStyle(el).display !== 'none'));

  // --- Building-scoped preview (the per-building "Preview →" button) — real id-gate, but
  // nothing gets written to Firestore, no matter how far the trainee gets. ---
  const attemptsBefore = await countDocs(seedEnv, 'attempts');

  const previewUrl = `${url.pathToFileURL(GAME_PATH).href}?b=${TEST_BUILDING_ID}&preview=1&emulator=1`;
  await page.goto(previewUrl, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 800));
  check('building-scoped preview still shows the real id-gate form (real building/tenant data)',
    await page.$eval('#idCardForm', el => getComputedStyle(el).display !== 'none'));
  check('the preview banner is visible here too',
    await page.$eval('#previewBanner', el => getComputedStyle(el).display !== 'none'));

  await page.select('#idTenant', TEST_TENANT_ID);
  await page.type('#idName', 'Preview Tester');
  await page.type('#idEmail', 'preview-tester@example.com');
  await page.click('#idForm button[type=submit]');
  await new Promise(r => setTimeout(r, 300));
  await page.click('#startGameBtn');
  await new Promise(r => setTimeout(r, 600)); // real code still calls recordAttemptStarted(); it's the isPreviewMode guard inside it that should no-op the write

  const attemptsAfter = await countDocs(seedEnv, 'attempts');
  check('starting the sort in preview mode does NOT create a real "attempts" doc',
    attemptsAfter === attemptsBefore, `before=${attemptsBefore} after=${attemptsAfter}`);
}

main().catch((err) => { console.error('Test harness crashed:', err); process.exit(1); });
