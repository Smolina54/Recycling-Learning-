// Verifies outputs/admin-buildings.html — master Edificios' own page since Workstream 2, Phase 2
// of the architecture roadmap (C:\Users\smolina\.claude\plans\graceful-roaming-shell.md):
// building/tenant CRUD (add/edit/delete, search, collapse/expand), the tenant levels/emails
// editors, bulk tenant import from a "collection point" Excel export, and the bulk contacts
// (email) import/export round-trip. This used to be tested as part of sorting-station-report.html
// (tests/admin-buildings.test.js) before Buildings moved to its own page.
// Run: npm run test:admin-buildings-page
const path = require('path');
const url = require('url');
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const xlsxLib = require('xlsx');

const EDGE_PATH = process.env.TEST_BROWSER_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BUILDINGS_URL = `${url.pathToFileURL(path.join(__dirname, '..', 'outputs', 'admin-buildings.html')).href}?emulator=1`;

const results = [];
function check(label, cond, extra){ results.push({ label, ok: Boolean(cond), extra: extra || '' }); }

// Generalized the same way admin-buildings.test.js used to — keys off a <h3> name.
async function findRowByName(page, rowSelector, name){
  return page.evaluateHandle((sel, n) => {
    return [...document.querySelectorAll(sel)].find(r => r.querySelector('h3') && r.querySelector('h3').textContent === n);
  }, rowSelector, name).then(h => h.asElement());
}

async function findTenantLi(row, textFragment){
  const lis = await row.$$('li');
  for (const li of lis){
    const text = await li.evaluate(el => el.textContent);
    if (text.includes(textFragment)) return li;
  }
  return null;
}

// Fills a `.levels-editor` (starts with exactly one blank "Level" row) with the given level
// strings — clicking "+ Add another level" for every level past the first.
async function fillLevelsEditor(editorHandle, levels){
  for (let i = 0; i < levels.length; i++){
    if (i > 0) await editorHandle.$eval('.add-level-row-btn', el => el.click());
    const rows = await editorHandle.$$('.level-row');
    const row = rows[i];
    const level = levels[i];
    const levelMatch = /^level\s+(.+)$/i.exec(level);
    if (levelMatch){
      await row.$eval('.level-number-input', (el, v) => { el.value = v; }, levelMatch[1]);
    } else if (level.toLowerCase() === 'ground'){
      await row.$eval('.level-type-select', el => { el.value = 'Ground'; el.dispatchEvent(new Event('change', { bubbles: true })); });
    } else {
      await row.$eval('.level-type-select', el => { el.value = 'Other'; el.dispatchEvent(new Event('change', { bubbles: true })); });
      await row.$eval('.level-other-input', (el, v) => { el.value = v; }, level);
    }
  }
}

// Fills an `.emails-editor` (starts with zero rows — a contact email is optional) by clicking
// "+ Add another email" once per address.
async function fillEmailsEditor(editorHandle, emails){
  for (let i = 0; i < emails.length; i++){
    await editorHandle.$eval('.add-email-row-btn', el => el.click());
    const rows = await editorHandle.$$('.email-row');
    await rows[i].$eval('.email-input', (el, v) => { el.value = v; }, emails[i]);
  }
}

async function main(){
  const browser = await puppeteer.launch({ executablePath: EDGE_PATH, headless: true });
  // This test's "Export contacts template" click triggers a real <a download> — the exported
  // content is verified by intercepting the Blob bytes in-page (see the URL.createObjectURL
  // override below), never by reading a downloaded file, so denying the download outright is
  // safe and keeps a throwaway test run from dropping a real .xlsx into the developer's actual
  // Downloads folder every time this suite runs.
  await browser.defaultBrowserContext().setDownloadBehavior({ policy: 'deny' });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));
  page.on('dialog', (d) => { consoleErrors.push('unexpected dialog: ' + d.message()); d.dismiss(); });

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

  const unexpectedErrors = consoleErrors.filter(e =>
    !e.includes('Failed to load resource') && !e.includes('400'));
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

async function runFlow(page, consoleErrors){
  await page.goto(BUILDINGS_URL, { waitUntil: 'domcontentloaded' });
  // ?emulator=1's own auto sign-in (as the owner) — same convenience every page already has.
  await page.waitForFunction(
    () => document.getElementById('buildingsSection') && getComputedStyle(document.getElementById('buildingsSection')).display !== 'none',
    { timeout: 10000 }
  );
  check('Buildings section is visible once signed in (this page has nothing else on it)', true);

  // window.confirm's native dialog would otherwise fight the generic "unexpected dialog"
  // handler above — override it in-page instead (same pattern as tests/admin-admins.test.js).
  await page.evaluate(() => {
    window.__confirmCalls = [];
    window.confirm = (msg) => { window.__confirmCalls.push(msg); return true; };
    window.__alertCalls = [];
    window.alert = (msg) => { window.__alertCalls.push(msg); };
  });

  const buildingName = 'Test Tower ' + Date.now();
  await page.type('#newBuildingName', buildingName);
  await page.click('#addBuildingBtn');
  // buildingsStatus is set synchronously, BEFORE the handler's own await loadMasterBuildings()
  // resolves and actually re-renders #buildingsList — wait for the real list content instead.
  await page.waitForFunction(
    (name) => [...document.querySelectorAll('.building-row h3')].some(el => el.textContent === name),
    { timeout: 8000 }, buildingName
  );

  const buildingRowNames = await page.$$eval('.building-row h3', els => els.map(el => el.textContent));
  check('new building appears in the master list', buildingRowNames.includes(buildingName), buildingRowNames.join('|'));

  let newRowHandle = await findRowByName(page, '.building-row', buildingName);
  const buildingId = await newRowHandle.evaluate(el => el.dataset.buildingId);
  check('the buildingId is a readable slug of the name, not a UUID (looked suspicious to trainees before)',
    buildingId === 'test-tower-' + buildingName.replace('Test Tower ', '') && !/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(buildingId),
    buildingId);

  // --- Name-collision handling: a second building with the same name gets a distinct id ---
  await page.evaluate(() => { document.getElementById('newBuildingName').value = ''; });
  await page.type('#newBuildingName', buildingName);
  await page.click('#addBuildingBtn');
  // addBuildingBtn's handler is async (setDoc + await loadMasterBuildings()) — wait for the
  // second row to actually render instead of guessing how long that takes.
  await page.waitForFunction(
    (name) => [...document.querySelectorAll('.building-row h3')].filter(el => el.textContent === name).length === 2,
    { timeout: 8000 }, buildingName
  );
  const allBuildingIds = await page.$$eval('.building-row', els => els.map(el => el.dataset.buildingId));
  const matchingIds = allBuildingIds.filter(id => id === buildingId || id.startsWith(buildingId + '-'));
  check('a second building with the same name gets a distinct id, not overwriting the first',
    matchingIds.length === 2 && new Set(matchingIds).size === 2, matchingIds.join(', '));

  const duplicateId = matchingIds.find(id => id !== buildingId);
  if (duplicateId){
    await page.$eval(`.building-row[data-building-id="${duplicateId}"] .delete-building-btn`, el => el.click());
    await page.waitForFunction(
      (id) => !document.querySelector(`.building-row[data-building-id="${id}"]`),
      { timeout: 8000 }, duplicateId
    );
  }

  // --- Collapse/expand: a just-created building auto-expands, showing its tenant list/add-
  // tenant form; confirm the toggle actually hides/shows that. ---
  newRowHandle = await findRowByName(page, '.building-row', buildingName);
  await newRowHandle.$eval('.building-toggle-btn', el => el.click());
  await new Promise(r => setTimeout(r, 200));
  let rowAfterCollapse = await findRowByName(page, '.building-row', buildingName);
  check('collapsing a building hides its tenant list/add-tenant form',
    !(await rowAfterCollapse.$('.new-tenant-name')));

  await rowAfterCollapse.$eval('.building-toggle-btn', el => el.click());
  await new Promise(r => setTimeout(r, 200));
  let rowAfterExpand = await findRowByName(page, '.building-row', buildingName);
  check('expanding it again shows the tenant list/add-tenant form once more',
    Boolean(await rowAfterExpand.$('.new-tenant-name')));

  // --- Search box: narrows the list by name, restores it when cleared ---
  await page.type('#buildingSearchInput', 'zzz-does-not-match-anything');
  await new Promise(r => setTimeout(r, 200));
  const namesWhenSearchMisses = await page.$$eval('.building-row h3', els => els.map(el => el.textContent));
  const noMatchMessageShown = await page.$eval('#buildingsList', el => el.textContent.includes('No buildings match your search'));
  check('a non-matching search hides the building and shows a "no match" message',
    !namesWhenSearchMisses.includes(buildingName) && noMatchMessageShown);

  await page.$eval('#buildingSearchInput', el => { el.value = ''; });
  await page.$eval('#buildingSearchInput', el => el.dispatchEvent(new Event('input', { bubbles: true })));
  await new Promise(r => setTimeout(r, 200));
  const namesAfterClearingSearch = await page.$$eval('.building-row h3', els => els.map(el => el.textContent));
  check('clearing the search restores the building to the list', namesAfterClearingSearch.includes(buildingName));

  // --- Add a tenant ---
  let rowHandle = await findRowByName(page, '.building-row', buildingName);
  const tenantName = 'Test Tenant';
  await rowHandle.$eval('.new-tenant-name', (el, v) => { el.value = v; }, tenantName);
  const newTenantLevelsEditor = await rowHandle.$('.new-tenant-levels-editor');
  await fillLevelsEditor(newTenantLevelsEditor, ['Level 1', 'Level 2']);
  const newTenantEmailsEditor = await rowHandle.$('.new-tenant-emails-editor');
  await fillEmailsEditor(newTenantEmailsEditor, ['jane@example.com', 'bob@example.com']);
  await rowHandle.$eval('.add-tenant-btn', el => el.click());
  // add-tenant-btn's handler is async (setDoc + await loadMasterBuildings()) — wait for the
  // real tenant list to actually show the new tenant instead of guessing.
  await page.waitForFunction(
    (name) => [...document.querySelectorAll('.building-row .tenant-list li')].some(li => li.textContent.includes(name)),
    { timeout: 8000 }, tenantName
  );

  const tenantEntries = await page.$$eval('.building-row .tenant-list li', els => els.map(el => el.textContent));
  const matchingTenant = tenantEntries.find(t => t.includes(tenantName));
  check('new tenant appears under its building with both levels, compacted into one "Levels 1, 2"',
    Boolean(matchingTenant) && matchingTenant.includes('Levels 1, 2'),
    tenantEntries.join(' || '));
  check('the new tenant persisted both saved contact emails',
    Boolean(matchingTenant) && matchingTenant.includes('jane@example.com') && matchingTenant.includes('bob@example.com'),
    tenantEntries.join(' || '));

  // A tenant with many "Level N" rows should compact into one "Levels 1, 2, 3, 4, 5" line.
  const fiveLevelRowHandle = await findRowByName(page, '.building-row', buildingName);
  await fiveLevelRowHandle.$eval('.new-tenant-name', (el, v) => { el.value = v; }, 'Five Level Co');
  const fiveLevelEditor = await fiveLevelRowHandle.$('.new-tenant-levels-editor');
  await fillLevelsEditor(fiveLevelEditor, ['Level 1', 'Level 2', 'Level 3', 'Level 4', 'Level 5']);
  await fiveLevelRowHandle.$eval('.add-tenant-btn', el => el.click());
  await page.waitForFunction(
    () => [...document.querySelectorAll('.building-row .tenant-list li')].some(li => li.textContent.includes('Five Level Co')),
    { timeout: 8000 }
  );
  const tenantEntriesAfterFiveLevel = await page.$$eval('.building-row .tenant-list li', els => els.map(el => el.textContent));
  check('a tenant with 5 levels shows one compact "Levels 1, 2, 3, 4, 5" line, not 5 repeated "Level N"s',
    tenantEntriesAfterFiveLevel.some(t => t.includes('Five Level Co') && t.includes('Levels 1, 2, 3, 4, 5')),
    tenantEntriesAfterFiveLevel.join(' || '));
  const fiveLevelRowForDelete = await findRowByName(page, '.building-row', buildingName);
  const fiveLevelLi = await findTenantLi(fiveLevelRowForDelete, 'Five Level Co');
  await fiveLevelLi.$eval('.delete-tenant-btn', el => el.click());
  await page.waitForFunction(
    () => ![...document.querySelectorAll('.building-row .tenant-list li')].some(li => li.textContent.includes('Five Level Co')),
    { timeout: 8000 }
  );

  // --- Invalid email blocks the save ---
  const badEmailRowHandle = await findRowByName(page, '.building-row', buildingName);
  await badEmailRowHandle.$eval('.new-tenant-name', (el, v) => { el.value = v; }, 'Bad Email Tenant');
  const badEmailLevelsEditor = await badEmailRowHandle.$('.new-tenant-levels-editor');
  await fillLevelsEditor(badEmailLevelsEditor, ['Level 1']);
  const badEmailEmailsEditor = await badEmailRowHandle.$('.new-tenant-emails-editor');
  await fillEmailsEditor(badEmailEmailsEditor, ['not-an-email']);
  const alertCountBeforeBadEmail = await page.evaluate(() => window.__alertCalls.length);
  await badEmailRowHandle.$eval('.add-tenant-btn', el => el.click());
  await new Promise(r => setTimeout(r, 300));
  const alertsAfterBadEmail = await page.evaluate((n) => window.__alertCalls.slice(n), alertCountBeforeBadEmail);
  check('an invalid contact email blocks the add-tenant save with a clear alert',
    alertsAfterBadEmail.some(a => a.includes('not-an-email')), JSON.stringify(alertsAfterBadEmail));
  const tenantEntriesAfterBadEmail = await page.$$eval('.building-row .tenant-list li', els => els.map(el => el.textContent));
  check('the tenant with the invalid email was never created',
    !tenantEntriesAfterBadEmail.some(t => t.includes('Bad Email Tenant')), tenantEntriesAfterBadEmail.join(' || '));

  // --- Bulk import from a synthetic "collection point" style Excel export ---
  const freshRowHandle = await findRowByName(page, '.building-row', buildingName);
  const fixturePath = path.join(__dirname, 'fixtures', 'sample-collection-points.xlsx');
  const fileInput = await freshRowHandle.$('.import-xlsx-input');
  await fileInput.uploadFile(fixturePath);
  // The change handler awaits file.arrayBuffer() before rendering the review rows — wait for
  // them to actually exist instead of guessing how long that read takes.
  await page.waitForFunction(
    (row) => row.querySelectorAll('.import-row').length > 0,
    { timeout: 8000 }, freshRowHandle
  );

  const candidates = await freshRowHandle.$$eval('.import-row', rows => rows.map(r => ({
    name: r.querySelector('.import-name').value,
    levels: r.querySelector('.import-levels').value,
    checked: r.querySelector('.import-check').checked,
  })));
  check('import review shows one merged row for a tenant split across 2 levels',
    candidates.some(c => c.name === 'Widgetco' && c.levels.includes('Level 3') && c.levels.includes('Level 4')),
    JSON.stringify(candidates));
  check('import review shows one merged row for a tenant split across sub-areas on the same level',
    candidates.some(c => c.name === 'Northwind Consulting' && c.levels === 'Level 14'),
    JSON.stringify(candidates));
  check('all candidate rows are checked by default', candidates.every(c => c.checked));

  const junkNames = ['Base Building', 'Vacant'];
  const importRows = await freshRowHandle.$$('.import-row');
  for (const r of importRows){
    const name = await r.$eval('.import-name', el => el.value);
    if (junkNames.includes(name)) await r.$eval('.import-check', el => { el.checked = false; });
  }
  await freshRowHandle.$eval('.import-confirm-btn', el => el.click());
  // import-confirm-btn's handler is async (a setDoc per selected row + await
  // loadMasterBuildings()) — wait for Widgetco to actually land instead of guessing.
  await page.waitForFunction(
    () => [...document.querySelectorAll('.building-row .tenant-list li')].some(li => li.textContent.includes('Widgetco')),
    { timeout: 8000 }
  );

  const tenantEntriesAfterImport = await page.$$eval('.building-row .tenant-list li', els => els.map(el => el.textContent));
  check('Widgetco was imported with both its levels merged, compacted into one "Levels 3, 4"',
    tenantEntriesAfterImport.some(t => t.includes('Widgetco') && t.includes('Levels 3, 4')),
    tenantEntriesAfterImport.join(' || '));
  check('unticked junk rows (Vacant, Base Building) were NOT imported',
    !tenantEntriesAfterImport.some(t => t.includes('Vacant')) && !tenantEntriesAfterImport.some(t => t.includes('Base Building')),
    tenantEntriesAfterImport.join(' || '));

  // --- Edit and delete the manually-added tenant (Widgetco/Northwind from the import survive) ---
  let row = await findRowByName(page, '.building-row', buildingName);
  let testTenantLi = await findTenantLi(row, 'Test Tenant');
  await testTenantLi.$eval('.edit-tenant-btn', el => el.click());
  await new Promise(r => setTimeout(r, 200));

  const editRowVisible = await page.$('.tenant-edit-row');
  check('editing a tenant shows inline name/levels inputs', Boolean(editRowVisible));
  const editEmailsEditorPrefill = await editRowVisible.$('.edit-tenant-emails-editor');
  const prefilledEmails = await editEmailsEditorPrefill.$$eval('.email-input', els => els.map(el => el.value));
  check('the edit-mode emails editor is pre-filled with both saved emails',
    prefilledEmails.includes('jane@example.com') && prefilledEmails.includes('bob@example.com'),
    prefilledEmails.join(', '));
  await editRowVisible.$eval('.edit-tenant-name-input', el => { el.value = 'Test Tenant Renamed'; });
  const editLevelsEditor = await editRowVisible.$('.edit-tenant-levels-editor');
  const editLevelNumberInputs = await editLevelsEditor.$$('.level-number-input');
  await editLevelNumberInputs[0].evaluate(el => { el.value = '5'; });
  await editLevelNumberInputs[1].evaluate(el => { el.value = '6'; });
  await editRowVisible.$eval('.save-tenant-btn', el => el.click());
  await page.waitForFunction(
    () => [...document.querySelectorAll('.building-row .tenant-list li')].some(li => li.textContent.includes('Test Tenant Renamed') && li.textContent.includes('Levels 5, 6')),
    { timeout: 8000 }
  );

  let tenantEntriesLive = await page.$$eval('.building-row .tenant-list li', els => els.map(el => el.textContent));
  check('tenant rename + level change saved correctly, compacted into one "Levels 5, 6"',
    tenantEntriesLive.some(t => t.includes('Test Tenant Renamed') && t.includes('Levels 5, 6')),
    tenantEntriesLive.join(' || '));
  check('editing name/levels did NOT drop the previously-saved contact emails',
    tenantEntriesLive.some(t => t.includes('Test Tenant Renamed') && t.includes('jane@example.com') && t.includes('bob@example.com')),
    tenantEntriesLive.join(' || '));

  // Remove one of the two emails during a real edit and confirm only that one disappears.
  row = await findRowByName(page, '.building-row', buildingName);
  const renamedTenantLiForEmailEdit = await findTenantLi(row, 'Test Tenant Renamed');
  await renamedTenantLiForEmailEdit.$eval('.edit-tenant-btn', el => el.click());
  await new Promise(r => setTimeout(r, 200));
  const editRowForEmailRemoval = await page.$('.tenant-edit-row');
  const editEmailsEditorForRemoval = await editRowForEmailRemoval.$('.edit-tenant-emails-editor');
  const emailRowsToRemove = await editEmailsEditorForRemoval.$$('.email-row');
  const bobRow = (await Promise.all(emailRowsToRemove.map(async (r2) => ({
    handle: r2, value: await r2.$eval('.email-input', el => el.value),
  })))).find(r2 => r2.value === 'bob@example.com');
  await bobRow.handle.$eval('.remove-email-row-btn', el => el.click());
  await editRowForEmailRemoval.$eval('.save-tenant-btn', el => el.click());
  await page.waitForFunction(
    () => {
      const li = [...document.querySelectorAll('.building-row .tenant-list li')].find(l => l.textContent.includes('Test Tenant Renamed'));
      return Boolean(li) && !li.textContent.includes('bob@example.com');
    },
    { timeout: 8000 }
  );

  tenantEntriesLive = await page.$$eval('.building-row .tenant-list li', els => els.map(el => el.textContent));
  const renamedEntry = tenantEntriesLive.find(t => t.includes('Test Tenant Renamed'));
  check('removing one email row keeps the other and drops only the removed one',
    Boolean(renamedEntry) && renamedEntry.includes('jane@example.com') && !renamedEntry.includes('bob@example.com'),
    renamedEntry);

  row = await findRowByName(page, '.building-row', buildingName);
  const renamedTenantLi = await findTenantLi(row, 'Test Tenant Renamed');
  await renamedTenantLi.$eval('.delete-tenant-btn', el => el.click());
  await page.waitForFunction(
    () => ![...document.querySelectorAll('.building-row .tenant-list li')].some(li => li.textContent.includes('Test Tenant Renamed')),
    { timeout: 8000 }
  );

  tenantEntriesLive = await page.$$eval('.building-row .tenant-list li', els => els.map(el => el.textContent));
  check('deleted tenant no longer appears', !tenantEntriesLive.some(t => t.includes('Test Tenant Renamed')), tenantEntriesLive.join(' || '));
  check('other tenants in the same building survive an unrelated tenant delete',
    tenantEntriesLive.some(t => t.includes('Widgetco')), tenantEntriesLive.join(' || '));

  // "Delete" on a tenant is also a soft-delete (active:false) — confirm the real id-gate's
  // company dropdown no longer offers it, even though the building's own link still works.
  const tenantCheckPage = await page.browser().newPage();
  await tenantCheckPage.goto(`${url.pathToFileURL(path.join(__dirname, '..', 'outputs', 'recycling-training.html')).href}?b=${buildingId}&emulator=1`, { waitUntil: 'domcontentloaded' });
  await tenantCheckPage.waitForFunction(
    () => document.querySelector('#idTenant option[value]:not([value=""])') !== null,
    { timeout: 10000 }
  ).catch(() => {});
  const tenantOptionsAfterDelete = await tenantCheckPage.$$eval('#idTenant option', opts => opts.map(o => o.textContent));
  check('a soft-deleted tenant no longer appears in the real id-gate\'s company dropdown',
    !tenantOptionsAfterDelete.some(t => t.includes('Test Tenant Renamed')), tenantOptionsAfterDelete.join('|'));
  await tenantCheckPage.close();

  // --- Contact-email features: coverage counter + bulk contacts round-trip ---
  const buildingsRowForEmail = await findRowByName(page, '.building-row', buildingName);
  const widgetcoLi = await findTenantLi(buildingsRowForEmail, 'Widgetco');
  await widgetcoLi.$eval('.edit-tenant-btn', el => el.click());
  await new Promise(r => setTimeout(r, 200));
  const widgetcoEditRow = await page.$('.tenant-edit-row');
  const widgetcoEmailsEditor = await widgetcoEditRow.$('.edit-tenant-emails-editor');
  await fillEmailsEditor(widgetcoEmailsEditor, ['widgetco-contact@example.com']);
  await widgetcoEditRow.$eval('.save-tenant-btn', el => el.click());
  await page.waitForFunction(
    () => {
      const li = [...document.querySelectorAll('.building-row .tenant-list li')].find(l => l.textContent.includes('Widgetco'));
      return Boolean(li) && li.textContent.includes('widgetco-contact@example.com');
    },
    { timeout: 8000 }
  );

  const buildingsRowForCoverage = await findRowByName(page, '.building-row', buildingName);
  const coverageText = await buildingsRowForCoverage.$eval('.contacts-coverage-note', el => el.textContent);
  check('the coverage counter reports exactly 1 of 6 tenants has a contact email',
    coverageText.includes('1 of 6'), coverageText);

  const buildingsTenantIds = await buildingsRowForCoverage.$$eval('.tenant-list li[data-tenant-id]', els =>
    els.map(el => ({ id: el.dataset.tenantId, name: el.querySelector('.tenant-name').textContent })));
  const acmeLegalId = buildingsTenantIds.find(t => t.name === 'Acme Legal').id;

  const errorsBeforeExport = consoleErrors.length;
  // xlsxWriteFile() in the browser builds the workbook, turns it into a Blob, and downloads it
  // via URL.createObjectURL() + a throwaway <a click> — there's no real save-file dialog to
  // intercept under Puppeteer, but the Blob itself is real, so capture it here instead of only
  // checking that the click didn't throw (a regression that emitted an empty/malformed workbook
  // would otherwise pass silently).
  await page.evaluate(() => {
    window.__exportedXlsxBase64 = null;
    const origCreateObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      blob.arrayBuffer().then((buf) => {
        let binary = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        window.__exportedXlsxBase64 = btoa(binary);
      });
      return origCreateObjectURL(blob);
    };
  });
  await buildingsRowForCoverage.$eval('.export-contacts-btn', el => el.click());
  await page.waitForFunction(() => window.__exportedXlsxBase64 !== null, { timeout: 8000 });
  check('"Export contacts template" click does not throw', consoleErrors.length === errorsBeforeExport);

  const exportedBase64 = await page.evaluate(() => window.__exportedXlsxBase64);
  const exportedWb = xlsxLib.read(Buffer.from(exportedBase64, 'base64'), { type: 'buffer' });
  check('the exported workbook has a "Contacts" sheet', exportedWb.SheetNames.includes('Contacts'), exportedWb.SheetNames.join(','));
  const exportedRows = xlsxLib.utils.sheet_to_json(exportedWb.Sheets['Contacts']);
  const exportedHeaders = exportedRows.length ? Object.keys(exportedRows[0]) : [];
  check('the exported Contacts sheet has the expected columns (Tenant ID/Tenant/Levels/Email)',
    ['Tenant ID', 'Tenant', 'Levels', 'Email'].every(h => exportedHeaders.includes(h)), exportedHeaders.join(','));
  check('the exported Contacts sheet has one real row per tenant (6), not empty/truncated',
    exportedRows.length === 6, exportedRows.length);
  const widgetcoExportRow = exportedRows.find(r => r.Tenant === 'Widgetco');
  check('the exported Contacts sheet carries Widgetco\'s real, just-saved contact email, not blank/stale data',
    Boolean(widgetcoExportRow) && widgetcoExportRow.Email === 'widgetco-contact@example.com', JSON.stringify(widgetcoExportRow));

  const contactsFixturePath = path.join(require('os').tmpdir(), `contacts-import-${Date.now()}.xlsx`);
  const contactsWb = xlsxLib.utils.book_new();
  xlsxLib.utils.book_append_sheet(contactsWb, xlsxLib.utils.json_to_sheet([
    { 'Tenant ID': acmeLegalId, Tenant: 'Acme Legal', Email: 'acme-one@example.com' },
    { 'Tenant ID': acmeLegalId, Tenant: 'Acme Legal', Email: 'acme-two@example.com' },
    { 'Tenant ID': 'not-a-real-id', Tenant: 'Nonexistent Co', Email: 'ghost@example.com' },
  ]), 'Contacts');
  xlsxLib.writeFile(contactsWb, contactsFixturePath);

  const contactsFileInput = await buildingsRowForCoverage.$('.import-contacts-input');
  await contactsFileInput.uploadFile(contactsFixturePath);
  // Same as the tenant-import upload above — the change handler awaits file.arrayBuffer()
  // before rendering the review rows.
  await page.waitForFunction(
    (row) => row.querySelectorAll('.import-contacts-review .import-row').length > 0,
    { timeout: 8000 }, buildingsRowForCoverage
  );
  fs.unlinkSync(contactsFixturePath);

  const contactsReview = await buildingsRowForCoverage.$$eval('.import-contacts-review .import-row', rows =>
    rows.map(r => ({ unmatched: r.classList.contains('import-row-unmatched'), text: r.textContent })));
  check('the import review unions both rows for Acme Legal into a single matched entry with both emails',
    contactsReview.some(r => !r.unmatched && r.text.includes('Acme Legal') && r.text.includes('acme-one@example.com') && r.text.includes('acme-two@example.com')),
    JSON.stringify(contactsReview));
  check('the row with no matching tenant ID or name is flagged as unmatched, not silently dropped',
    contactsReview.some(r => r.unmatched && r.text.includes('Nonexistent Co')),
    JSON.stringify(contactsReview));

  await buildingsRowForCoverage.$eval('.import-contacts-confirm-btn', el => el.click());
  // import-contacts-confirm-btn's handler is async (a batch commit + await
  // loadMasterBuildings()) — wait for Acme Legal's merged emails to actually land.
  await page.waitForFunction(
    () => {
      const li = [...document.querySelectorAll('.building-row .tenant-list li')].find(l => l.textContent.includes('Acme Legal'));
      return Boolean(li) && li.textContent.includes('acme-one@example.com') && li.textContent.includes('acme-two@example.com');
    },
    { timeout: 8000 }
  );

  const tenantEntriesAfterContactsImport = await page.$$eval('.building-row .tenant-list li', els => els.map(el => el.textContent));
  check('after confirming the import, Acme Legal now shows both emails from the two merged rows',
    tenantEntriesAfterContactsImport.some(t => t.includes('Acme Legal') && t.includes('acme-one@example.com') && t.includes('acme-two@example.com')),
    tenantEntriesAfterContactsImport.join(' || '));
  check('the import left Widgetco\'s own, separately-saved email untouched',
    tenantEntriesAfterContactsImport.some(t => t.includes('Widgetco') && t.includes('widgetco-contact@example.com')),
    tenantEntriesAfterContactsImport.join(' || '));

  // --- Edit and delete the building itself ---
  row = await findRowByName(page, '.building-row', buildingName);
  await row.$eval('.edit-building-btn', el => el.click());
  await new Promise(r => setTimeout(r, 200));

  const buildingSelector = `.building-row[data-building-id="${buildingId}"]`;
  const renamedBuildingName = buildingName + ' Renamed';
  await page.$eval(`${buildingSelector} .edit-building-name-input`, (el, v) => { el.value = v; }, renamedBuildingName);
  await page.$eval(`${buildingSelector} .save-building-name-btn`, el => el.click());
  // save-building-name-btn's handler is async (setDoc + await loadMasterBuildings()) — wait for
  // the renamed row to actually appear.
  await page.waitForFunction(
    (name) => [...document.querySelectorAll('.building-row h3')].some(el => el.textContent === name),
    { timeout: 8000 }, renamedBuildingName
  );

  let buildingNames = await page.$$eval('.building-row h3', els => els.map(el => el.textContent));
  check('building rename saved correctly', buildingNames.includes(renamedBuildingName), buildingNames.join('|'));

  row = await findRowByName(page, '.building-row', renamedBuildingName);
  await row.$eval('.delete-building-btn', el => el.click());
  // delete-building-btn's handler is async (updateDoc + await loadMasterBuildings()) — wait for
  // the row to actually disappear.
  await page.waitForFunction(
    (name) => ![...document.querySelectorAll('.building-row h3')].some(el => el.textContent === name),
    { timeout: 8000 }, renamedBuildingName
  );

  buildingNames = await page.$$eval('.building-row h3', els => els.map(el => el.textContent));
  check('deleted building no longer appears in the list', !buildingNames.includes(renamedBuildingName), buildingNames.join('|') || '(none left)');

  // "Delete building" is a soft-delete (active:false) — confirm the real link stops working too.
  const deletedBuildingPage = await page.browser().newPage();
  await deletedBuildingPage.goto(`${url.pathToFileURL(path.join(__dirname, '..', 'outputs', 'recycling-training.html')).href}?b=${buildingId}&emulator=1`, { waitUntil: 'domcontentloaded' });
  // Same enrollment-gate Firestore round-trip as the tenant-check page above — poll for the
  // real invalid-link card instead of guessing how long that takes.
  await deletedBuildingPage.waitForFunction(
    () => document.getElementById('idCardInvalid') && getComputedStyle(document.getElementById('idCardInvalid')).display !== 'none',
    { timeout: 10000 }
  ).catch(() => {});
  const invalidShownForDeleted = await deletedBuildingPage.$eval('#idCardInvalid', el => getComputedStyle(el).display !== 'none').catch(() => false);
  check('a soft-deleted building\'s real link now shows the invalid-link fallback, same as a real delete would', invalidShownForDeleted);
  await deletedBuildingPage.close();

  // --- Sidebar nav + sign out ---
  // Every sidebar link gets ?emulator=1 appended on load (see the page's own patch right after
  // its auto sign-in) so navigating between pages never falls out of the local test session.
  const adminsHref = await page.$eval('a[href*="admin-admins.html"]', el => el.getAttribute('href')).catch(() => null);
  check('the Admins sidebar link points at admin-admins.html', adminsHref === 'admin-admins.html?emulator=1', adminsHref);
  const catalogHref = await page.$eval('a[href*="admin-catalog.html"]', el => el.getAttribute('href')).catch(() => null);
  check('the Catalog sidebar link points at admin-catalog.html (its own page, Workstream 2 Phase 3)', catalogHref === 'admin-catalog.html?emulator=1', catalogHref);

  await page.click('#signOutBtn');
  // onAuthStateChanged fires asynchronously after signOut() resolves — wait for the real
  // post-sign-out DOM state instead of guessing.
  await page.waitForFunction(
    () => getComputedStyle(document.getElementById('authZone')).display !== 'none',
    { timeout: 8000 }
  );
  check('signing out shows the sign-in form again',
    await page.$eval('#authZone', el => getComputedStyle(el).display !== 'none'));
  check('signing out hides the Buildings section',
    await page.$eval('#buildingsSection', el => getComputedStyle(el).display === 'none'));
  check('signing out clears the buildings list',
    await page.$eval('#buildingsList', el => el.innerHTML.trim() === ''));
}

main().catch((err) => { console.error('Test harness crashed:', err); process.exit(1); });
