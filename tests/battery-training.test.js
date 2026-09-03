// Smoke test for outputs/battery-training.html (the second specialized induction, see the
// multi-program plan): id-gate -> enrollment gate -> full 5-question quiz -> submission
// written with programId 'battery-disposal'. Same scope/rigor as organics-training.test.js —
// a still-evolving demo page, not a full parallel of the main game's test depth.
// Run: npm run test:battery
const path = require('path');
const url = require('url');
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc, collection, getDocs, query, where } = require('firebase/firestore');

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const GAME_PATH = path.join(__dirname, '..', 'outputs', 'battery-training.html');
const RULES_PATH = path.join(__dirname, '..', 'firestore.rules');
const BUILDING_ID = 'test-tower-battery';
const TENANT_ID = 'test-tenant-battery';

const results = [];
function check(label, cond, extra){ results.push({label, ok: Boolean(cond), extra: extra || ''}); }

async function seedBuilding(){
  const testEnv = await initializeTestEnvironment({
    projectId: 'esg-1-98f35',
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'programs', 'battery-disposal'), { name: 'Battery Disposal', file: 'battery-training.html', kind: 'quiz', status: 'active' });
    await setDoc(doc(db, 'buildings', BUILDING_ID), { name: 'Test Tower Battery' });
    await setDoc(doc(db, 'buildings', BUILDING_ID, 'tenants', TENANT_ID), { name: 'Test Co', levels: ['Level 1'] });
    await setDoc(doc(db, 'enrollments', `battery-disposal__${BUILDING_ID}`), {
      programId: 'battery-disposal', buildingId: BUILDING_ID, itemOverrides: {},
    });
  });
  return testEnv;
}

async function main(){
  const seedEnv = await seedBuilding();
  const browser = await puppeteer.launch({ executablePath: EDGE_PATH, headless: true });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));
  page.on('dialog', (d) => { consoleErrors.push('unexpected dialog: ' + d.message()); d.dismiss(); });

  try {
    await runFlow(page, consoleErrors);
  } catch (err) {
    console.error('CRASHED — dumping diagnostics:', err.message);
    await page.screenshot({ path: path.join(__dirname, '..', 'debug-crash.png') }).catch(() => {});
    await browser.close();
    process.exit(1);
  }

  const unexpectedErrors = consoleErrors.filter(e =>
    !e.includes('Failed to load resource') && !e.includes('400') && !e.includes('answer every question'));
  check('no UNEXPECTED console/page errors across the full run', unexpectedErrors.length === 0, unexpectedErrors.join(' || '));

  await browser.close();
  await seedEnv.cleanup();

  console.log('\n--- RESULTS ---');
  let allOk = true;
  for (const r of results){
    console.log(`${r.ok ? 'PASS' : 'FAIL'} — ${r.label}${r.extra ? ' :: ' + r.extra : ''}`);
    if (!r.ok) allOk = false;
  }
  process.exit(allOk ? 0 : 1);
}

async function runFlow(page, consoleErrors){
  const gameUrl = `${url.pathToFileURL(GAME_PATH).href}?b=${BUILDING_ID}&emulator=1`;
  await page.goto(gameUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.querySelector('#idTenant option[value]:not([value=""])') !== null,
    { timeout: 10000 }
  );
  check('id-gate form is shown for a building enrolled in battery-disposal',
    await page.$eval('#idCardForm', el => getComputedStyle(el).display !== 'none'));

  await page.type('#idName', 'Jane Doe');
  await page.type('#idEmail', 'jane-battery@example.com');
  await page.select('#idTenant', TENANT_ID);
  await new Promise(r => setTimeout(r, 200));
  await page.select('#idLevel', 'Level 1');
  await page.click('#idForm button[type=submit]');
  await new Promise(r => setTimeout(r, 300));

  await page.click('#toGameBtn');
  await new Promise(r => setTimeout(r, 300));

  // Trying to submit with nothing answered must be rejected, not silently scored.
  await page.click('#startGameBtn');
  await new Promise(r => setTimeout(r, 200));
  const questionBlocks = await page.$$eval('.quiz-question', els => els.length);
  check('all 5 questions render', questionBlocks === 5, questionBlocks);

  // The page's own window.confirm/alert flow through the harness's blanket page.on('dialog')
  // handler (dismisses everything) — check the expected alert landed in consoleErrors instead
  // of racing a second dialog handler against it.
  const errorsBeforeSubmitAttempt = consoleErrors.length;
  await page.click('#submitQuizBtn');
  await new Promise(r => setTimeout(r, 200));
  const alertFired = consoleErrors.slice(errorsBeforeSubmitAttempt).some(e => e.includes('answer every question'));
  check('submitting with no answers is rejected (alert, no results shown)',
    alertFired && !(await page.$eval('#results', el => el.classList.contains('active'))));

  // Answer all 5 correctly (c, b, b, c, d — matches battery-training.html's own QUESTIONS).
  const correctAnswers = { q1: 'c', q2: 'b', q3: 'b', q4: 'c', q5: 'd' };
  for (const [name, value] of Object.entries(correctAnswers)){
    await page.click(`input[name="${name}"][value="${value}"]`);
  }
  await page.click('#submitQuizBtn');
  await new Promise(r => setTimeout(r, 400));

  check('results screen is active after submitting', await page.$eval('#results', el => el.classList.contains('active')).catch(() => false));
  const scoreOfText = await page.$eval('#scoreOf', el => el.textContent.trim()).catch(() => '');
  check('a perfect run scores 5 / 5', scoreOfText.includes('5 / 5'), scoreOfText);
  const reviewText = await page.$eval('#quizReview', el => el.textContent).catch(() => '');
  check('review shows all 5 questions marked correct', (reviewText.match(/Correct —/g) || []).length === 5, reviewText.slice(0, 200));

  const verifyEnv = await initializeTestEnvironment({
    projectId: 'esg-1-98f35',
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  let submissionOk = false;
  await verifyEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    const q = query(collection(db, 'submissions'), where('email', '==', 'jane-battery@example.com'));
    const snap = await getDocs(q);
    if (!snap.empty){
      const data = snap.docs[0].data();
      submissionOk = data.programId === 'battery-disposal' && data.total === 5 && data.correctCount === 5 && data.score === 100;
    }
  });
  check('the submission was written with programId battery-disposal, correctCount 5, score 100', submissionOk);
}

main().catch((err) => { console.error('Test harness crashed:', err); process.exit(1); });
