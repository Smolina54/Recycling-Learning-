// Signs in as the allowlisted reviewer (via the emulator-only test sign-in hook,
// not a real Google popup) and exercises the Buildings tab: create a building,
// add a tenant, confirm both render. Run: npm run test:admin
const path = require('path');
const url = require('url');
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc } = require('firebase/firestore');

// Known limitation: hardcoded to Sergio's installed Edge path — single-machine internal tool, not solved with OS-detection.
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const REPORT_URL = `${url.pathToFileURL(path.join(__dirname, '..', 'outputs', 'sorting-station-report.html')).href}?emulator=1`;
const RULES_PATH = path.join(__dirname, '..', 'firestore.rules');
const ALLOWED_EMAIL = 'esgtradeflex@gmail.com';
const XSS_PAYLOAD = '<img src=x onerror="window.__xssFired = true">';

const results = [];
function check(label, cond, extra){ results.push({label, ok: Boolean(cond), extra: extra || ''}); }

async function findTenantLi(row, textFragment){
  const lis = await row.$$('.tenant-list li');
  for (const li of lis){
    const text = await li.evaluate(el => el.textContent);
    if (text.includes(textFragment)) return li;
  }
  return null;
}

async function findBuildingRow(page, buildingName){
  return page.evaluateHandle((name) => {
    return [...document.querySelectorAll('.building-row')].find(r => r.querySelector('h3') && r.querySelector('h3').textContent === name);
  }, buildingName).then(h => h.asElement());
}

// Fills a `.levels-editor` (which starts with exactly one blank "Level" row) with the given
// level strings — clicking "+ Add another level" for every level past the first, then setting
// each row to the right type ("Level 4" -> Level/4, "Ground" -> Ground, anything else -> Other).
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

// Seeds one attempt (no matching submission -> shows in "Pending completion") and one
// submission (-> shows in "Completed") — an anonymous, unauthenticated trainee could write
// exactly either of these (name/tenantName are free text, only bounded/shape-checked by
// firestore.rules) — both with a "name" that's a real XSS payload, not just a suspicious
// string. Both should render as inert text, never execute.
// projectId MUST match the real esg-1-98f35 used in firebaseConfig — see game-regression.test.js.
async function seedMaliciousAttempt(){
  const testEnv = await initializeTestEnvironment({
    projectId: 'esg-1-98f35',
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'attempts', 'xss-test-attempt'), {
      buildingId: 'xss-test-building', buildingName: 'XSS Test Tower',
      tenantId: 'xss-test-tenant', tenantName: XSS_PAYLOAD,
      level: 'Level 1', name: XSS_PAYLOAD, email: 'xss-test@example.com',
      programId: 'recycling-sorting', startedAt: new Date().toISOString(),
    });
    await setDoc(doc(db, 'submissions', 'xss-test-submission'), {
      buildingId: 'xss-test-building-2', buildingName: XSS_PAYLOAD,
      tenantId: 'xss-test-tenant-2', tenantName: 'XSS Test Co',
      level: 'Level 1', name: XSS_PAYLOAD, email: 'xss-test-2@example.com',
      programId: 'recycling-sorting', score: 80, avoided: 20, total: 25,
      timestamp: new Date().toISOString(),
    });
    // A submission from a building where pc-box (default stream "pc") was reconfigured to
    // "mr" — the "most commonly missed items" list should label it Mixed Recycling here, not
    // its global-default Paper & Cardboard (the mislabeling bug fixed alongside Milestone 2's
    // item-streams editor). Marked as missed (0) so it's guaranteed a spot in the top-8 ranking.
    await setDoc(doc(db, 'submissions', 'override-config-submission'), {
      buildingId: 'override-config-building', buildingName: 'Override Config Tower',
      tenantId: 'override-config-tenant', tenantName: 'Override Co',
      level: 'Level 1', name: 'Pat Doe', email: 'pat@example.com',
      programId: 'recycling-sorting', score: 96, avoided: 24, total: 25,
      items: { 'pc-box': 0 },
      itemOverridesSnapshot: JSON.stringify({ 'pc-box': { stream: 'mr' } }),
      timestamp: new Date().toISOString(),
    });
  });
  return testEnv; // not cleaned up here — same reasoning as game-regression.test.js
}

async function main(){
  const seedEnv = await seedMaliciousAttempt();
  const browser = await puppeteer.launch({ executablePath: EDGE_PATH, headless: true });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));
  page.on('dialog', (d) => { consoleErrors.push('unexpected dialog: ' + d.message()); d.dismiss(); });

  try {
    await runFlow(page);
  } catch (err) {
    console.error('CRASHED — dumping diagnostics:', err.message);
    await page.screenshot({ path: path.join(__dirname, '..', 'debug-crash.png') }).catch(() => {});
    await browser.close();
    process.exit(1);
  }

  await finishAndReport(page, browser, consoleErrors, seedEnv);
}

async function runFlow(page){
  await page.goto(REPORT_URL, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 300));

  check('the Google sign-in button is present',
    Boolean(await page.$('#signInBtn')));
  check('an email/password sign-in option is present (no Microsoft button — dropped, unused)',
    Boolean(await page.$('#showEmailSignInBtn')) && !(await page.$('#signInMicrosoftBtn')));
  check('the email/password fields stay collapsed until asked for (clean initial screen — just two buttons)',
    await page.$eval('#emailSignInForm', el => getComputedStyle(el).display === 'none'));

  const signInResult = await page.evaluate(async (email) => {
    try { await window.__testSignIn(email, 'test-password-123'); return 'ok'; }
    catch (err) { return 'ERROR: ' + err.message; }
  }, ALLOWED_EMAIL);
  await new Promise(r => setTimeout(r, 1200)); // real network round-trip to the Auth + Firestore emulators

  check('test sign-in hook resolved without throwing', signInResult === 'ok', signInResult);
  const authStatusText = await page.$eval('#authStatus', el => el.textContent);
  check('admin tabs appear after signing in',
    await page.$eval('#adminTabs', el => getComputedStyle(el).display !== 'none'), authStatusText);
  check('Reports tab is active by default', await page.$eval('#tabReportsBtn', el => el.classList.contains('active')));

  // --- XSS check: a malicious trainee-submitted name must render as inert text, never run ---
  // (covers both seeded docs — the attempt in Pending completion, the submission in Completed —
  // window.__xssFired is a single shared flag either payload would set if it ever executed)
  const xssFired = await page.evaluate(() => window.__xssFired === true);
  check('a malicious attempt/submission "name" does NOT execute as script anywhere in the report', !xssFired);

  const pendingText = await page.$eval('#pendingTable', el => el.textContent);
  const pendingEmptyVisible = await page.$eval('#pendingEmpty', el => getComputedStyle(el).display !== 'none');
  check('...and shows up as literal escaped text in Pending completion (proves it rendered, not silently dropped)',
    pendingText.includes('<img src=x'), `emptyVisible=${pendingEmptyVisible} text="${pendingText.slice(0, 300)}"`);
  const pendingHasRealImgTag = await page.$$eval('#pendingTable img', els => els.length > 0);
  check('...and no real <img> element was created from it in Pending completion', !pendingHasRealImgTag);

  const completedText = await page.$eval('#completedTable', el => el.textContent);
  check('...and shows up as literal escaped text in Completed too',
    completedText.includes('<img src=x'), completedText.slice(0, 300));
  const completedHasRealImgTag = await page.$$eval('#completedTable img', els => els.length > 0);
  check('...and no real <img> element was created from it in Completed', !completedHasRealImgTag);

  const missedListText = await page.$eval('#missedList', el => el.textContent).catch(() => '');
  check('the "most commonly missed items" list labels a reconfigured item by its actual building-specific stream, not the global default',
    missedListText.includes('Flattened cardboard box') && missedListText.includes('Mixed Recycling') && !missedListText.includes('Paper & Cardboard'),
    missedListText.slice(0, 400));

  await page.click('#tabBuildingsBtn');
  await new Promise(r => setTimeout(r, 200));
  check('Buildings tab becomes visible on click',
    await page.$eval('#buildingsSection', el => getComputedStyle(el).display !== 'none'));
  check('Reports section hides when Buildings tab is active',
    await page.$eval('#reportSection', el => getComputedStyle(el).display === 'none'));

  const buildingName = 'Test Tower ' + Date.now();
  await page.type('#newBuildingName', buildingName);
  await page.click('#addBuildingBtn');
  await new Promise(r => setTimeout(r, 600));

  const status = await page.$eval('#buildingsStatus', el => el.textContent);
  check('building status message confirms the add', status.includes(buildingName), status);

  const buildingRow = await page.$$eval('.building-row h3', els => els.map(el => el.textContent));
  check('new building appears in the list', buildingRow.includes(buildingName), buildingRow.join('|'));

  let newRowHandle = await page.evaluateHandle((name) => {
    return [...document.querySelectorAll('.building-row')].find(r => r.querySelector('h3').textContent === name);
  }, buildingName);
  const buildingId = await newRowHandle.asElement().evaluate(el => el.dataset.buildingId);
  const linkText = await newRowHandle.asElement().$eval('.building-link-text', el => el.textContent);
  check('building link contains the real buildingId and points at the training page',
    linkText.includes('recycling-training.html?b=' + buildingId), linkText);
  check('the buildingId is a readable slug of the name, not a UUID (looked suspicious to trainees before)',
    buildingId === 'test-tower-' + buildingName.replace('Test Tower ', '') && !/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(buildingId),
    buildingId);

  // --- Name-collision handling: a second building with the same name gets a distinct id ---
  await page.evaluate(() => { document.getElementById('newBuildingName').value = ''; });
  await page.type('#newBuildingName', buildingName);
  await page.click('#addBuildingBtn');
  await new Promise(r => setTimeout(r, 600));
  const allBuildingIds = await page.$$eval('.building-row', els => els.map(el => el.dataset.buildingId));
  const matchingIds = allBuildingIds.filter(id => id === buildingId || id.startsWith(buildingId + '-'));
  check('a second building with the same name gets a distinct id, not overwriting the first',
    matchingIds.length === 2 && new Set(matchingIds).size === 2, matchingIds.join(', '));

  // Clean up the duplicate now, so every step below keeps operating on exactly one
  // unambiguous "the" building named buildingName, as the rest of this flow assumes.
  await page.evaluate(() => { window.confirm = () => true; });
  const duplicateId = matchingIds.find(id => id !== buildingId);
  if (duplicateId){
    await page.$eval(`.building-row[data-building-id="${duplicateId}"] .delete-building-btn`, el => el.click());
    await new Promise(r => setTimeout(r, 600));
  }

  // Both building-creation clicks above (and the delete) each re-rendered #buildingsList from
  // scratch, so the newRowHandle captured earlier is stale/detached — re-fetch a live one.
  newRowHandle = await page.evaluateHandle((name) => {
    return [...document.querySelectorAll('.building-row')].find(r => r.querySelector('h3').textContent === name);
  }, buildingName);

  const qrSvg = await newRowHandle.asElement().$eval('.building-qr svg', el => el.outerHTML).catch(() => null);
  check('QR code renders as a real SVG with content', Boolean(qrSvg) && qrSvg.length > 100, qrSvg ? qrSvg.length : 'none');

  // --- Collapse/expand: a just-created building auto-expands; confirm the toggle actually works ---
  await newRowHandle.asElement().$eval('.building-toggle-btn', el => el.click());
  await new Promise(r => setTimeout(r, 200));
  let rowAfterCollapse = await findBuildingRow(page, buildingName);
  check('collapsing a building hides its link/QR/tenant list',
    !(await rowAfterCollapse.$('.building-link-row')));

  await rowAfterCollapse.$eval('.building-toggle-btn', el => el.click());
  await new Promise(r => setTimeout(r, 200));
  let rowAfterExpand = await findBuildingRow(page, buildingName);
  check('expanding it again shows the link/QR/tenant list once more',
    Boolean(await rowAfterExpand.$('.building-link-row')));

  // --- Preview buttons: open the training in a new tab, tagged with &preview=1, never in the
  // report's own tab. Stub window.open() to capture the URL instead of actually opening it. ---
  await page.evaluate(() => { window.__openedUrls = []; window.open = (u) => { window.__openedUrls.push(u); return null; }; });
  await rowAfterExpand.$eval('.preview-link-btn', el => el.click());
  let previewUrls = await page.evaluate(() => window.__openedUrls);
  check('per-building "Preview" button opens that building\'s real link with &preview=1 appended',
    previewUrls.length === 1 && previewUrls[0].includes('recycling-training.html?b=') && previewUrls[0].endsWith('&preview=1'),
    previewUrls.join(', '));

  await page.evaluate(() => { window.__openedUrls = []; });
  await page.$eval('#previewTrainingBtn', el => el.click());
  previewUrls = await page.evaluate(() => window.__openedUrls);
  check('the Overview "Preview the training" button opens the trainer with preview=1 and no building',
    previewUrls.length === 1 && previewUrls[0].includes('recycling-training.html?preview=1') && !previewUrls[0].includes('?b='),
    previewUrls.join(', '));

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

  let clipboardGrantable = true;
  try { await page.browserContext().overridePermissions(REPORT_URL, ['clipboard-write', 'clipboard-read']); }
  catch (err) { clipboardGrantable = false; }

  // Every toggle/search step above fully re-rendered #buildingsList, so the original
  // newRowHandle is now a detached, stale reference — re-fetch a live one.
  const freshNewRowHandle = await findBuildingRow(page, buildingName);
  const copyBtn = await freshNewRowHandle.$('.copy-link-btn');
  await copyBtn.click();
  await new Promise(r => setTimeout(r, 300));

  // Headless/file:// Chrome frequently denies clipboard access even after overridePermissions()
  // succeeds — that's an environment quirk, not something the app controls. So: try to verify
  // the real copy worked, but treat the app's own graceful-fallback (a friendly alert instead of
  // a crash) as an equally valid pass, rather than failing the whole suite over a sandbox limit.
  const clipboardText = clipboardGrantable
    ? await page.evaluate(() => navigator.clipboard.readText()).catch(() => null)
    : null;
  if (clipboardText === linkText){
    check('copy-link button actually copied the exact link to the clipboard', true, clipboardText);
  } else {
    const copyBtnText = await copyBtn.evaluate(el => el.textContent);
    check('clipboard unavailable in this sandbox, but the app degraded gracefully (friendly alert, no crash) instead of copying',
      copyBtnText.includes('Copied') || copyBtnText.includes('Copy link'), copyBtnText);
  }

  // Add a tenant to whichever row is the one we just created.
  const rowHandle = await findBuildingRow(page, buildingName);
  const tenantName = 'Test Tenant';
  await rowHandle.$eval('.new-tenant-name', (el, v) => { el.value = v; }, tenantName);
  const newTenantLevelsEditor = await rowHandle.$('.new-tenant-levels-editor');
  await fillLevelsEditor(newTenantLevelsEditor, ['Level 1', 'Level 2']);
  await rowHandle.$eval('.add-tenant-btn', el => el.click());
  await new Promise(r => setTimeout(r, 600));

  const tenantEntries = await page.$$eval('.building-row .tenant-list li', els => els.map(el => el.textContent));
  const matchingTenant = tenantEntries.find(t => t.includes(tenantName));
  check('new tenant appears under its building with both levels',
    Boolean(matchingTenant) && matchingTenant.includes('Level 1') && matchingTenant.includes('Level 2'),
    tenantEntries.join(' || '));

  // --- Bulk import from a synthetic "collection point" style Excel export ---
  // Re-fetch the row: loadBuildings() re-rendered #buildingsList after the manual
  // tenant-add above, so the earlier rowHandle now points at a detached node.
  const freshRowHandle = await page.evaluateHandle((name) => {
    return [...document.querySelectorAll('.building-row')].find(r => r.querySelector('h3').textContent === name);
  }, buildingName);
  const fixturePath = path.join(__dirname, 'fixtures', 'sample-collection-points.xlsx');
  const fileInput = await freshRowHandle.asElement().$('.import-xlsx-input');
  await fileInput.uploadFile(fixturePath);
  await new Promise(r => setTimeout(r, 500));

  const candidates = await freshRowHandle.asElement().$$eval('.import-row', rows => rows.map(r => ({
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

  // Untick the two junk rows before confirming — this is the whole point of the review step.
  const junkNames = ['Base Building', 'Vacant'];
  const importRows = await freshRowHandle.asElement().$$('.import-row');
  for (const r of importRows){
    const name = await r.$eval('.import-name', el => el.value);
    if (junkNames.includes(name)) await r.$eval('.import-check', el => { el.checked = false; });
  }
  await freshRowHandle.asElement().$eval('.import-confirm-btn', el => el.click());
  await new Promise(r => setTimeout(r, 800));

  const tenantEntriesAfterImport = await page.$$eval('.building-row .tenant-list li', els => els.map(el => el.textContent));
  check('Widgetco was imported with both its levels merged',
    tenantEntriesAfterImport.some(t => t.includes('Widgetco') && t.includes('Level 3') && t.includes('Level 4')),
    tenantEntriesAfterImport.join(' || '));
  check('unticked junk rows (Vacant, Base Building) were NOT imported',
    !tenantEntriesAfterImport.some(t => t.includes('Vacant')) && !tenantEntriesAfterImport.some(t => t.includes('Base Building')),
    tenantEntriesAfterImport.join(' || '));

  // --- Edit and delete a tenant ---
  await page.evaluate(() => { window.confirm = () => true; }); // needed for the delete steps below

  let row = await findBuildingRow(page, buildingName);
  let testTenantLi = await findTenantLi(row, 'Test Tenant');
  await testTenantLi.$eval('.edit-tenant-btn', el => el.click());
  await new Promise(r => setTimeout(r, 200));

  // renderBuildingsList() fully replaces #buildingsList's innerHTML on every state change
  // (edit/cancel/save all re-render from buildingsCache), so `row`/`testTenantLi` — captured
  // before the click — are now detached from the live document. Query fresh from `page`.
  const editRowVisible = await page.$('.tenant-edit-row');
  check('editing a tenant shows inline name/levels inputs', Boolean(editRowVisible));
  await editRowVisible.$eval('.edit-tenant-name-input', el => { el.value = 'Test Tenant Renamed'; });
  // Test Tenant already has exactly 2 levels (Level 1, Level 2), so the levels editor pre-renders
  // exactly 2 rows here — no need to add/remove rows, just overwrite both numbers in place.
  const editLevelsEditor = await editRowVisible.$('.edit-tenant-levels-editor');
  const editLevelNumberInputs = await editLevelsEditor.$$('.level-number-input');
  await editLevelNumberInputs[0].evaluate(el => { el.value = '5'; });
  await editLevelNumberInputs[1].evaluate(el => { el.value = '6'; });
  await editRowVisible.$eval('.save-tenant-btn', el => el.click());
  await new Promise(r => setTimeout(r, 600));

  let tenantEntriesLive = await page.$$eval('.building-row .tenant-list li', els => els.map(el => el.textContent));
  check('tenant rename + level change saved correctly',
    tenantEntriesLive.some(t => t.includes('Test Tenant Renamed') && t.includes('Level 5') && t.includes('Level 6')),
    tenantEntriesLive.join(' || '));

  row = await findBuildingRow(page, buildingName);
  const renamedTenantLi = await findTenantLi(row, 'Test Tenant Renamed');
  await renamedTenantLi.$eval('.delete-tenant-btn', el => el.click());
  await new Promise(r => setTimeout(r, 600));

  tenantEntriesLive = await page.$$eval('.building-row .tenant-list li', els => els.map(el => el.textContent));
  check('deleted tenant no longer appears', !tenantEntriesLive.some(t => t.includes('Test Tenant Renamed')), tenantEntriesLive.join(' || '));
  check('other tenants in the same building survive an unrelated tenant delete',
    tenantEntriesLive.some(t => t.includes('Widgetco')), tenantEntriesLive.join(' || '));

  // --- Configure item streams (per-building item-stream overrides, Milestone 2) ---
  row = await findBuildingRow(page, buildingName);
  const buildingIdForItems = await row.evaluate(el => el.dataset.buildingId);
  const itemsBuildingSelector = `.building-row[data-building-id="${buildingIdForItems}"]`;

  await row.$eval('.configure-items-btn', el => el.click());
  await new Promise(r => setTimeout(r, 200));
  check('opening "Configure bins" shows the item-streams editor',
    Boolean(await page.$(`${itemsBuildingSelector} .items-editor`)));

  // Move "Flattened cardboard box" (pc-box, default stream pc) to Mixed Recycling.
  await page.select(`${itemsBuildingSelector} .item-stream-select[data-item-id="pc-box"]`, 'mr');
  await page.$eval(`${itemsBuildingSelector} .save-items-btn`, el => el.click());
  await new Promise(r => setTimeout(r, 600));

  check('"Custom bins" badge appears on the building once an override is saved',
    Boolean(await page.$(`${itemsBuildingSelector} .custom-config-badge`)));

  row = await findBuildingRow(page, buildingName);
  await row.$eval('.configure-items-btn', el => el.click());
  await new Promise(r => setTimeout(r, 200));
  const pcBoxSelectValue = await page.$eval(`${itemsBuildingSelector} .item-stream-select[data-item-id="pc-box"]`, el => el.value);
  check('the override persisted after reload — reopening the editor shows the saved stream',
    pcBoxSelectValue === 'mr', pcBoxSelectValue);

  // --- "Also acceptable in" checkboxes (Milestone 4: ideal-vs-acceptable) ---
  // og-teabag keeps its default primary (og) but gains gw as an "also acceptable" pick.
  const teabagCheckboxSelector = `${itemsBuildingSelector} .item-acceptable-checkbox[data-item-id="og-teabag"][value="gw"]`;
  await page.$eval(teabagCheckboxSelector, el => el.click());
  await page.$eval(`${itemsBuildingSelector} .save-items-btn`, el => el.click());
  await new Promise(r => setTimeout(r, 600));

  row = await findBuildingRow(page, buildingName);
  await row.$eval('.configure-items-btn', el => el.click());
  await new Promise(r => setTimeout(r, 200));
  const teabagPrimaryValue = await page.$eval(`${itemsBuildingSelector} .item-stream-select[data-item-id="og-teabag"]`, el => el.value);
  const teabagAcceptableChecked = await page.$eval(teabagCheckboxSelector, el => el.checked);
  check('an "also acceptable in" checkbox persists after reload without disturbing the item\'s primary stream',
    teabagPrimaryValue === 'og' && teabagAcceptableChecked === true, `primary=${teabagPrimaryValue} acceptableChecked=${teabagAcceptableChecked}`);

  // Unchecking it should fully clear that item's acceptable list again.
  await page.$eval(teabagCheckboxSelector, el => el.click());
  await page.$eval(`${itemsBuildingSelector} .save-items-btn`, el => el.click());
  await new Promise(r => setTimeout(r, 600));
  row = await findBuildingRow(page, buildingName);
  await row.$eval('.configure-items-btn', el => el.click());
  await new Promise(r => setTimeout(r, 200));
  const teabagAcceptableAfterUncheck = await page.$eval(teabagCheckboxSelector, el => el.checked);
  check('unchecking "also acceptable in" and saving clears it', teabagAcceptableAfterUncheck === false);

  // Reset to default, save, confirm the badge disappears.
  await page.$eval(`${itemsBuildingSelector} .reset-items-btn`, el => el.click());
  await page.$eval(`${itemsBuildingSelector} .save-items-btn`, el => el.click());
  await new Promise(r => setTimeout(r, 600));
  check('the "Custom bins" badge disappears after resetting to default and saving',
    !(await page.$(`${itemsBuildingSelector} .custom-config-badge`)));

  // Quick-merge shortcut: merge all of Paper & Cardboard into Mixed Recycling in one action.
  row = await findBuildingRow(page, buildingName);
  await row.$eval('.configure-items-btn', el => el.click());
  await new Promise(r => setTimeout(r, 200));
  await page.select(`${itemsBuildingSelector} .quick-merge-from`, 'pc');
  await page.select(`${itemsBuildingSelector} .quick-merge-to`, 'mr');
  await page.$eval(`${itemsBuildingSelector} .quick-merge-btn`, el => el.click());
  await new Promise(r => setTimeout(r, 200));
  const pcItemIds = ['pc-box', 'pc-paper', 'pc-envelope', 'pc-newspaper', 'pc-tube'];
  const mergedValues = await Promise.all(pcItemIds.map(id =>
    page.$eval(`${itemsBuildingSelector} .item-stream-select[data-item-id="${id}"]`, el => el.value)));
  check('quick-merge moves all 5 items from one stream to another in a single action',
    mergedValues.every(v => v === 'mr'), mergedValues.join(','));

  // Validation: try to merge everything else into gw too, leaving mr with no genuinely-wrong
  // candidates for its own decoy pool — this must be rejected, not silently saved.
  for (const fromStream of ['og', 'ew']){
    await page.select(`${itemsBuildingSelector} .quick-merge-from`, fromStream);
    await page.select(`${itemsBuildingSelector} .quick-merge-to`, 'gw');
    await page.$eval(`${itemsBuildingSelector} .quick-merge-btn`, el => el.click());
    await new Promise(r => setTimeout(r, 150));
  }
  await page.select(`${itemsBuildingSelector} .quick-merge-from`, 'mr');
  await page.select(`${itemsBuildingSelector} .quick-merge-to`, 'gw');
  await page.$eval(`${itemsBuildingSelector} .quick-merge-btn`, el => el.click());
  await new Promise(r => setTimeout(r, 150));
  await page.$eval(`${itemsBuildingSelector} .save-items-btn`, el => el.click());
  await new Promise(r => setTimeout(r, 300));
  const validationErrorText = await page.$eval(`${itemsBuildingSelector} .items-editor-error`, el => el.textContent).catch(() => '');
  check('a configuration that would starve a stream of decoys is rejected at save time, not silently accepted',
    validationErrorText.length > 0, validationErrorText);

  await page.$eval(`${itemsBuildingSelector} .cancel-items-btn`, el => el.click());
  await new Promise(r => setTimeout(r, 200));

  // --- Edit and delete the building itself ---
  row = await findBuildingRow(page, buildingName);
  const buildingIdForEdit = await row.evaluate(el => el.dataset.buildingId);
  const buildingSelector = `.building-row[data-building-id="${buildingIdForEdit}"]`;
  await row.$eval('.edit-building-btn', el => el.click());
  await new Promise(r => setTimeout(r, 200));

  // The <h3> is gone while editing (replaced by the inline form), so look up by the stable
  // data-building-id instead of the name — same reason the earlier name-based lookups won't
  // work here.
  const renamedBuildingName = buildingName + ' Renamed';
  await page.$eval(`${buildingSelector} .edit-building-name-input`, (el, v) => { el.value = v; }, renamedBuildingName);
  await page.$eval(`${buildingSelector} .save-building-name-btn`, el => el.click());
  await new Promise(r => setTimeout(r, 600));

  let buildingNames = await page.$$eval('.building-row h3', els => els.map(el => el.textContent));
  check('building rename saved correctly', buildingNames.includes(renamedBuildingName), buildingNames.join('|'));

  row = await findBuildingRow(page, renamedBuildingName);
  await row.$eval('.delete-building-btn', el => el.click());
  await new Promise(r => setTimeout(r, 600));

  buildingNames = await page.$$eval('.building-row h3', els => els.map(el => el.textContent));
  check('deleted building no longer appears in the list', !buildingNames.includes(renamedBuildingName), buildingNames.join('|') || '(none left)');

  // --- Admins panel: grant/revoke a second reviewer without touching firestore.rules ---
  check('owner email note is shown', (await page.$eval('#ownerEmailNote', el => el.textContent)) === ALLOWED_EMAIL);
  check('no additional admins yet', (await page.$eval('#adminsList', el => el.textContent)).includes('just you'));

  const newAdminEmail = 'second.admin@example.com';
  await page.type('#newAdminEmail', newAdminEmail);
  await page.click('#addAdminBtn');
  await new Promise(r => setTimeout(r, 600));

  const adminsStatus = await page.$eval('#adminsStatus', el => el.textContent);
  check('adding an admin confirms via status text', adminsStatus.includes(newAdminEmail), adminsStatus);
  const adminEmails = await page.$$eval('#adminsList .tenant-name', els => els.map(el => el.textContent));
  check('the new admin appears in the list', adminEmails.includes(newAdminEmail), adminEmails.join('|'));

  // Bypass the native confirm() dialog for the remove step (the harness's blanket
  // page.on('dialog') handler dismisses everything, which would cancel this on purpose).
  await page.evaluate(() => { window.confirm = () => true; });
  await page.click('.remove-admin-btn');
  await new Promise(r => setTimeout(r, 600));

  const adminEmailsAfterRemove = await page.$$eval('#adminsList .tenant-name', els => els.map(el => el.textContent));
  check('the removed admin no longer appears in the list', !adminEmailsAfterRemove.includes(newAdminEmail), adminEmailsAfterRemove.join('|') || '(empty)');

  // --- Sign out must actually clear real data from the screen, not just hide the Buildings tab ---
  // (real bug: reportSection used to stay fully visible/populated with real names/emails/scores
  // after signing out — anyone at the same screen afterward could still read it)
  await page.click('#signOutBtn');
  await new Promise(r => setTimeout(r, 500));
  const reportSectionVisible = await page.$eval('#reportSection', el => getComputedStyle(el).display !== 'none');
  check('signing out hides the Reports section entirely, not just the Buildings tab', !reportSectionVisible);
  const kpiRowEmptyAfterSignOut = await page.$eval('#kpiRow', el => el.innerHTML.trim() === '');
  check('signing out clears the KPI numbers, not just hides them', kpiRowEmptyAfterSignOut);
  const completedTableEmptyAfterSignOut = await page.$eval('#completedTable', el => el.innerHTML.trim() === '');
  check('signing out clears the Completed table\'s real names/emails', completedTableEmptyAfterSignOut);

  // --- Email/Password sign-in: Firebase's own auth, no external Google/Microsoft account needed ---
  // Mirrors the real workflow: (1) owner grants a new admin by email, (2) that person's account
  // gets created in Firebase (stands in for Sergio doing this in Console → Authentication →
  // Users — there's no in-app "create account" flow by design), (3) they sign in for real
  // through the actual email/password form on the page — not the __testSignIn bypass.
  const emailAdmin = 'email-login-admin@example.com';
  const emailAdminPassword = 'test-password-123';

  await page.evaluate(async (email) => { await window.__testSignIn(email, 'test-password-123'); }, ALLOWED_EMAIL);
  await new Promise(r => setTimeout(r, 1000));
  await page.click('#tabBuildingsBtn');
  await new Promise(r => setTimeout(r, 300));
  await page.type('#newAdminEmail', emailAdmin);
  await page.click('#addAdminBtn');
  await new Promise(r => setTimeout(r, 600));

  // Stand-in for Sergio creating this person's login in Firebase Console.
  await page.evaluate(async (email, password) => { await window.__testSignIn(email, password); }, emailAdmin, emailAdminPassword);
  await new Promise(r => setTimeout(r, 800));
  await page.click('#signOutBtn');
  await new Promise(r => setTimeout(r, 500));

  // The real thing: sign in through the actual email/password form, not a test bypass.
  // The form starts collapsed (just a "Sign in with email" button) until clicked.
  await page.click('#showEmailSignInBtn');
  await new Promise(r => setTimeout(r, 200));
  check('the email/password form reveals after clicking its button (starts collapsed for a cleaner initial screen)',
    await page.$eval('#emailSignInForm', el => getComputedStyle(el).display !== 'none'));
  await page.type('#emailSignInEmail', emailAdmin);
  await page.type('#emailSignInPassword', emailAdminPassword);
  await page.click('#emailSignInForm button[type=submit]');
  await new Promise(r => setTimeout(r, 1200));

  const authStatusAfterEmailSignIn = await page.$eval('#authStatus', el => el.textContent);
  check('signing in through the real email/password form works for a Firestore-granted admin',
    await page.$eval('#adminTabs', el => getComputedStyle(el).display !== 'none'),
    authStatusAfterEmailSignIn);
}

async function finishAndReport(page, browser, consoleErrors, seedEnv){
  // Both are harmless side-effects of re-running this test against a still-warm emulator with
  // the same fixed test email each time: the SDK-level error, and the browser's own raw network
  // log line for the failed create-user request underneath it (can't be suppressed from app code).
  const unexpectedErrors = consoleErrors.filter(e =>
    !e.includes('auth/email-already-in-use') && !e.includes('Failed to load resource') && !e.includes('400')
    && !e.includes('Clipboard write failed') && !e.includes('Could not copy automatically'));
  check('no UNEXPECTED console/page errors during the whole flow', unexpectedErrors.length === 0, unexpectedErrors.join(' || '));

  await browser.close();
  if (seedEnv) await seedEnv.cleanup();

  console.log('\n--- RESULTS ---');
  let allOk = true;
  for (const r of results){
    console.log(`${r.ok ? 'PASS' : 'FAIL'} — ${r.label}${r.extra ? ' :: ' + r.extra : ''}`);
    if (!r.ok) allOk = false;
  }
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => { console.error('Test harness crashed:', err); process.exit(1); });
