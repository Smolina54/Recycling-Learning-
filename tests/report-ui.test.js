// Interactive click-through of the report tool (sample data, filters, export),
// via puppeteer-core driving the locally-installed Edge. Run: npm run test:report
const path = require('path');
const url = require('url');
const puppeteer = require('puppeteer-core');

// Known limitation: hardcoded to Sergio's installed Edge path — single-machine internal tool, not solved with OS-detection.
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const REPORT_URL = url.pathToFileURL(path.join(__dirname, '..', 'outputs', 'sorting-station-report.html')).href;

const results = [];
function check(label, cond, extra){ results.push({label, ok: Boolean(cond), extra: extra || ''}); }

async function main(){
  const browser = await puppeteer.launch({ executablePath: EDGE_PATH, headless: true });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

  await page.goto(REPORT_URL, { waitUntil: 'networkidle0' });

  check('sign-in button visible on load',
    await page.$eval('#signInBtn', el => getComputedStyle(el).display !== 'none'));
  check('report section hidden before any data is loaded',
    await page.$eval('#reportSection', el => getComputedStyle(el).display === 'none'));

  await page.click('#loadSampleBtn');
  await page.waitForSelector('#reportSection', { visible: true });
  await new Promise(r => setTimeout(r, 300));

  check('report section visible after loading sample data',
    await page.$eval('#reportSection', el => getComputedStyle(el).display !== 'none'));

  const submissionsKpi = await page.$eval('#kpiRow .kpi-tile:nth-child(1) .kpi-value', el => el.textContent.trim());
  check('submissions KPI is a real number (not NaN/empty)', /^\d+$/.test(submissionsKpi), submissionsKpi);

  const passRateKpi = await page.$eval('#kpiRow .kpi-tile:nth-child(2) .kpi-value', el => el.textContent.trim());
  check('pass rate KPI looks like a percentage', /^\d+%$/.test(passRateKpi), passRateKpi);

  const completionRateKpi = await page.$eval('#kpiRow .kpi-tile:nth-child(6) .kpi-value', el => el.textContent.trim());
  check('completion rate KPI looks like a percentage (attempts tracked in sample data)',
    /^\d+%$/.test(completionRateKpi), completionRateKpi);

  const trendPoints = await page.$$eval('#trendChart .trend-svg circle', els => els.length);
  check('trend chart rendered at least one day of data', trendPoints > 0, trendPoints);

  const pendingRows = await page.$$eval('#pendingTable tbody tr', els => els.length);
  check('pending-completion list rendered at least one row (sample data has dropped attempts)',
    pendingRows > 0, pendingRows);
  const pendingHasEmail = await page.$eval('#pendingTable tbody tr td:nth-child(2)', el => el.textContent.includes('@')).catch(() => false);
  check('pending-completion rows show a real email, not blank', pendingHasEmail);
  check('pending-empty message is hidden when there are pending rows',
    await page.$eval('#pendingEmpty', el => getComputedStyle(el).display === 'none'));

  const missedRows = await page.$$eval('#missedList .missed-row', els => els.length);
  check('missed-items ranking rendered rows', missedRows > 0, missedRows);

  const groupRows = await page.$$eval('#groupTable tbody tr', els => els.length);
  check('group table rendered at least one row', groupRows > 0, groupRows);

  check('delete button hidden for sample (non-live) data',
    await page.$eval('#deleteBtn', el => getComputedStyle(el).display === 'none'));

  const buildingOptions = await page.$$eval('#filterBuilding option', opts => opts.map(o => o.value).filter(Boolean));
  check('filter building dropdown has options', buildingOptions.length > 0, buildingOptions.join('|'));

  if (buildingOptions.length){
    await page.select('#filterBuilding', buildingOptions[0]);
    await new Promise(r => setTimeout(r, 200));
    const tenantOptions = await page.$$eval('#filterTenant option', opts => opts.map(o => o.value).filter(Boolean));
    check('tenant dropdown populated after picking a building', tenantOptions.length > 0, tenantOptions.join('|'));

    const titleAfterBuilding = await page.$eval('#reportTitle', el => el.textContent.trim());
    check('report title switches to "Focused Report" once a building filter is set',
      titleAfterBuilding === 'Focused Report', titleAfterBuilding);

    const groupRowsFiltered = await page.$$eval('#groupTable tbody tr', els => els.length);
    check('group table narrows after filtering to one building',
      groupRowsFiltered < groupRows, `${groupRowsFiltered} < ${groupRows}`);

    if (tenantOptions.length){
      await page.select('#filterTenant', tenantOptions[0]);
      await new Promise(r => setTimeout(r, 200));
      const levelOptions = await page.$$eval('#filterLevel option', opts => opts.map(o => o.value).filter(Boolean));
      check('level dropdown populated after picking a tenant', levelOptions.length > 0, levelOptions.join('|'));

      const focusNote = await page.$eval('#focusNote', el => el.textContent.trim());
      check('focus note mentions the selected tenant', focusNote.includes(tenantOptions[0]), focusNote);
    }

    await page.select('#filterBuilding', '');
    await new Promise(r => setTimeout(r, 200));
    const groupRowsReset = await page.$$eval('#groupTable tbody tr', els => els.length);
    check('resetting the building filter restores the full group table',
      groupRowsReset === groupRows, `${groupRowsReset} == ${groupRows}`);
    const titleAfterReset = await page.$eval('#reportTitle', el => el.textContent.trim());
    check('report title reverts to "Overview" once filters are cleared',
      titleAfterReset === 'Overview', titleAfterReset);
  }

  // Date-range filter: sample data spreads submissions across the last ~20 days,
  // so a from-date of "tomorrow" should filter everything out, and clearing it should restore all rows.
  const groupRowsBaseline = await page.$$eval('#groupTable tbody tr', els => els.length);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  await page.$eval('#filterDateFrom', (el, v) => { el.value = v; el.dispatchEvent(new Event('change')); }, tomorrow);
  await new Promise(r => setTimeout(r, 200));
  check('a from-date in the future shows the empty-state message',
    await page.$eval('#emptyState', el => getComputedStyle(el).display !== 'none'));
  check('a from-date in the future hides the report body (no stale/NaN KPIs)',
    await page.$eval('#reportBody', el => getComputedStyle(el).display === 'none'));
  const focusNoteWithDate = await page.$eval('#focusNote', el => el.textContent.trim());
  check('focus note mentions the date range once a date filter is set',
    focusNoteWithDate.includes(tomorrow), focusNoteWithDate);

  await page.$eval('#filterDateFrom', el => { el.value = ''; el.dispatchEvent(new Event('change')); });
  await new Promise(r => setTimeout(r, 200));
  check('clearing the date filter hides the empty-state message again',
    await page.$eval('#emptyState', el => getComputedStyle(el).display === 'none'));
  const groupRowsAfterClear = await page.$$eval('#groupTable tbody tr', els => els.length);
  check('clearing the date filter restores the full group table',
    groupRowsAfterClear === groupRowsBaseline, `${groupRowsAfterClear} == ${groupRowsBaseline}`);

  const errorsBeforeExport = consoleErrors.length;
  await page.click('#exportBtn');
  await new Promise(r => setTimeout(r, 300));
  check('export CSV click does not throw', consoleErrors.length === errorsBeforeExport);

  const unexpectedErrors = consoleErrors.filter(e => !e.includes('Firebase is not configured yet'));
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

main().catch((err) => { console.error('Test harness crashed:', err); process.exit(1); });
