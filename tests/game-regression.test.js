// Full 5-phase click-through of the training game, via puppeteer-core driving
// the locally-installed Edge (no Chromium download needed). Run: npm run test:game
const path = require('path');
const url = require('url');
const puppeteer = require('puppeteer-core');

// Known limitation: hardcoded to Sergio's installed Edge path — single-machine internal tool, not solved with OS-detection.
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const GAME_URL = url.pathToFileURL(path.join(__dirname, '..', 'outputs', 'recycling-training.html')).href;
const EXPECTED_MESSAGES = ['Firebase is not configured yet', 'Failed to submit Sorting Station results'];

const results = [];
function check(label, cond, extra){ results.push({label, ok: Boolean(cond), extra: extra || ''}); }

async function resolvePhase(page){
  for (let i = 0; i < 12; i++){
    const nextVisible = await page.$eval('#nextPhaseBtn', el => getComputedStyle(el).display !== 'none').catch(() => false);
    if (nextVisible) return true;
    const card = await page.$('.board-item:not(.locked):not([data-test-clicked])');
    if (!card) return false;
    await card.evaluate(el => el.setAttribute('data-test-clicked', '1'));
    await card.focus();
    await page.keyboard.press('Enter');
    await new Promise(r => setTimeout(r, 120));
  }
  return await page.$eval('#nextPhaseBtn', el => getComputedStyle(el).display !== 'none').catch(() => false);
}

async function main(){
  const browser = await puppeteer.launch({ executablePath: EDGE_PATH, headless: true });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

  await page.goto(GAME_URL, { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 300));
  check('id-gate shows invalid-link fallback with no ?b= param',
    await page.$eval('#idCardInvalid', el => getComputedStyle(el).display !== 'none'));
  check('id-gate form is NOT shown with no ?b= param',
    await page.$eval('#idCardForm', el => getComputedStyle(el).display === 'none'));

  // Bypass the gate (simulating a completed sign-in) to test the untouched game logic.
  await page.evaluate(() => {
    document.getElementById('idGate').style.display = 'none';
    document.getElementById('mainApp').style.display = 'block';
  });

  const tabs = await page.$$('.bin-tab');
  check('found 5 stream tabs', tabs.length === 5, tabs.length);
  for (const tab of tabs){ await tab.click(); await new Promise(r => setTimeout(r, 80)); }
  await new Promise(r => setTimeout(r, 200));
  check('"Begin the sort" enabled after visiting all 5 streams',
    await page.$eval('#startGameBtn', el => !el.disabled));

  await page.click('#startGameBtn');
  await new Promise(r => setTimeout(r, 300));
  check('game stage visible after clicking Begin the sort',
    await page.$eval('#gameStage', el => getComputedStyle(el).display !== 'none'));

  let phasesCompleted = 0;
  for (let phase = 0; phase < 5; phase++){
    const reachedFive = await resolvePhase(page);
    if (!reachedFive) break;
    phasesCompleted++;
    await page.click('#nextPhaseBtn');
    await new Promise(r => setTimeout(r, 300));
  }
  check('all 5 phases reached 5/5 and advanced', phasesCompleted === 5, phasesCompleted);

  await new Promise(r => setTimeout(r, 300));
  check('results screen is active after the 5th phase',
    await page.$eval('#results', el => el.classList.contains('active')).catch(() => false));
  const scoreText = await page.$eval('#scorePct', el => el.textContent.trim()).catch(() => '');
  check('score percentage rendered on results screen', /^\d+%$/.test(scoreText), scoreText);
  const breakdownRows = await page.$$eval('#streamBreakdown .breakdown-row', els => els.length).catch(() => 0);
  check('per-stream breakdown rendered 5 rows', breakdownRows === 5, breakdownRows);
  const reviewRows = await page.$$eval('#reviewList .review-item', els => els.length).catch(() => 0);
  check('review list rendered 25 item rows', reviewRows === 25, reviewRows);

  // db is null (empty firebaseConfig in this environment) so the save is expected to fail —
  // confirms the trainee is actually told, instead of silently losing their result.
  await new Promise(r => setTimeout(r, 200));
  check('save-failure warning is shown when the Firestore write fails',
    await page.$eval('#saveWarning', el => getComputedStyle(el).display !== 'none'));

  const errorsBeforeRetry = consoleErrors.length;
  await page.click('#retrySaveBtn');
  await new Promise(r => setTimeout(r, 200));
  check('retry button re-attempts the save without throwing', consoleErrors.length > errorsBeforeRetry);
  check('save-failure warning is still shown after a retry that also fails (no real backend yet)',
    await page.$eval('#saveWarning', el => getComputedStyle(el).display !== 'none'));

  const unexpectedErrors = consoleErrors.filter(e => !EXPECTED_MESSAGES.some(m => e.includes(m)));
  check('no UNEXPECTED console/page errors across the full run', unexpectedErrors.length === 0, unexpectedErrors.join(' || '));

  await browser.close();

  console.log('\n--- RESULTS ---');
  let allOk = true;
  for (const r of results){
    console.log(`${r.ok ? 'PASS' : 'FAIL'} — ${r.label}${r.extra !== '' ? ' :: ' + r.extra : ''}`);
    if (!r.ok) allOk = false;
  }
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => { console.error('Test harness crashed:', err); process.exit(1); });
