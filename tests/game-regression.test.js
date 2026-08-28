// Full 5-phase click-through of the training game, via puppeteer-core driving
// the locally-installed Edge (no Chromium download needed). Run: npm run test:game
// (wraps this in `firebase emulators:exec` so Firestore is live but local, not real).
//
// Seeds a test building/tenant via the emulator, then goes through the REAL
// id-gate (not a bypass) — building/tenant/level dropdowns, name+email, submit —
// so this exercises the actual production code path end-to-end, including a
// real successful Firestore write, not just the game mechanics in isolation.
const path = require('path');
const url = require('url');
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc } = require('firebase/firestore');

// Known limitation: hardcoded to Sergio's installed Edge path — single-machine internal tool, not solved with OS-detection.
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const GAME_PATH = path.join(__dirname, '..', 'outputs', 'recycling-training.html');
const RULES_PATH = path.join(__dirname, '..', 'firestore.rules');
const TEST_BUILDING_ID = 'test-building-1';
const TEST_TENANT_ID = 'test-tenant-1';
const GAME_URL = `${url.pathToFileURL(GAME_PATH).href}?b=${TEST_BUILDING_ID}&emulator=1`;

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

// Deliberately presses Enter on every one of the 10 board items (not just until 5/5),
// so both a real "correct, collected into the bin" and a real "wrong, stays on the
// board" case are guaranteed to happen at least once — used only for phase 0.
async function resolveAllTenItems(page){
  for (let i = 0; i < 10; i++){
    const card = await page.$('.board-item:not([data-test-clicked])');
    if (!card) break;
    await card.evaluate(el => el.setAttribute('data-test-clicked', '1'));
    await card.focus();
    await page.keyboard.press('Enter');
    await new Promise(r => setTimeout(r, 120));
  }
  await new Promise(r => setTimeout(r, 1600)); // let the 1400ms wrong-item settle timer fire
}

async function seedTestBuilding(){
  // NOTE: don't call testEnv.cleanup() here — it wipes the emulator's Firestore data as
  // part of its teardown, which would erase the building we just seeded before the browser
  // ever reads it. Cleanup happens once at the very end, after the browser is done with it.
  //
  // projectId MUST match the real project ID from firebaseConfig in the HTML files — the
  // emulator treats different project IDs as completely separate databases even though
  // they're all running locally, so seeding under a different id would be invisible to the app.
  const testEnv = await initializeTestEnvironment({
    projectId: 'esg-1-98f35',
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'buildings', TEST_BUILDING_ID), { name: 'Test Tower' });
    await setDoc(doc(db, 'buildings', TEST_BUILDING_ID, 'tenants', TEST_TENANT_ID), { name: 'Test Co', levels: ['Level 4', 'Level 5'] });
  });
  return testEnv;
}

async function main(){
  const seedEnv = await seedTestBuilding();

  const browser = await puppeteer.launch({ executablePath: EDGE_PATH, headless: true });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

  try {
    await runFlow(page);
  } catch (err) {
    console.error('CRASHED — dumping diagnostics:', err.message);
    console.error('Console errors so far:', JSON.stringify(consoleErrors, null, 2));
    await page.screenshot({ path: path.join(__dirname, '..', 'debug-crash.png') }).catch(() => {});
    await browser.close();
    process.exit(1);
  }

  // No explicit seedEnv.cleanup() — `firebase emulators:exec` tears down the whole
  // emulator process (and its in-memory data) once this script exits either way.
  await finishAndReport(page, browser, consoleErrors);
}

async function runFlow(page){

  // --- Invalid-link fallback still works with a bogus buildingId ---
  // This is the very first Firestore call of the whole test run, right after a fresh emulator
  // start — cold-start connection setup made 400ms an unreliable margin (started failing
  // intermittently later in this project's life without any change to the gate logic itself).
  await page.goto(`${url.pathToFileURL(GAME_PATH).href}?b=no-such-building&emulator=1`, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 1200));
  check('id-gate shows invalid-link fallback for a buildingId that does not exist',
    await page.$eval('#idCardInvalid', el => getComputedStyle(el).display !== 'none'));

  // --- Real gate flow with a seeded, valid building ---
  await page.goto(GAME_URL, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 500));
  check('id-gate form is shown for a valid, seeded building',
    await page.$eval('#idCardForm', el => getComputedStyle(el).display !== 'none'));
  const buildingNameShown = await page.$eval('#idBuildingNameInline', el => el.textContent.trim());
  check('building name fetched from Firestore is shown in the gate', buildingNameShown === 'Test Tower', buildingNameShown);

  const tenantOptions = await page.$$eval('#idTenant option', opts => opts.map(o => o.value).filter(Boolean));
  check('tenant dropdown populated from the seeded tenant', tenantOptions.includes(TEST_TENANT_ID), tenantOptions.join('|'));

  await page.type('#idName', 'Jane Doe');
  await page.type('#idEmail', 'jane@example.com');
  await page.select('#idTenant', TEST_TENANT_ID);
  await new Promise(r => setTimeout(r, 200));
  const levelOptions = await page.$$eval('#idLevel option', opts => opts.map(o => o.value).filter(Boolean));
  check('level dropdown populated for the selected tenant (2 levels -> picker shown)', levelOptions.length === 2, levelOptions.join('|'));
  await page.select('#idLevel', 'Level 5');
  await page.click('#idForm button[type=submit]');
  await new Promise(r => setTimeout(r, 300));
  check('mainApp is shown after a valid gate submit',
    await page.$eval('#mainApp', el => getComputedStyle(el).display !== 'none'));

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

  // Phase 0: press every card (not just until 5/5) so both outcomes are exercised,
  // then check the new "collected tray" + "wrong items stay on the board" behavior
  // before moving on.
  await resolveAllTenItems(page);
  const collectedCount = await page.$$eval('#binCollected .collected-icon', els => els.length);
  check('collected tray shows 5 mini-icons for the 5 correctly-sorted items', collectedCount === 5, collectedCount);

  const resolvedWrongCount = await page.$$eval('.board-item.resolved-wrong', els => els.length);
  check('at least one wrongly-dropped item stays on the board (does not disappear)', resolvedWrongCount > 0, resolvedWrongCount);

  if (resolvedWrongCount > 0){
    const wrongCardChecks = await page.$eval('.board-item.resolved-wrong', el => ({
      badgeVisible: getComputedStyle(el.querySelector('.reveal-badge')).display !== 'none',
      hasBorderColor: el.style.borderColor !== '',
      dimmed: parseFloat(getComputedStyle(el.querySelector('.item-icon')).opacity) < 1,
    }));
    check('resolved-wrong card shows its reveal badge (which stream it belongs to)', wrongCardChecks.badgeVisible);
    check('resolved-wrong card has a stream-colored border set', wrongCardChecks.hasBorderColor);
    check('resolved-wrong card icon is visually dimmed, not full-strength', wrongCardChecks.dimmed);

    const stillClickable = await page.evaluate(() => {
      const card = document.querySelector('.board-item.resolved-wrong');
      const before = document.getElementById('phaseCounter').textContent;
      card.focus();
      card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return document.getElementById('phaseCounter').textContent === before;
    });
    check('a resolved-wrong card ignores further interaction (no double-processing)', stillClickable);
  }

  await page.click('#nextPhaseBtn');
  await new Promise(r => setTimeout(r, 300));

  let phasesCompleted = 1;
  for (let phase = 1; phase < 5; phase++){
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

  const reviewOrderClasses = await page.$$eval('#reviewList .review-item', els => els.map(el => (el.classList.contains('wrong') ? 'wrong' : 'right')));
  const lastWrongIdx = reviewOrderClasses.lastIndexOf('wrong');
  const firstRightIdx = reviewOrderClasses.indexOf('right');
  check('review list shows mistakes before correct answers',
    lastWrongIdx === -1 || firstRightIdx === -1 || lastWrongIdx < firstRightIdx,
    reviewOrderClasses.join(','));

  // Real, valid data + real emulator + real rules -> the save should actually succeed this time.
  await new Promise(r => setTimeout(r, 500));
  check('save SUCCEEDS against the emulator with valid gate data (no warning banner shown)',
    await page.$eval('#saveWarning', el => getComputedStyle(el).display === 'none'));
}

async function finishAndReport(page, browser, consoleErrors){
  check('no unexpected console/page errors across the full run', consoleErrors.length === 0, consoleErrors.join(' || '));

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
