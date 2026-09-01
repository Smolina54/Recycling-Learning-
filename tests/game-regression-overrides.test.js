// Verifies the per-building item-stream override engine added in Milestone 1
// (see the plan at C:\Users\smolina\.claude\plans\serene-dreaming-puppy.md):
// a building with a custom `itemOverrides` config still runs all 5 phases,
// a stream left with zero native items has a correct-target of 0 (not fewer
// phases), the score denominator stays 25, decoys are deterministic per
// config (not random), and the config is stamped onto the submission.
// Run: npm run test:overrides (wraps this in `firebase emulators:exec`).
const path = require('path');
const url = require('url');
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc, collection, getDocs, query, where } = require('firebase/firestore');

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const GAME_PATH = path.join(__dirname, '..', 'outputs', 'recycling-training.html');
const RULES_PATH = path.join(__dirname, '..', 'firestore.rules');
const TEST_BUILDING_ID = 'test-tower-overrides';
const TEST_TENANT_ID = 'test-tenant-overrides';
const GAME_URL = `${url.pathToFileURL(GAME_PATH).href}?b=${TEST_BUILDING_ID}&emulator=1`;

// A second building for Milestone 4 (ideal-vs-acceptable): pc-box keeps its default primary
// (pc) but also becomes acceptable in mr — Sergio's "paper is best in Paper & Cardboard, but
// also technically fine in Mixed Recycling" example.
const ACCEPTABLE_BUILDING_ID = 'test-tower-acceptable';
const ACCEPTABLE_TENANT_ID = 'test-tenant-acceptable';
const ACCEPTABLE_GAME_URL = `${url.pathToFileURL(GAME_PATH).href}?b=${ACCEPTABLE_BUILDING_ID}&emulator=1`;
const ACCEPTABLE_ITEM_OVERRIDES = {
  'pc-box': { stream: 'pc', acceptable: ['mr'] },
};

// pc's 5 items redirected to mr — the exact "no Paper & Cardboard bin" case that started this.
const ITEM_OVERRIDES = {
  'pc-box': { stream: 'mr' },
  'pc-paper': { stream: 'mr' },
  'pc-envelope': { stream: 'mr' },
  'pc-newspaper': { stream: 'mr' },
  'pc-tube': { stream: 'mr' },
};
const STREAM_ORDER = ['gw', 'mr', 'pc', 'og', 'ew'];

const results = [];
function check(label, cond, extra){ results.push({label, ok: Boolean(cond), extra: extra || ''}); }

async function resolvePhase(page, maxClicks){
  for (let i = 0; i < maxClicks; i++){
    const nextVisible = await page.$eval('#nextPhaseBtn', el => getComputedStyle(el).display !== 'none').catch(() => false);
    if (nextVisible) return true;
    const card = await page.$('.board-item:not(.locked):not([data-test-clicked])');
    if (!card) return false;
    await card.evaluate(el => el.setAttribute('data-test-clicked', '1'));
    await card.focus();
    await page.keyboard.press('Enter');
    await new Promise(r => setTimeout(r, 100));
  }
  return await page.$eval('#nextPhaseBtn', el => getComputedStyle(el).display !== 'none').catch(() => false);
}

async function seedTestBuilding(){
  const testEnv = await initializeTestEnvironment({
    projectId: 'esg-1-98f35',
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'buildings', TEST_BUILDING_ID), { name: 'Test Tower Overrides', itemOverrides: ITEM_OVERRIDES });
    await setDoc(doc(db, 'buildings', TEST_BUILDING_ID, 'tenants', TEST_TENANT_ID), { name: 'Test Co', levels: ['Level 1'] });
    await setDoc(doc(db, 'buildings', ACCEPTABLE_BUILDING_ID), { name: 'Test Tower Acceptable', itemOverrides: ACCEPTABLE_ITEM_OVERRIDES });
    await setDoc(doc(db, 'buildings', ACCEPTABLE_BUILDING_ID, 'tenants', ACCEPTABLE_TENANT_ID), { name: 'Test Co', levels: ['Level 1'] });
  });
  return testEnv;
}

async function passIdGate(page, email, gameUrl, tenantId){
  await page.goto(gameUrl, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 500));
  await page.type('#idName', 'Jane Doe');
  await page.type('#idEmail', email);
  await page.select('#idTenant', tenantId);
  await new Promise(r => setTimeout(r, 200));
  await page.select('#idLevel', 'Level 1');
  await page.click('#idForm button[type=submit]');
  await new Promise(r => setTimeout(r, 300));
}

async function main(){
  await seedTestBuilding();

  const browser = await puppeteer.launch({ executablePath: EDGE_PATH, headless: true });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', async (msg) => {
    if (msg.type() !== 'error') return;
    const parts = await Promise.all(msg.args().map(async (a) => {
      try { return await a.evaluate(v => (v && v.message) ? v.message + (v.stack ? '\n' + v.stack : '') : JSON.stringify(v)); }
      catch { return msg.text(); }
    }));
    consoleErrors.push(parts.join(' '));
  });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

  try {
    await runFlow(page);
    await runAcceptableFlow(browser, consoleErrors);
  } catch (err) {
    console.error('CRASHED — dumping diagnostics:', err.message);
    console.error('Console errors so far:', JSON.stringify(consoleErrors, null, 2));
    await page.screenshot({ path: path.join(__dirname, '..', 'debug-crash.png') }).catch(() => {});
    await browser.close();
    process.exit(1);
  }

  await finishAndReport(page, browser, consoleErrors);
}

async function runFlow(page){
  await passIdGate(page, 'jane-overrides-1@example.com', GAME_URL, TEST_TENANT_ID);
  check('mainApp is shown after a valid gate submit for a building with overrides',
    await page.$eval('#mainApp', el => getComputedStyle(el).display !== 'none'));

  const tabs = await page.$$('.bin-tab');
  check('still 5 walkthrough tabs even with a redirected stream', tabs.length === 5, tabs.length);
  for (const tab of tabs){ await tab.click(); await new Promise(r => setTimeout(r, 80)); }
  await new Promise(r => setTimeout(r, 200));

  const pcNoteText = await page.$eval('.building-note[data-stream="pc"]', el => el.textContent).catch(() => '');
  check('the Paper & Cardboard walkthrough panel shows a dynamic note explaining the redirect',
    pcNoteText.includes('Mixed Recycling') && pcNoteText.length > 0, pcNoteText);
  const mrNoteText = await page.$eval('.building-note[data-stream="mr"]', el => el.textContent).catch(() => '');
  check('the Mixed Recycling walkthrough panel shows a dynamic note explaining what it absorbed',
    mrNoteText.includes('Paper & Cardboard') && mrNoteText.length > 0, mrNoteText);
  const gwNoteText = await page.$eval('.building-note[data-stream="gw"]', el => el.textContent).catch(() => '');
  check('an unaffected stream (General Waste) shows no note at all',
    gwNoteText === '', gwNoteText);

  await page.click('#startGameBtn');
  await new Promise(r => setTimeout(r, 300));

  // --- First full playthrough: capture the gw-phase board's item set for the determinism check later ---
  let firstGwBoardIds = null;
  let phasesCompleted = 0;
  for (let i = 0; i < 5; i++){
    const stream = STREAM_ORDER[i];
    const counter = await page.$eval('#phaseCounter', el => el.textContent).catch(() => '');

    if (stream === 'gw'){
      firstGwBoardIds = (await page.$$eval('.board-item', els => els.map(el => el.dataset.id))).slice().sort();
    }
    if (stream === 'pc'){
      check('the redirected stream (pc) shows a correct-target of 0, not a missing phase',
        counter === 'Sorted 0 of 0', counter);
      const nextVisibleImmediately = await page.$eval('#nextPhaseBtn', el => getComputedStyle(el).display !== 'none');
      check('a 0-target phase auto-completes immediately (no drag required to proceed)', nextVisibleImmediately);
      const boardCount = await page.$$eval('.board-item', els => els.length);
      check('a 0-target phase still shows 5 decoys on the board (still tested, still scored)', boardCount === 5, boardCount);
      const phaseNoteText = await page.$eval('#phaseBuildingNote', el => el.textContent).catch(() => '');
      check('the 0-target phase shows the same recap note as the walkthrough (still teaches the category)',
        phaseNoteText.includes('Mixed Recycling') && phaseNoteText.length > 0, phaseNoteText);
    }
    if (stream === 'mr'){
      check('mixed recycling absorbs the 5 redirected pc items — target becomes 10, not 5',
        counter === 'Sorted 0 of 10', counter);
    }

    const reached = await resolvePhase(page, 25);
    if (!reached) break;
    phasesCompleted++;
    await page.click('#nextPhaseBtn');
    await new Promise(r => setTimeout(r, 300));
  }
  check('all 5 phases (including the redirected one) were reached and advanced', phasesCompleted === 5, phasesCompleted);

  await new Promise(r => setTimeout(r, 300));
  check('results screen is active after the 5th phase',
    await page.$eval('#results', el => el.classList.contains('active')).catch(() => false));

  const scoreOfText = await page.$eval('#scoreOf', el => el.textContent.trim()).catch(() => '');
  const totalMatch = scoreOfText.match(/\/\s*(\d+)\s*correctly avoided/);
  check('score denominator (total) is still exactly 25, same as every other building',
    totalMatch && totalMatch[1] === '25', scoreOfText);

  const reviewCards = await page.$$eval('#reviewList .review-stream-card', els => els.length).catch(() => 0);
  check('review list still renders exactly 5 per-stream cards', reviewCards === 5, reviewCards);

  const pcCardCorrectCount = await page.evaluate(() => {
    const card = [...document.querySelectorAll('.review-stream-card')].find(c => c.querySelector('.review-stream-name').textContent === 'Paper & Cardboard');
    return card ? card.querySelectorAll('.review-correct-row .item-thumb').length : -1;
  });
  check('the Paper & Cardboard review card shows 0 correct items (nothing effective there for this building)',
    pcCardCorrectCount === 0, pcCardCorrectCount);

  // --- Second, independent playthrough: same building, confirm decoys are deterministic ---
  const page2 = await page.browser().newPage();
  await passIdGate(page2, 'jane-overrides-2@example.com', GAME_URL, TEST_TENANT_ID);
  const tabs2 = await page2.$$('.bin-tab');
  for (const tab of tabs2){ await tab.click(); await new Promise(r => setTimeout(r, 60)); }
  await new Promise(r => setTimeout(r, 150));
  await page2.click('#startGameBtn');
  await new Promise(r => setTimeout(r, 300));
  const secondGwBoardIds = (await page2.$$eval('.board-item', els => els.map(el => el.dataset.id))).slice().sort();
  await page2.close();

  check('the gw phase board is identical across two separate trainees at the same building (deterministic, not random)',
    JSON.stringify(firstGwBoardIds) === JSON.stringify(secondGwBoardIds),
    `run1: ${firstGwBoardIds.join(',')} | run2: ${secondGwBoardIds.join(',')}`);

  // --- Confirm the submission written to Firestore carries the config snapshot ---
  const verifyEnv = await initializeTestEnvironment({
    projectId: 'esg-1-98f35',
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  let snapshotOk = false;
  await verifyEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    const q = query(collection(db, 'submissions'), where('email', '==', 'jane-overrides-1@example.com'));
    const snap = await getDocs(q);
    if (snap.empty) return;
    const data = snap.docs[0].data();
    let parsed = null;
    try { parsed = JSON.parse(data.itemOverridesSnapshot || '{}'); } catch { parsed = null; }
    snapshotOk = Boolean(parsed && parsed['pc-box'] && parsed['pc-box'].stream === 'mr');
  });
  check('the submission stores a snapshot of the config that was active when it was taken', snapshotOk);
}

// Milestone 4 (ideal-vs-acceptable): pc-box stays primary/ideal in pc, but is ALSO acceptable
// in mr for this building — confirms the item deliberately appears in both phases, both count
// as fully correct (no scored distinction), and only the feedback text differs.
async function runAcceptableFlow(browser, consoleErrors){
  const page = await browser.newPage();
  page.on('console', async (msg) => {
    if (msg.type() !== 'error') return;
    const parts = await Promise.all(msg.args().map(async (a) => {
      try { return await a.evaluate(v => (v && v.message) ? v.message + (v.stack ? '\n' + v.stack : '') : JSON.stringify(v)); }
      catch { return msg.text(); }
    }));
    consoleErrors.push('[acceptable-flow] ' + parts.join(' '));
  });
  page.on('pageerror', (err) => consoleErrors.push('[acceptable-flow] pageerror: ' + err.message));

  await passIdGate(page, 'jane-acceptable@example.com', ACCEPTABLE_GAME_URL, ACCEPTABLE_TENANT_ID);
  const tabs = await page.$$('.bin-tab');
  for (const tab of tabs){ await tab.click(); await new Promise(r => setTimeout(r, 80)); }
  await new Promise(r => setTimeout(r, 200));
  await page.click('#startGameBtn');
  await new Promise(r => setTimeout(r, 300));

  for (let i = 0; i < 5; i++){
    const stream = STREAM_ORDER[i];
    const counter = await page.$eval('#phaseCounter', el => el.textContent).catch(() => '');
    const boardIds = await page.$$eval('.board-item', els => els.map(el => el.dataset.id));

    if (stream === 'mr'){
      check('mr phase target grows by 1 for the item that is only acceptable (not primary) here',
        counter === 'Sorted 0 of 6', counter);
      check('pc-box (acceptable here, primary elsewhere) appears on the mr board',
        boardIds.includes('pc-box'), boardIds.join(','));

      const pcBoxCard = await page.$('.board-item[data-id="pc-box"]');
      await pcBoxCard.evaluate(el => el.setAttribute('data-test-clicked', '1'));
      await pcBoxCard.focus();
      await page.keyboard.press('Enter');
      // collectIntoBin()'s fly-to-bin animation removes the card and appends its collected
      // icon after a fixed 420ms — must outwait that before checking either.
      await new Promise(r => setTimeout(r, 600));
      const acceptableFeedback = await page.$eval('#gameFeedback', el => el.textContent);
      check('dropping pc-box into its acceptable-but-not-ideal bin gives distinct feedback text, still marked correct',
        acceptableFeedback.includes('this works too') && acceptableFeedback.includes('Paper & Cardboard'),
        acceptableFeedback);
      const collectedAfterAcceptable = await page.$$eval('#binCollected .collected-icon', els => els.length);
      check('the acceptable-drop was collected as correct, not left on the board as wrong', collectedAfterAcceptable === 1, collectedAfterAcceptable);
    }

    if (stream === 'pc'){
      check('pc phase target is unaffected — pc-box is still counted as primary/ideal here too', counter === 'Sorted 0 of 5', counter);
      check('pc-box ALSO appears on its own ideal-stream board (deliberate double-appearance)',
        boardIds.includes('pc-box'), boardIds.join(','));

      const pcBoxCard = await page.$('.board-item[data-id="pc-box"]');
      await pcBoxCard.evaluate(el => el.setAttribute('data-test-clicked', '1'));
      await pcBoxCard.focus();
      await page.keyboard.press('Enter');
      await new Promise(r => setTimeout(r, 600));
      const idealFeedback = await page.$eval('#gameFeedback', el => el.textContent);
      check('dropping pc-box into its ideal bin gives the plain "Correct" message, no "this works too" caveat',
        idealFeedback.includes('Correct.') && !idealFeedback.includes('this works too'), idealFeedback);
    }

    const reached = await resolvePhase(page, 25);
    if (!reached) break;
    // Let any still-in-flight collectIntoBin() fly-to-bin animation (420ms) from the last
    // correct drop finish BEFORE advancing — otherwise its delayed DOM mutation can land
    // after the next phase's startPhase() has already cleared #binCollected for the new
    // phase, leaking a stray icon into it (a pre-existing animation/phase-transition race,
    // unrelated to the override work — worth a fix of its own later, not chased down here).
    await new Promise(r => setTimeout(r, 500));
    await page.click('#nextPhaseBtn');
    await new Promise(r => setTimeout(r, 300));
  }

  await new Promise(r => setTimeout(r, 300));
  const scoreOfText = await page.$eval('#scoreOf', el => el.textContent.trim()).catch(() => '');
  const totalMatch = scoreOfText.match(/\/\s*(\d+)\s*correctly avoided/);
  check('total stays exactly 25 even with an acceptable-but-not-ideal entry in the config',
    totalMatch && totalMatch[1] === '25', scoreOfText);

  await page.close();
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
