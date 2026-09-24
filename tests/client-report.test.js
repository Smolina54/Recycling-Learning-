// Verifies outputs/client-report.html — the standalone, printable client-facing report
// (Workstream 7, Point 6 of the plan: C:\Users\smolina\.claude\plans\graceful-roaming-shell.md):
// the "no ?program=" / unrecognized ?program= fallback, the building checklist, an accurate
// Firestore-level date-range query (not the live dashboard's row-capped client-side filter),
// combined KPI/stream-accuracy/most-missed-items/completion-rate content, the rule-based "Key
// findings" summary, the full per-building breakdown (its own stats, chart, and findings - not
// just a name and a couple of numbers), and the empty-date-range state.
// Run: npm run test:client-report
const path = require('path');
const url = require('url');
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc, Timestamp } = require('firebase/firestore');

const EDGE_PATH = process.env.TEST_BROWSER_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const REPORT_PATH = path.join(__dirname, '..', 'outputs', 'client-report.html');
const ADMIN_PATH = path.join(__dirname, '..', 'outputs', 'sorting-station-report.html');
const RULES_PATH = path.join(__dirname, '..', 'firestore.rules');
const ALLOWED_EMAIL = 'esgtradeflex@gmail.com';

function reportUrl(programId){
  const q = programId === undefined ? '' : `?program=${encodeURIComponent(programId)}`;
  return `${url.pathToFileURL(REPORT_PATH).href}${q}${q ? '&' : '?'}emulator=1`;
}

// Two buildings, three submissions skewed so the rule-based "Key findings" section has something
// real to say: Collins Tower's two scores (60, 68) both sit under the 75 pass mark (0% pass
// rate) while Harbor Plaza's one submission is a clean 100% - a 100-point gap, well over the
// 10-point finding threshold - and 'mr-jar' is missed often enough (67%) to clear the 25%
// most-commonly-missed threshold. Without this, the findings test would only ever see the
// generic "no major concerns" fallback and never prove the real logic fires.
//
// Also seeds a matching 'attempts' doc per submission's email, PLUS one extra attempt at
// Collins Tower (a3@example.com) with no matching submission - a person who started but never
// finished - so completed-vs-did-not-complete has a real, non-trivial number to check per
// building and combined, not just 100% everywhere.
async function seedTestData(){
  const testEnv = await initializeTestEnvironment({
    projectId: 'esg-1-98f35',
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  const b1 = 'client-report-test-collins-' + Date.now();
  const b2 = 'client-report-test-harbor-' + Date.now();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'buildings', b1), { name: 'Collins Tower' });
    await setDoc(doc(db, 'buildings', b2), { name: 'Harbor Plaza' });
    await setDoc(doc(db, 'enrollments', `recycling-sorting__${b1}`), { programId: 'recycling-sorting', buildingId: b1, active: true });
    await setDoc(doc(db, 'enrollments', `recycling-sorting__${b2}`), { programId: 'recycling-sorting', buildingId: b2, active: true });

    const now = Timestamp.now();
    const subs = [
      { buildingId: b1, buildingName: 'Collins Tower', email: 'a1@example.com', score: 60, avoided: 15, total: 25, breakdown: { gw:{avoided:3,total:5}, mr:{avoided:2,total:5}, pc:{avoided:3,total:5}, og:{avoided:3,total:5}, ew:{avoided:4,total:5} }, items: { 'mr-jar': 0, 'og-coffee': 1 } },
      { buildingId: b1, buildingName: 'Collins Tower', email: 'a2@example.com', score: 68, avoided: 17, total: 25, breakdown: { gw:{avoided:4,total:5}, mr:{avoided:2,total:5}, pc:{avoided:3,total:5}, og:{avoided:4,total:5}, ew:{avoided:4,total:5} }, items: { 'mr-jar': 0, 'og-coffee': 0 } },
      { buildingId: b2, buildingName: 'Harbor Plaza', email: 'c1@example.com', score: 100, avoided: 25, total: 25, breakdown: { gw:{avoided:5,total:5}, mr:{avoided:5,total:5}, pc:{avoided:5,total:5}, og:{avoided:5,total:5}, ew:{avoided:5,total:5} }, items: { 'mr-jar': 1, 'og-coffee': 1 } },
    ];
    for (let i = 0; i < subs.length; i++){
      await setDoc(doc(db, 'submissions', 'client-report-test-sub-' + i + '-' + Date.now()), {
        ...subs[i], programId: 'recycling-sorting', tenantName: 'Test Tenant', level: 'Level 1',
        name: 'Test Person', timestamp: now, device_type: 'desktop', duration_seconds: 180,
      });
      await setDoc(doc(db, 'attempts', 'client-report-test-attempt-' + i + '-' + Date.now()), {
        buildingId: subs[i].buildingId, programId: 'recycling-sorting', email: subs[i].email, startedAt: now,
      });
    }
    await setDoc(doc(db, 'attempts', 'client-report-test-attempt-unfinished-' + Date.now()), {
      buildingId: b1, programId: 'recycling-sorting', email: 'a3@example.com', startedAt: now,
    });
  });
  return { b1, b2 };
}

const results = [];
function check(label, cond, extra){ results.push({ label, ok: Boolean(cond), extra: extra || '' }); }

async function main(){
  const browser = await puppeteer.launch({ executablePath: EDGE_PATH, headless: true });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  try {
    await runFlow(page, consoleErrors);
  } catch (err) {
    console.error('CRASHED — dumping diagnostics:', err.message);
    console.error('--- results so far ---');
    for (const r of results){ console.error(`${r.ok ? 'PASS' : 'FAIL'} — ${r.label}${r.extra ? ' :: ' + r.extra : ''}`); }
    await page.screenshot({ path: path.join(__dirname, '..', 'debug-crash.png') }).catch(() => {});
    await browser.close();
    process.exit(1);
  }

  const unexpectedErrors = consoleErrors.filter(e => !e.includes('Failed to load resource') && !e.includes('400'));
  check('no unexpected console/page errors', unexpectedErrors.length === 0, unexpectedErrors.join(' || '));

  await browser.close();
  console.log('\n--- RESULTS ---');
  let allOk = true;
  for (const r of results){
    console.log(`${r.ok ? 'PASS' : 'FAIL'} — ${r.label}${r.extra ? ' :: ' + r.extra : ''}`);
    if (!r.ok) allOk = false;
  }
  process.exit(allOk ? 0 : 1);
}

async function runFlow(page, consoleErrors){
  const { b1 } = await seedTestData();

  // --- "No ?program=" and an unrecognized one: the explicit fallback, never a silent default ---
  await page.goto(reportUrl(undefined), { waitUntil: 'domcontentloaded' });
  await page.evaluate(async (email) => { await window.__testSignIn(email, 'test-password-123'); }, ALLOWED_EMAIL);
  await page.waitForFunction(() => document.getElementById('noProgramNote').style.display !== 'none', { timeout: 10000 });
  check('missing ?program= shows the "go back and pick one" note, not a crash', true);

  await page.goto(reportUrl('not-a-real-program'), { waitUntil: 'domcontentloaded' });
  await page.evaluate(async (email) => { await window.__testSignIn(email, 'test-password-123'); }, ALLOWED_EMAIL);
  await page.waitForFunction(() => document.getElementById('noProgramNote').style.display !== 'none', { timeout: 10000 });
  check('unrecognized ?program= shows the same fallback note', true);

  // --- The real flow ---
  await page.goto(reportUrl('recycling-sorting'), { waitUntil: 'domcontentloaded' });
  await page.evaluate(async (email) => { await window.__testSignIn(email, 'test-password-123'); }, ALLOWED_EMAIL);
  await page.waitForFunction(() => document.getElementById('reportSection').style.display !== 'none', { timeout: 10000 });
  check('report section becomes visible after sign-in', true);

  await page.waitForFunction(() => document.querySelectorAll('.building-check').length >= 2, { timeout: 10000 });
  const checklistCount = await page.$$eval('.building-check', els => els.length);
  check('both seeded buildings appear in the checklist', checklistCount === 2, checklistCount);

  // Leave the default date range untouched - this is the real, load-bearing regression check for
  // the local-timezone bug found 2026-09-18 (setDefaultDateRange() used toISOString(), a UTC
  // date, while generateReport() parses the typed value as local time; for any timezone ahead of
  // UTC this silently excluded "today"'s own submissions from the default range).
  await page.click('#generateBtn');
  await page.waitForFunction(() => getComputedStyle(document.getElementById('reportDoc')).display !== 'none', { timeout: 10000 });
  const emptyVisibleOnDefaultRange = await page.$eval('#reportEmptyNote', el => getComputedStyle(el).display !== 'none');
  check('the untouched default date range includes "now"-timestamped submissions (no false empty state)', !emptyVisibleOnDefaultRange);

  const kpiText = await page.$eval('#kpiStrip', el => el.textContent.replace(/\s+/g,' '));
  check('KPI strip shows 3 submissions combined', kpiText.includes('3'), kpiText);
  // 4 people attempted combined (a1, a2, a3, c1), 3 completed (a3 never finished) - 75%.
  check('KPI strip shows the combined completion rate (75%, a3 never finished)', kpiText.includes('75%') && kpiText.includes('Completion rate'), kpiText);

  const streamChartText = await page.$eval('#streamChart', el => el.textContent);
  check('stream chart renders stream names', streamChartText.includes('Mixed Recycling') && streamChartText.includes('General Waste'), streamChartText.replace(/\s+/g,' ').slice(0,200));

  const missedText = await page.$eval('#missedList', el => el.textContent);
  check('missed items list shows a seeded item name', missedText.includes('Rinsed glass jar') || missedText.includes('Coffee grounds'), missedText.replace(/\s+/g,' ').slice(0,200));

  const findingsText = await page.$eval('#keyFindings', el => el.textContent);
  check('key findings calls out the weaker building by name', findingsText.includes('Collins Tower') && findingsText.includes('Harbor Plaza'), findingsText.replace(/\s+/g,' ').slice(0,300));

  // --- Print / Save as PDF (Paged.js) actually completes, no uncaught pageerror ---
  // Regression test for a real production bug (2026-09-24): Paged.js does its own internal
  // url(...) parsing while building its virtual page model, separate from the browser's native
  // CSS engine - it throws "Failed to construct 'URL': Invalid URL" on the @font-face src's
  // relative branding/*.otf paths, silently hanging pagination forever (the print overlay never
  // clears, "Still working..." shows after 8s and never resolves). Fixed in buildPrintDocument()
  // by rewriting relative branding/ references to absolute ones before handing the stylesheet to
  // Paged.js. This check would have caught it (a pageerror during/after the click).
  const errorsBeforePrint = consoleErrors.length;
  await page.click('#printReportBtn');
  // Paged.js actually finishing pagination (real .pagedjs_page boxes exist in the iframe) is the
  // real signal that the bug is fixed - checked instead of waiting for the overlay to clear via
  // window.print()/'afterprint', since headless Puppeteer/Edge doesn't reliably resolve a nested
  // iframe's own window.print() the way a real user's OS print dialog would.
  const pagingCompleted = await page.waitForFunction(
    () => {
      const iframe = document.querySelector('.print-frame');
      return iframe && iframe.contentDocument && iframe.contentDocument.querySelector('.pagedjs_page');
    },
    { timeout: 15000 }
  ).then(() => true).catch(() => false);
  check('clicking "Print / Save as PDF" actually paginates the report (real .pagedjs_page boxes appear)', pagingCompleted);
  const printErrors = consoleErrors.slice(errorsBeforePrint);
  check('no pageerror during the print/Paged.js flow', !printErrors.some(e => e.startsWith('pageerror:')), printErrors.join(' || '));
  // Headless window.print() may never fire 'afterprint' on a nested iframe, unlike a real user's
  // OS print dialog closing - clean up directly instead of waiting on it, so later steps in this
  // same test aren't blocked by the still-open, full-viewport overlay.
  await page.evaluate(() => { const btn = document.getElementById('cancelPrintBtn'); if (btn) btn.click(); });
  check('key findings calls out the most commonly missed item', findingsText.includes('Rinsed glass jar'), findingsText.replace(/\s+/g,' ').slice(0,300));

  const byBuildingVisible = await page.$eval('#byBuildingSection', el => getComputedStyle(el).display !== 'none');
  check('by-building breakdown shows when 2 buildings selected', byBuildingVisible);

  const buildingBlocks = await page.$$eval('.building-block', els => els.map(el => el.textContent.replace(/\s+/g,' ')));
  check('by-building breakdown renders one block per building', buildingBlocks.length === 2, buildingBlocks.length);
  const collinsBlock = buildingBlocks.find(t => t.includes('Collins Tower')) || '';
  const harborBlock = buildingBlocks.find(t => t.includes('Harbor Plaza')) || '';

  // Collins Tower: 2 attempts completed (a1, a2), 1 did not (a3) - 67% completion rate.
  check('Collins Tower block shows its own completed/did-not-complete/completion-rate stats', collinsBlock.includes('2') && collinsBlock.includes('Completed') && collinsBlock.includes('1') && collinsBlock.includes('Did not complete') && collinsBlock.includes('67%'), collinsBlock.slice(0,400));
  check('Collins Tower block includes its own stream accuracy chart', collinsBlock.includes('Accuracy by stream') && collinsBlock.includes('Mixed Recycling'), collinsBlock.slice(0,400));
  check('Collins Tower block flags its own weak stream and missed item', collinsBlock.includes('Mixed Recycling accuracy below average') && collinsBlock.includes('Rinsed glass jar'), collinsBlock.slice(0,600));

  // Harbor Plaza: 1 attempt, 1 completed, 0 did not - 100% completion rate, no issues of its own.
  check('Harbor Plaza block shows its own completed/did-not-complete/completion-rate stats', harborBlock.includes('Completed') && harborBlock.includes('Did not complete') && harborBlock.includes('100%'), harborBlock.slice(0,400));
  check('Harbor Plaza block shows the graceful fallback (no issues of its own)', harborBlock.includes('No significant issues identified'), harborBlock.slice(0,600));

  const metaText = await page.$eval('#reportBuildingsMeta', el => el.textContent);
  check('cover shows both building names', metaText.includes('Collins Tower') && metaText.includes('Harbor Plaza'), metaText);

  const coverLogos = await page.$$eval('.report-cover img', els => els.map(el => el.getAttribute('src')));
  check('report cover uses the white (dark-background) Tradeflex + FutureGreen logos', coverLogos[0] === 'branding/tradeflex-logo-white.png' && coverLogos[1] === 'branding/futuregreen-logo-white.png', JSON.stringify(coverLogos));

  // --- Deselect one building, regenerate: per-building section hides, findings adapt to 1 building ---
  const editBtn = await page.waitForSelector('#editSelectionBtn', { visible: true, timeout: 5000 });
  await editBtn.evaluate(el => el.scrollIntoView());
  await editBtn.click();
  await page.waitForFunction(() => document.getElementById('configSection').style.display !== 'none', { timeout: 5000 });
  await page.evaluate((id) => {
    document.querySelectorAll('.building-check').forEach(el => { el.checked = (el.value === id); });
  }, b1);
  const genBtn2 = await page.waitForSelector('#generateBtn', { visible: true, timeout: 5000 });
  await genBtn2.evaluate(el => el.scrollIntoView());
  await genBtn2.click();
  await page.waitForFunction(() => getComputedStyle(document.getElementById('reportDoc')).display !== 'none', { timeout: 10000 });
  const singleKpi = await page.$eval('#kpiStrip', el => el.textContent);
  check('single-building regenerate shows 2 submissions (only Collins Tower)', singleKpi.includes('2'), singleKpi.replace(/\s+/g,' '));
  const singleByBuildingHidden = await page.$eval('#byBuildingSection', el => getComputedStyle(el).display === 'none');
  check('by-building breakdown hides when only 1 building selected', singleByBuildingHidden);

  // --- Empty-state: a narrow date range with nothing in it ---
  const editBtn2 = await page.waitForSelector('#editSelectionBtn', { visible: true, timeout: 5000 });
  await editBtn2.evaluate(el => el.scrollIntoView());
  await editBtn2.click();
  await page.waitForFunction(() => document.getElementById('configSection').style.display !== 'none', { timeout: 5000 });
  await page.evaluate(() => {
    document.getElementById('dateFrom').value = '2020-01-01';
    document.getElementById('dateTo').value = '2020-01-02';
  });
  const genBtn3 = await page.waitForSelector('#generateBtn', { visible: true, timeout: 5000 });
  await genBtn3.evaluate(el => el.scrollIntoView());
  await genBtn3.click();
  await page.waitForFunction(() => getComputedStyle(document.getElementById('reportDoc')).display !== 'none', { timeout: 10000 });
  const emptyVisible = await page.$eval('#reportEmptyNote', el => getComputedStyle(el).display !== 'none');
  check('empty date range shows the empty-state note', emptyVisible);
}

main().catch(e => { console.error(e); process.exit(1); });
