// Smoke test for outputs/organics-training.html (the first specialized induction, see the
// multi-program plan): id-gate -> enrollment gate -> full single-phase playthrough ->
// submission written with programId 'organics-focus'. Not a full parallel of
// game-regression.test.js's depth — this is a new, still-evolving page (Sergio's own framing:
// "igual son demos") — just enough to prove the reused engine actually works end to end here.
// Run: npm run test:organics
const path = require('path');
const url = require('url');
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc, collection, getDocs, query, where } = require('firebase/firestore');

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const GAME_PATH = path.join(__dirname, '..', 'outputs', 'organics-training.html');
const RULES_PATH = path.join(__dirname, '..', 'firestore.rules');
const ENROLLED_BUILDING_ID = 'test-tower-organics';
const ENROLLED_TENANT_ID = 'test-tenant-organics';
const NOT_ENROLLED_BUILDING_ID = 'test-tower-recycling-only';
const NOT_ENROLLED_TENANT_ID = 'test-tenant-recycling-only';

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

async function seedBuildings(){
  const testEnv = await initializeTestEnvironment({
    projectId: 'esg-1-98f35',
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'programs', 'organics-focus'), { name: 'Organics Focus', file: 'organics-training.html', kind: 'game', status: 'active' });

    await setDoc(doc(db, 'buildings', ENROLLED_BUILDING_ID), { name: 'Test Tower Organics' });
    await setDoc(doc(db, 'buildings', ENROLLED_BUILDING_ID, 'tenants', ENROLLED_TENANT_ID), { name: 'Test Co', levels: ['Level 1'] });
    await setDoc(doc(db, 'enrollments', `organics-focus__${ENROLLED_BUILDING_ID}`), {
      programId: 'organics-focus', buildingId: ENROLLED_BUILDING_ID, itemOverrides: {},
    });

    // Enrolled in Recycling only — proves organics-training.html's own enrollment gate is
    // real, not just "does the building exist at all" (the exact regression this plan called
    // out: a ?b= valid for one program must not silently work on another).
    await setDoc(doc(db, 'buildings', NOT_ENROLLED_BUILDING_ID), { name: 'Test Tower Recycling Only' });
    await setDoc(doc(db, 'buildings', NOT_ENROLLED_BUILDING_ID, 'tenants', NOT_ENROLLED_TENANT_ID), { name: 'Test Co', levels: ['Level 1'] });
    await setDoc(doc(db, 'enrollments', `recycling-sorting__${NOT_ENROLLED_BUILDING_ID}`), {
      programId: 'recycling-sorting', buildingId: NOT_ENROLLED_BUILDING_ID, itemOverrides: {},
    });
  });
  return testEnv;
}

async function main(){
  const seedEnv = await seedBuildings();
  const browser = await puppeteer.launch({ executablePath: EDGE_PATH, headless: true });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

  try {
    await runFlow(page);
    await runNotEnrolledFlow(browser);
  } catch (err) {
    console.error('CRASHED — dumping diagnostics:', err.message);
    await page.screenshot({ path: path.join(__dirname, '..', 'debug-crash.png') }).catch(() => {});
    await browser.close();
    process.exit(1);
  }

  const unexpectedErrors = consoleErrors.filter(e => !e.includes('Failed to load resource') && !e.includes('400'));
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

async function runFlow(page){
  const gameUrl = `${url.pathToFileURL(GAME_PATH).href}?b=${ENROLLED_BUILDING_ID}&emulator=1`;
  await page.goto(gameUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.querySelector('#idTenant option[value]:not([value=""])') !== null,
    { timeout: 10000 }
  );
  check('id-gate form is shown for a building enrolled in organics-focus',
    await page.$eval('#idCardForm', el => getComputedStyle(el).display !== 'none'));

  await page.type('#idName', 'Jane Doe');
  await page.type('#idEmail', 'jane-organics@example.com');
  await page.select('#idTenant', ENROLLED_TENANT_ID);
  await new Promise(r => setTimeout(r, 200));
  await page.select('#idLevel', 'Level 1');
  await page.click('#idForm button[type=submit]');
  await new Promise(r => setTimeout(r, 300));

  check('mainApp is shown after a valid gate submit',
    await page.$eval('#mainApp', el => getComputedStyle(el).display !== 'none'));

  await page.click('#toGameBtn');
  await new Promise(r => setTimeout(r, 300));
  await page.click('#startGameBtn');
  await new Promise(r => setTimeout(r, 300));

  const boardIds = await page.$$eval('.board-item', els => els.map(el => el.dataset.id));
  check('the board shows exactly 10 items (5 correct + 5 decoys)', boardIds.length === 10, boardIds.join(','));
  check('all 5 correct organics items are on the board',
    ['og-banana','og-apple','og-coffee','og-fish','og-eggshell'].every(id => boardIds.includes(id)), boardIds.join(','));
  check('all 5 decoys are on the board',
    ['og-teabag','gw-cutlery','gw-foam','gw-wrap','gw-napkin'].every(id => boardIds.includes(id)), boardIds.join(','));

  const reached = await resolvePhase(page, 25);
  check('the single phase can be fully resolved (all correct items sorted)', reached);
  await page.click('#nextPhaseBtn');
  await new Promise(r => setTimeout(r, 400));

  check('results screen is active after the one phase', await page.$eval('#results', el => el.classList.contains('active')).catch(() => false));
  const scoreOfText = await page.$eval('#scoreOf', el => el.textContent.trim()).catch(() => '');
  check('score denominator is 5 (the 5 decoys), not 25', scoreOfText.includes('/ 5 '), scoreOfText);

  const verifyEnv = await initializeTestEnvironment({
    projectId: 'esg-1-98f35',
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  let submissionOk = false;
  await verifyEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    const q = query(collection(db, 'submissions'), where('email', '==', 'jane-organics@example.com'));
    const snap = await getDocs(q);
    if (!snap.empty){
      const data = snap.docs[0].data();
      submissionOk = data.programId === 'organics-focus' && data.total === 5 && typeof data.score === 'number';
    }
  });
  check('the submission was written with programId organics-focus and total 5', submissionOk);
}

async function runNotEnrolledFlow(browser){
  const page = await browser.newPage();
  const gameUrl = `${url.pathToFileURL(GAME_PATH).href}?b=${NOT_ENROLLED_BUILDING_ID}&emulator=1`;
  await page.goto(gameUrl, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 1500));
  const invalidShown = await page.$eval('#idCardInvalid', el => getComputedStyle(el).display !== 'none').catch(() => false);
  check('a building enrolled in Recycling but NOT Organics Focus sees the invalid-link fallback here', invalidShown);
  await page.close();
}

main().catch((err) => { console.error('Test harness crashed:', err); process.exit(1); });
