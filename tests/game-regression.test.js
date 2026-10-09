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
const { doc, setDoc, getDocs, collection, query, where } = require('firebase/firestore');

// Known limitation: hardcoded to Sergio's installed Edge path — single-machine internal tool, not solved with OS-detection.
// Override via TEST_BROWSER_PATH if this machine's security software blocks Edge automation
// (e.g. a corporate EDR flagging --remote-debugging-port on msedge.exe specifically).
const EDGE_PATH = process.env.TEST_BROWSER_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const GAME_PATH = path.join(__dirname, '..', 'outputs', 'recycling-training.html');
const RULES_PATH = path.join(__dirname, '..', 'firestore.rules');
const TEST_BUILDING_ID = 'test-building-1';
const TEST_TENANT_ID = 'test-tenant-1';
const GAME_URL = `${url.pathToFileURL(GAME_PATH).href}?b=${TEST_BUILDING_ID}&emulator=1`;

// --- Real Bintracker recycling-level banner (Workstream 7 Point 5 sub-idea, 2026-09-24) ---
// A separate building from TEST_BUILDING_ID above (kept apart on purpose - the main flow's own
// building has no recyclingLevelPct at all, and mixing scenarios into it would make that
// assumption fragile) with a building-level recyclingLevelPct (>=75%, "on track" framing) and two
// tenants: one with its OWN recyclingLevelPct (<75%, "needs improvement" framing, deliberately
// different from the building's number so a tenant-scoped view showing the WRONG number would be
// caught), and one with no recyclingLevelPct field at all (the graceful-absence case). Three
// links exercise the three scopes the id-gate actually reads: whole-building, tenant-scoped with
// a qualifying value, and tenant-scoped with none.
const BANNER_BUILDING_ID = 'test-building-banner-' + Date.now();
const BANNER_TENANT_LOW_ID = 'test-tenant-banner-low-' + Date.now();
const BANNER_TENANT_NONE_ID = 'test-tenant-banner-none-' + Date.now();
const BANNER_LINK_WHOLE_ID = 'test-link-banner-whole-' + Date.now();
const BANNER_LINK_TENANT_LOW_ID = 'test-link-banner-tenant-low-' + Date.now();
const BANNER_LINK_TENANT_NONE_ID = 'test-link-banner-tenant-none-' + Date.now();
const BANNER_BUILDING_PCT = 82; // >= 75 -> "on track" framing
const BANNER_TENANT_LOW_PCT = 55; // < 75 -> "needs improvement" framing, and != BANNER_BUILDING_PCT
const GAME_URL_BANNER_WHOLE = `${url.pathToFileURL(GAME_PATH).href}?l=${BANNER_LINK_WHOLE_ID}&emulator=1`;
const GAME_URL_BANNER_TENANT_LOW = `${url.pathToFileURL(GAME_PATH).href}?l=${BANNER_LINK_TENANT_LOW_ID}&emulator=1`;
const GAME_URL_BANNER_TENANT_NONE = `${url.pathToFileURL(GAME_PATH).href}?l=${BANNER_LINK_TENANT_NONE_ID}&emulator=1`;

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

// Deliberately presses Enter on every board item (not just until the phase target is
// reached), so both a real "correct, collected into the bin" and a real "wrong, stays on
// the board" case are guaranteed to happen at least once — used only for phase 0. Not
// hardcoded to a specific board size — General Waste's board grows/shrinks with its catalog
// roster (e.g. it picked up "Used tea bag" in the 2026-09-02 content correction).
async function resolveAllBoardItems(page){
  for (let i = 0; i < 30; i++){
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
    // A building needs an enrollment doc to be treated as enrolled at all — initIdGate()
    // now gates access on this, not just on the building doc existing.
    await setDoc(doc(db, 'enrollments', `recycling-sorting__${TEST_BUILDING_ID}`), {
      programId: 'recycling-sorting', buildingId: TEST_BUILDING_ID, itemOverrides: {},
    });

    // --- Recycling-level banner fixtures (see the BANNER_* constants above) ---
    await setDoc(doc(db, 'buildings', BANNER_BUILDING_ID), { name: 'Banner Tower', recyclingLevelPct: BANNER_BUILDING_PCT });
    await setDoc(doc(db, 'buildings', BANNER_BUILDING_ID, 'tenants', BANNER_TENANT_LOW_ID), {
      name: 'Low Recycling Co', levels: ['Level 1'], recyclingLevelPct: BANNER_TENANT_LOW_PCT,
    });
    await setDoc(doc(db, 'buildings', BANNER_BUILDING_ID, 'tenants', BANNER_TENANT_NONE_ID), {
      name: 'No Data Co', levels: ['Level 1'],
    });
    await setDoc(doc(db, 'enrollments', `recycling-sorting__${BANNER_BUILDING_ID}`), {
      programId: 'recycling-sorting', buildingId: BANNER_BUILDING_ID, itemOverrides: {},
    });
    await setDoc(doc(db, 'links', BANNER_LINK_WHOLE_ID), { programId: 'recycling-sorting', buildingId: BANNER_BUILDING_ID, tenantId: null });
    await setDoc(doc(db, 'links', BANNER_LINK_TENANT_LOW_ID), { programId: 'recycling-sorting', buildingId: BANNER_BUILDING_ID, tenantId: BANNER_TENANT_LOW_ID });
    await setDoc(doc(db, 'links', BANNER_LINK_TENANT_NONE_ID), { programId: 'recycling-sorting', buildingId: BANNER_BUILDING_ID, tenantId: BANNER_TENANT_NONE_ID });
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
    await runFlow(page, seedEnv);
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

async function runFlow(page, seedEnv){

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
  // initIdGate() now does an extra Firestore round-trip (the enrollment-gate check added by
  // the multi-program retrofit) before the form is populated — same reasoning as the
  // 400ms->1200ms fix just above for the invalid-link case: wait for the real tenant option
  // to actually exist rather than guessing how long the round-trip takes.
  await page.waitForFunction(
    () => document.querySelector('#idTenant option[value]:not([value=""])') !== null,
    { timeout: 10000 }
  );
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
  const levelPreSelected = await page.$eval('#idLevel', el => el.value);
  check('with multiple levels, none is silently pre-selected — the trainee must actually choose one',
    levelPreSelected === '', `pre-selected value: "${levelPreSelected}"`);
  await page.select('#idLevel', 'Level 5');

  // --- Malformed email: rejected inline, before ever touching mainApp/Firestore (Workstream 3,
  // Item D) — the id-gate form used to have no format check at all beyond a neutered `novalidate`
  // type="email" attribute. Everything else on the form (name/tenant/level) is already
  // correctly filled in at this point — only the email is temporarily broken, then fixed. ---
  await page.$eval('#idEmail', el => { el.value = ''; });
  await page.type('#idEmail', 'not-an-email');
  await page.click('#idForm button[type=submit]');
  check('a malformed email is rejected inline, with a visible error message',
    await page.$eval('#idEmailError', el => getComputedStyle(el).display !== 'none'));
  check('mainApp is NOT shown after a malformed-email submit',
    await page.$eval('#mainApp', el => getComputedStyle(el).display === 'none'));

  await page.$eval('#idEmail', el => { el.value = ''; });
  await page.type('#idEmail', 'jane@example.com');
  await page.click('#idForm button[type=submit]');
  await new Promise(r => setTimeout(r, 300));
  check('mainApp is shown after a valid gate submit',
    await page.$eval('#mainApp', el => getComputedStyle(el).display !== 'none'));

  const tabs = await page.$$('.bin-tab');
  check('found 5 stream tabs', tabs.length === 5, tabs.length);
  // 600ms, not a token delay - showStream()'s scrollIntoView({behavior:'smooth'}) animation takes
  // longer than the 80ms this used to wait, and a puppeteer click mid-animation can land on an
  // element Chromium considers "not clickable" (still mid-scroll) and throw - found 2026-10-01.
  for (const tab of tabs){ await tab.click(); await new Promise(r => setTimeout(r, 600)); }
  await new Promise(r => setTimeout(r, 200));
  check('"Begin the sort" enabled after visiting all 5 streams',
    await page.$eval('#startGameBtn', el => !el.disabled));

  await page.click('#startGameBtn');
  await new Promise(r => setTimeout(r, 300));
  check('game stage visible after clicking Begin the sort',
    await page.$eval('#gameStage', el => getComputedStyle(el).display !== 'none'));

  // Workstream 22 (2026-10-09): the board must lay out as a fixed 2 rows of 5 on desktop (not a
  // variable column count that depends on viewport width), and must never reflow when an item is
  // correctly collected (the old behavior removed the card from the DOM, which made CSS Grid
  // auto-placement shift every remaining item - a real complaint: it forced trainees to re-scan
  // the whole board after every correct drop).
  const gridColumnCount = await page.$eval('#itemBoard', el =>
    getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/).length);
  check('item board renders exactly 5 grid columns on desktop', gridColumnCount === 5, gridColumnCount);

  // Positions are captured RELATIVE to the board container, not the page - the board's own
  // absolute page position can legitimately shift as feedback messages appear/grow elsewhere on
  // the page during play, which has nothing to do with whether items reflow WITHIN the grid.
  const initialPositions = await page.$$eval('#itemBoard .board-item', els => {
    const boardRect = els[0].closest('#itemBoard').getBoundingClientRect();
    return els.map(el => {
      const r = el.getBoundingClientRect();
      return { id: el.dataset.id, top: r.top - boardRect.top, left: r.left - boardRect.left };
    });
  });
  const rowTops = [...new Set(initialPositions.map(p => Math.round(p.top)))];
  check('phase 0\'s 10 items render as exactly 2 rows', rowTops.length === 2, JSON.stringify(rowTops));
  check('...with 5 items per row', initialPositions.length === 10 &&
    rowTops.every(top => initialPositions.filter(p => Math.round(p.top) === top).length === 5),
    JSON.stringify(initialPositions.map(p => Math.round(p.top))));

  // Phase 0: press every card (not just until 5/5) so both outcomes are exercised,
  // then check the new "collected tray" + "wrong items stay on the board" behavior
  // before moving on.
  await resolveAllBoardItems(page);
  const collectedCount = await page.$$eval('#binCollected .collected-icon', els => els.length);
  check('collected tray shows 5 mini-icons for the 5 correctly-sorted items', collectedCount === 5, collectedCount);

  // The 5 correctly-collected items must still exist in the DOM (hidden, not removed), and every
  // item that was NOT collected (the resolved-wrong ones still on the board) must be at the exact
  // same position it started at - proving collecting an item never reflows the rest of the board.
  const collectedCards = await page.$$eval('#itemBoard .board-item.collected', els =>
    els.map(el => ({ id: el.dataset.id, pointerEvents: getComputedStyle(el).pointerEvents, opacity: parseFloat(getComputedStyle(el).opacity) })));
  check('exactly 5 collected cards remain in the DOM (hidden, not removed)', collectedCards.length === 5, collectedCards.length);
  check('every collected card is non-interactive (pointer-events:none) and invisible (opacity 0)',
    collectedCards.every(c => c.pointerEvents === 'none' && c.opacity === 0), JSON.stringify(collectedCards));

  const positionsAfterCollecting = await page.$$eval('#itemBoard .board-item:not(.collected)', els => {
    const boardRect = els[0].closest('#itemBoard').getBoundingClientRect();
    return els.map(el => {
      const r = el.getBoundingClientRect();
      return { id: el.dataset.id, top: r.top - boardRect.top, left: r.left - boardRect.left };
    });
  });
  // Compare by grid CELL (row-rank + exact left/column), not raw pixel "top" - a wrongly-dropped
  // item's reveal-badge legitimately makes its own row a little taller once resolved-wrong, which
  // nudges every row below it down by a few pixels (unrelated to this fix - it already happened
  // before this change too, for items that stayed on the board). What must never happen is an
  // item moving to a DIFFERENT column (left) or jumping to a different row relative to the others.
  const rowRank = (positions, top) => [...new Set(positions.map(p => Math.round(p.top)))].sort((a, b) => a - b).indexOf(Math.round(top));
  const stillInPlace = positionsAfterCollecting.every(after => {
    const before = initialPositions.find(p => p.id === after.id);
    return before && Math.round(before.left) === Math.round(after.left)
      && rowRank(initialPositions, before.top) === rowRank(positionsAfterCollecting, after.top);
  });
  check('every still-on-the-board item keeps its original column and relative row (collecting others never reflowed the board)',
    stillInPlace, JSON.stringify({ before: initialPositions, after: positionsAfterCollecting }));

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
  let staleIconLeakedAnywhere = false;
  for (let phase = 1; phase < 5; phase++){
    const reachedFive = await resolvePhase(page);
    if (!reachedFive) break;
    phasesCompleted++;
    await page.click('#nextPhaseBtn');
    // Deliberately short — resolvePhase() returns the instant the 5th correct drop completes
    // the phase, which is well before that drop's 420ms fly-to-bin animation finishes. This is
    // the exact real race that used to leak a stray icon into the next phase's tray if its
    // delayed DOM mutation fired after startPhase() had already cleared #binCollected for the
    // new phase (fixed via phaseGeneration in collectIntoBin()). Only applies to phase 1-3's
    // transitions here — phase 4 (the last one) clicks "See results" instead of starting a new
    // phase, so #binCollected is never cleared for it and this check doesn't apply there.
    if (phase < 4){
      await new Promise(r => setTimeout(r, 60));
      const rightAfterTransition = await page.$$eval('#binCollected .collected-icon', els => els.length);
      if (rightAfterTransition !== 0) staleIconLeakedAnywhere = true;
    }
    await new Promise(r => setTimeout(r, 300));
  }
  check('all 5 phases reached 5/5 and advanced', phasesCompleted === 5, phasesCompleted);
  check('no stale collected-icon from the previous phase\'s in-flight animation leaks into a new phase\'s tray',
    !staleIconLeakedAnywhere);

  await new Promise(r => setTimeout(r, 300));
  check('results screen is active after the 5th phase',
    await page.$eval('#results', el => el.classList.contains('active')).catch(() => false));
  const scoreText = await page.$eval('#scorePct', el => el.textContent.trim()).catch(() => '');
  check('score percentage rendered on results screen', /^\d+%$/.test(scoreText), scoreText);
  const breakdownRows = await page.$$eval('#streamBreakdown .breakdown-row', els => els.length).catch(() => 0);
  check('per-stream breakdown rendered 5 rows', breakdownRows === 5, breakdownRows);
  // Review list redesign (2026-08-28): one compact card per stream instead of one flat
  // 25-row list — 5 cards, each covering exactly 5 decoys (correct ones as an icon-only row,
  // wrong ones with a short "where it goes" + a 3-4 word reason).
  const reviewCards = await page.$$eval('#reviewList .review-stream-card', els => els.length).catch(() => 0);
  check('review list rendered 5 per-stream cards (not one flat 25-row list)', reviewCards === 5, reviewCards);

  const cardCounts = await page.$$eval('#reviewList .review-stream-card', cards => cards.map(card => {
    const correctIcons = card.querySelectorAll('.review-correct-row .item-thumb').length;
    const wrongItems = card.querySelectorAll('.review-wrong-item').length;
    return correctIcons + wrongItems;
  }));
  check('each stream card accounts for exactly 5 items (its 5 decoys)',
    cardCounts.every(n => n === 5), cardCounts.join(','));

  // Real bug Sergio caught: cards were grouped by which phase an item was decoy-tested in,
  // not by the item's own real category — so "Paper & Cardboard" could show a phone or coffee
  // grounds (real decoys used to test that bin, not paper themselves). Confirm the fix: the
  // Paper & Cardboard card only ever contains the 5 real paper/cardboard catalog items.
  const REAL_PC_ITEM_NAMES = ['Flattened cardboard box', 'Stack of office paper', 'Used envelope', 'Folded newspaper', 'Shredded paper'];
  const pcCardItemNames = await page.evaluate(() => {
    const card = [...document.querySelectorAll('.review-stream-card')].find(c => c.querySelector('.review-stream-name').textContent === 'Paper & Cardboard');
    const correctNames = [...card.querySelectorAll('.review-correct-row .item-thumb')].map(el => el.title);
    const wrongNames = [...card.querySelectorAll('.review-wrong-name')].map(el => el.textContent);
    return [...correctNames, ...wrongNames];
  });
  check('the Paper & Cardboard card only shows real paper/cardboard items (not a phone, coffee, etc.)',
    pcCardItemNames.length === 5 && pcCardItemNames.every(n => REAL_PC_ITEM_NAMES.includes(n)),
    pcCardItemNames.join(', '));

  const wrongReasons = await page.$$eval('#reviewList .review-wrong-reason', els => els.map(el => el.textContent.trim()));
  check('wrong items show a short reason text (not blank, not the long pre-game explanation)',
    wrongReasons.length === 0 || wrongReasons.every(t => t.length > 0 && t.length < 40),
    wrongReasons.join(' | '));

  const correctRowHasNoText = await page.$eval('#reviewList', el =>
    ![...el.querySelectorAll('.review-correct-row')].some(row => row.textContent.trim().length > 0));
  check('correct items show only icons, no explanatory text next to them', correctRowHasNoText);

  // Real, valid data + real emulator + real rules -> the save should actually succeed this time.
  await new Promise(r => setTimeout(r, 500));
  check('save SUCCEEDS against the emulator with valid gate data (no warning banner shown)',
    await page.$eval('#saveWarning', el => getComputedStyle(el).display === 'none'));

  // One real result per person per building (2026-10-02) - a retake must play through fine but
  // must NOT create a second submissions doc, and must show the practice notice instead of the
  // save-warning banner (that banner means a real failure, which this isn't).
  async function countRealSubmissions(){
    let count = 0;
    await seedEnv.withSecurityRulesDisabled(async (context) => {
      const snap = await getDocs(query(collection(context.firestore(), 'submissions'),
        where('buildingId', '==', TEST_BUILDING_ID), where('email', '==', 'jane@example.com')));
      count = snap.size;
    });
    return count;
  }

  const countAfterFirstRun = await countRealSubmissions();
  check('exactly one real submission exists after the first completion', countAfterFirstRun === 1, countAfterFirstRun);

  await page.click('#retryBtn');
  await new Promise(r => setTimeout(r, 300));
  check('retake restarts the game (game stage visible again)',
    await page.$eval('#gameStage', el => getComputedStyle(el).display !== 'none'));

  await resolveAllBoardItems(page);
  await page.click('#nextPhaseBtn');
  await new Promise(r => setTimeout(r, 300));
  for (let phase = 1; phase < 5; phase++){
    const reachedFive = await resolvePhase(page);
    if (!reachedFive) break;
    await page.click('#nextPhaseBtn');
    await new Promise(r => setTimeout(r, 300));
  }
  await new Promise(r => setTimeout(r, 500));

  check('practice notice shows after a retake past the first real completion',
    await page.$eval('#practiceNotice', el => getComputedStyle(el).display !== 'none').catch(() => false));
  check('save-warning stays hidden on a retake (expected, not a failure)',
    await page.$eval('#saveWarning', el => getComputedStyle(el).display === 'none'));

  const countAfterRetake = await countRealSubmissions();
  check('retake does NOT create a second submissions doc - still exactly one',
    countAfterRetake === 1, countAfterRetake);

  await checkRecyclingLevelBanner(page);
}

// Real Bintracker recycling-level banner (Workstream 7 Point 5 sub-idea, 2026-09-24) - three
// separate navigations (own building/links, see the BANNER_* fixtures above), each just far
// enough into the id-gate flow to read the banner's own DOM, not a full game playthrough.
async function checkRecyclingLevelBanner(page){
  // --- Whole-building link: shows the BUILDING's own recyclingLevelPct (>=75 -> "on track") ---
  await page.goto(GAME_URL_BANNER_WHOLE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.querySelector('#idTenant option[value]:not([value=""])') !== null,
    { timeout: 10000 }
  );
  check('whole-building link: recycling-level banner is shown',
    await page.$eval('#idLevelBanner', el => getComputedStyle(el).display !== 'none'));
  const wholeBuildingPct = await page.$eval('#idLevelBannerPct', el => el.textContent.trim());
  check('whole-building link: banner shows the BUILDING\'s own percentage',
    wholeBuildingPct === `${BANNER_BUILDING_PCT}%`, wholeBuildingPct);
  check('whole-building link: at/above the 75% pass mark uses the "on track" framing, not "needs improvement"',
    !(await page.$eval('#idLevelBanner', el => el.classList.contains('needs-improvement'))));
  const wholeBuildingMsg = await page.$eval('#idLevelBannerMsg', el => el.textContent.trim());
  check('whole-building link: banner message refers to the building, not a company',
    /building/i.test(wholeBuildingMsg) && !/company/i.test(wholeBuildingMsg), wholeBuildingMsg);

  // --- Tenant-scoped link, tenant HAS its own (lower, different-from-building) recyclingLevelPct:
  // shows the TENANT's number, not the building's - proves there's no fallback to the building
  // aggregate on a tenant-scoped link. ---
  await page.goto(GAME_URL_BANNER_TENANT_LOW, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.querySelector('#idTenant option[value]:not([value=""])') !== null,
    { timeout: 10000 }
  );
  check('tenant-scoped link (qualifying tenant data): recycling-level banner is shown',
    await page.$eval('#idLevelBanner', el => getComputedStyle(el).display !== 'none'));
  const tenantPct = await page.$eval('#idLevelBannerPct', el => el.textContent.trim());
  check('tenant-scoped link: banner shows the TENANT\'s own percentage, not the building\'s',
    tenantPct === `${BANNER_TENANT_LOW_PCT}%` && tenantPct !== `${BANNER_BUILDING_PCT}%`, tenantPct);
  check('tenant-scoped link: below the 75% pass mark uses the "needs improvement" framing',
    await page.$eval('#idLevelBanner', el => el.classList.contains('needs-improvement')));
  const tenantMsg = await page.$eval('#idLevelBannerMsg', el => el.textContent.trim());
  check('tenant-scoped link: banner message refers to the trainee\'s company, not the building',
    /company/i.test(tenantMsg) && !/building/i.test(tenantMsg), tenantMsg);

  // --- Tenant-scoped link, tenant has NO recyclingLevelPct at all: banner must be hidden
  // entirely - even though the BUILDING this tenant belongs to has a qualifying number, it must
  // never be shown as a substitute (the plan's explicit "no fallback" decision). ---
  await page.goto(GAME_URL_BANNER_TENANT_NONE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.querySelector('#idTenant option[value]:not([value=""])') !== null,
    { timeout: 10000 }
  );
  check('tenant-scoped link with no recyclingLevelPct on the tenant: banner is hidden (no fallback to the building\'s number)',
    await page.$eval('#idLevelBanner', el => getComputedStyle(el).display === 'none'));
}

async function finishAndReport(page, browser, consoleErrors){
  // Same benign-noise allow-list every other test file in this suite uses — kept in sync so a
  // legitimately harmless resource/network log doesn't fail the whole run here while every
  // other file already tolerates it.
  const unexpectedErrors = consoleErrors.filter(e => !e.includes('Failed to load resource') && !e.includes('400'));
  check('no unexpected console/page errors across the full run', unexpectedErrors.length === 0, unexpectedErrors.join(' || '));

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
