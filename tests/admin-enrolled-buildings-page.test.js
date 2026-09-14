// Verifies outputs/admin-enrolled-buildings.html — the Enrolled Buildings tab's own page since
// Workstream 2, Phase 5 of the architecture roadmap
// (C:\Users\smolina\.claude\plans\graceful-roaming-shell.md): the "Enrol an existing building"
// picker, per-program enrollment scoping, "Configure streams" (the item-streams editor —
// Recycling-Sorting-only), the tenant-enable checklist, the Preview button, remove-enrollment,
// the "no ?program=" fallback, and cross-page session persistence. Building/tenant CRUD and
// induction registration are covered by their own pages' tests (admin-buildings-page.test.js,
// admin-catalog-page.test.js) — this file seeds everything it needs directly via Firestore
// instead of driving either UI. Run: npm run test:admin-enrolled-buildings-page
const path = require('path');
const url = require('url');
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc, getDoc } = require('firebase/firestore');

const EDGE_PATH = process.env.TEST_BROWSER_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ENROLLED_PATH = path.join(__dirname, '..', 'outputs', 'admin-enrolled-buildings.html');
const REPORT_PATH = path.join(__dirname, '..', 'outputs', 'sorting-station-report.html');
const RULES_PATH = path.join(__dirname, '..', 'firestore.rules');
const ALLOWED_EMAIL = 'esgtradeflex@gmail.com';

function enrolledUrl(programId){
  return `${url.pathToFileURL(ENROLLED_PATH).href}?program=${encodeURIComponent(programId)}&emulator=1`;
}

// One building auto-enrolled in Recycling Sorting with 6 tenants (Widgetco/Acme Legal have
// contact emails, Northwind Consulting doesn't — matching the end state the old UI-driven flow
// used to leave behind), plus a second, NOT-yet-enrolled building for the enrol-picker/cross-
// program-isolation checks, and a second registered program for that same purpose.
async function seedFixtures(){
  const testEnv = await initializeTestEnvironment({
    projectId: 'esg-1-98f35',
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  const buildingName = 'Test Tower ' + Date.now();
  const buildingId = 'test-tower-' + Date.now();
  const secondBuildingName = 'Test Tower Enroll ' + Date.now();
  const secondBuildingId = 'test-tower-enroll-' + Date.now();
  const programId = 'organics-focus-' + Date.now();
  const programName = 'Organics Focus ' + Date.now();
  const tenantIds = {
    widgetco: 'widgetco', northwindConsulting: 'northwind-consulting', acmeLegal: 'acme-legal',
    goZeroRetail: 'go-zero-retail', retailTenants: 'retail-tenants', externalBin: 'external-bin-commercial',
  };
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'buildings', buildingId), { name: buildingName });
    await setDoc(doc(db, 'enrollments', `recycling-sorting__${buildingId}`), {
      programId: 'recycling-sorting', buildingId, itemOverrides: {}, enabledTenantIds: null,
    });
    const tenants = [
      { id: tenantIds.widgetco, name: 'Widgetco', levels: ['Level 3', 'Level 4'], emails: ['widgetco-contact@example.com'] },
      { id: tenantIds.northwindConsulting, name: 'Northwind Consulting', levels: ['Level 14'], emails: [] },
      { id: tenantIds.acmeLegal, name: 'Acme Legal', levels: ['Level 8', 'Level 9'], emails: ['acme-one@example.com', 'acme-two@example.com'] },
      { id: tenantIds.goZeroRetail, name: 'Go Zero (Retail)', levels: ['Ground'], emails: [] },
      { id: tenantIds.retailTenants, name: 'Retail Tenants', levels: ['Ground'], emails: [] },
      { id: tenantIds.externalBin, name: 'External Bin/ Commercial', levels: ['External Bin/ Commercial'], emails: [] },
    ];
    for (const t of tenants){
      await setDoc(doc(db, 'buildings', buildingId, 'tenants', t.id), { name: t.name, levels: t.levels, emails: t.emails });
    }
    await setDoc(doc(db, 'buildings', secondBuildingId), { name: secondBuildingName });
    await setDoc(doc(db, 'programs', programId), {
      name: programName, description: 'A focused induction on organics sorting.',
      file: 'organics-training.html', kind: 'game', status: 'active',
    });
  });
  return { testEnv, buildingId, buildingName, tenantIds, secondBuildingId, secondBuildingName, programId, programName };
}

// Direct Firestore read of one enrollment doc, bypassing the UI entirely — needed for the
// tenant-enable checklist's 3-state model (absent/null vs [] vs a real array), which the UI
// alone can't distinguish: both "null" and "every tenant individually checked" render every
// checkbox checked identically.
async function readEnrollment(testEnv, enrollmentId){
  let result;
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const snap = await getDoc(doc(context.firestore(), 'enrollments', enrollmentId));
    result = snap.data();
  });
  return result;
}

const results = [];
function check(label, cond, extra){ results.push({ label, ok: Boolean(cond), extra: extra || '' }); }

async function main(){
  const browser = await puppeteer.launch({ executablePath: EDGE_PATH, headless: true });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));
  page.on('dialog', (d) => { consoleErrors.push('unexpected dialog: ' + d.message()); d.dismiss(); });

  let seedEnv;
  try {
    seedEnv = await runFlow(page);
  } catch (err) {
    console.error('CRASHED — dumping diagnostics:', err.message);
    console.error('--- results so far ---');
    for (const r of results){ console.error(`${r.ok ? 'PASS' : 'FAIL'} — ${r.label}${r.extra ? ' :: ' + r.extra : ''}`); }
    await page.screenshot({ path: path.join(__dirname, '..', 'debug-crash.png') }).catch(() => {});
    await browser.close();
    process.exit(1);
  }

  const unexpectedErrors = consoleErrors.filter(e =>
    !e.includes('auth/email-already-in-use') && !e.includes('Failed to load resource') && !e.includes('400'));
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

async function runFlow(page){
  const { testEnv, buildingId, buildingName, tenantIds, secondBuildingId, secondBuildingName, programId, programName } = await seedFixtures();

  // --- "No ?program=" / unrecognized program: the explicit fallback, not a silent default ---
  const noProgramUrl = `${url.pathToFileURL(ENROLLED_PATH).href}?emulator=1`;
  await page.goto(noProgramUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.getElementById('enrolledBuildingsSection') && getComputedStyle(document.getElementById('enrolledBuildingsSection')).display !== 'none',
    { timeout: 10000 }
  );
  check('with no ?program= at all, the "go back and pick one" fallback note is shown',
    await page.$eval('#noProgramNote', el => getComputedStyle(el).display !== 'none'));

  await page.goto(`${url.pathToFileURL(ENROLLED_PATH).href}?program=not-a-real-program&emulator=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.getElementById('enrolledBuildingsSection') && getComputedStyle(document.getElementById('enrolledBuildingsSection')).display !== 'none',
    { timeout: 10000 }
  );
  check('with an unrecognized ?program=, the same fallback note is shown',
    await page.$eval('#noProgramNote', el => getComputedStyle(el).display !== 'none'));

  // --- The real flow: Recycling Sorting (always valid even without its own `programs` doc) ---
  await page.goto(enrolledUrl('recycling-sorting'), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    (name) => [...document.querySelectorAll('.enrolled-building-row h3')].some(el => el.textContent === name),
    { timeout: 10000 },
    buildingName
  );
  check('the induction name appears in the page header', (await page.$eval('#programNameLabel', el => el.textContent)) === 'Recycling Sorting');
  check('#noProgramNote stays hidden for a valid induction',
    await page.$eval('#noProgramNote', el => getComputedStyle(el).display === 'none'));
  check('the building is auto-enrolled in Recycling Sorting and shows up here without a manual enroll step',
    Boolean(await page.$(`.enrolled-building-row[data-building-id="${buildingId}"]`)));

  // --- Embedded mode (Workstream 3, Item A): opened with &embedded=1, as sorting-station-report.html's
  // #adminIframe does, this page must suppress its own header/back-link/sign-out (the shell
  // already shows those) — locks in that contract independent of the iframe wiring itself,
  // which tests/admin-buildings.test.js/admin-catalog.test.js cover from the shell's side. ---
  await page.goto(`${enrolledUrl('recycling-sorting')}&embedded=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    (name) => [...document.querySelectorAll('.enrolled-building-row h3')].some(el => el.textContent === name),
    { timeout: 10000 },
    buildingName
  );
  check('embedded mode (&embedded=1) hides this page\'s own header',
    await page.$eval('header.top', el => getComputedStyle(el).display === 'none'));
  check('embedded mode (&embedded=1) hides this page\'s own back-link/sign-out corner',
    await page.$eval('#cornerSettings', el => getComputedStyle(el).display === 'none'));
  check('embedded mode still shows the real content, not hidden outright',
    await page.$eval('#enrolledBuildingsSection', el => getComputedStyle(el).display !== 'none'));
  // Back to the plain (non-embedded) URL for the rest of this test — standalone behavior is
  // the default and every check below this point assumes it.
  await page.goto(enrolledUrl('recycling-sorting'), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    (name) => [...document.querySelectorAll('.enrolled-building-row h3')].some(el => el.textContent === name),
    { timeout: 10000 },
    buildingName
  );

  // window.confirm/alert's native dialogs would otherwise fight the generic "unexpected dialog"
  // handler above — overridden in-page, recording every call (several checks below need to
  // verify not just that a confirmation happened, but what it said and exactly when).
  await page.evaluate(() => {
    window.__confirmCalls = [];
    window.confirm = (msg) => { window.__confirmCalls.push(msg); return true; };
    window.__alertCalls = [];
    window.alert = (msg) => { window.__alertCalls.push(msg); };
  });

  const enrolledSelector = `.enrolled-building-row[data-building-id="${buildingId}"]`;
  await page.click(`${enrolledSelector} .building-toggle-btn`);
  await new Promise(r => setTimeout(r, 200));
  check('expanding an enrolled-building row shows its tenant-enable checklist',
    Boolean(await page.$(`${enrolledSelector} .tenant-enable-block`)));

  // --- Configure item streams (per-building item-stream overrides) ---
  await page.click(`${enrolledSelector} .configure-items-btn`);
  await new Promise(r => setTimeout(r, 200));
  check('opening "Configure streams" shows the item-streams editor',
    Boolean(await page.$(`${enrolledSelector} .items-editor`)));

  const totalItemCards = await page.$$eval(`${enrolledSelector} .items-card`, els => els.length);
  check('the editor shows all 53 catalog items, backups included', totalItemCards === 53, totalItemCards);
  const benchItemInactive = await page.$eval(`${enrolledSelector} .item-active-toggle[data-item-id="gw-glass"]`,
    el => !el.checked).catch(() => null);
  check('a specific bench item (gw-glass) is present but shown off by default', benchItemInactive === true);

  // Regression check: the collapse arrow toggles expandedEnrolledBuildingIds, but
  // isEnrolledBuildingExpanded() ORs that with "items editor currently open" — toggling the
  // arrow while Configure streams is open must never hide the editor.
  await page.click(`${enrolledSelector} .building-toggle-btn`);
  await new Promise(r => setTimeout(r, 200));
  check('the collapse arrow does not hide the items editor while "Configure streams" is open',
    Boolean(await page.$(`${enrolledSelector} .items-editor`)));
  await page.click(`${enrolledSelector} .building-toggle-btn`);
  await new Promise(r => setTimeout(r, 200));

  // Swap "Flattened cardboard box" (pc-box) and "Empty plastic bottle" (mr-bottle) — a straight
  // swap keeps both streams at a valid 5.
  await page.select(`${enrolledSelector} .item-stream-select[data-item-id="pc-box"]`, 'mr');
  await page.select(`${enrolledSelector} .item-stream-select[data-item-id="mr-bottle"]`, 'pc');
  await page.$eval(`${enrolledSelector} .save-items-btn`, el => el.click());
  // save-items-btn's handler is async (updateDoc + await loadEnrolledData()) — wait for the
  // real re-rendered badge instead of guessing how long that takes.
  await page.waitForFunction(
    (sel) => document.querySelector(`${sel} .custom-config-badge`) !== null,
    { timeout: 8000 }, enrolledSelector
  );
  check('"Custom bins" badge appears on the building once an override is saved',
    Boolean(await page.$(`${enrolledSelector} .custom-config-badge`)));

  await page.click(`${enrolledSelector} .configure-items-btn`);
  await new Promise(r => setTimeout(r, 200));
  const pcBoxSelectValue = await page.$eval(`${enrolledSelector} .item-stream-select[data-item-id="pc-box"]`, el => el.value);
  const mrBottleSelectValue = await page.$eval(`${enrolledSelector} .item-stream-select[data-item-id="mr-bottle"]`, el => el.value);
  check('the override persisted after reload — reopening the editor shows the saved streams',
    pcBoxSelectValue === 'mr' && mrBottleSelectValue === 'pc', `${pcBoxSelectValue}, ${mrBottleSelectValue}`);

  await page.select(`${enrolledSelector} .item-stream-select[data-item-id="pc-box"]`, 'pc');
  await page.select(`${enrolledSelector} .item-stream-select[data-item-id="mr-bottle"]`, 'mr');
  await page.$eval(`${enrolledSelector} .save-items-btn`, el => el.click());
  await page.waitForFunction(
    (sel) => document.querySelector(`${sel} .items-editor`) === null,
    { timeout: 8000 }, enrolledSelector
  );
  await page.click(`${enrolledSelector} .configure-items-btn`);
  await new Promise(r => setTimeout(r, 200));

  // Battery/toner: ordinary items, off by default, any building can turn them on.
  const batteryToggledOffByDefault = await page.$eval(`${enrolledSelector} .item-active-toggle[data-item-id="ew-battery"]`,
    el => !el.checked).catch(() => null);
  check('the battery item is off by default, not a locked special case', batteryToggledOffByDefault === true);
  const batterySelectEnabled = Boolean(await page.$(`${enrolledSelector} .item-stream-select[data-item-id="ew-battery"]`));
  check('the battery card has a normal, usable stream <select>, same as any other item', batterySelectEnabled);

  await page.click(`${enrolledSelector} .item-active-toggle[data-item-id="ew-battery"]`);
  await page.$eval(`${enrolledSelector} .save-items-btn`, el => el.click());
  await page.waitForFunction(
    (sel) => document.querySelector(`${sel} .items-editor`) === null,
    { timeout: 8000 }, enrolledSelector
  );
  await page.click(`${enrolledSelector} .configure-items-btn`);
  await new Promise(r => setTimeout(r, 200));
  const batteryOnAfterReload = await page.$eval(`${enrolledSelector} .item-active-toggle[data-item-id="ew-battery"]`, el => el.checked);
  check('turning battery on for this building persists after reload', batteryOnAfterReload === true);

  // A stream must land on 0 (merged away) or ≥5 correct items, never a partial number.
  await page.click(`${enrolledSelector} .item-active-toggle[data-item-id="og-fish"]`);
  await page.$eval(`${enrolledSelector} .save-items-btn`, el => el.click());
  // A rejected save (validateDraftOverrides() fails) never awaits anything — refreshEnrolledBuildingsView()
  // runs synchronously — but wait for the real error text instead of assuming that stays true.
  await page.waitForFunction(
    (sel) => (document.querySelector(`${sel} .items-editor-error`)?.textContent || '').length > 0,
    { timeout: 5000 }, enrolledSelector
  );
  const partialStreamError = await page.$eval(`${enrolledSelector} .items-editor-error`, el => el.textContent).catch(() => '');
  check('turning Organics down to 4 correct items is rejected at save time, naming the stream and count',
    partialStreamError.includes('Organics') && partialStreamError.includes('4'), partialStreamError);
  check('the editor stays open after a rejected save (no badge/reload happened)',
    Boolean(await page.$(`${enrolledSelector} .items-editor`)));

  await page.click(`${enrolledSelector} .item-active-toggle[data-item-id="og-breadcrust"]`);
  await page.$eval(`${enrolledSelector} .save-items-btn`, el => el.click());
  await page.waitForFunction(
    (sel) => document.querySelector(`${sel} .items-editor`) === null,
    { timeout: 8000 }, enrolledSelector
  );
  await page.click(`${enrolledSelector} .configure-items-btn`);
  await new Promise(r => setTimeout(r, 200));
  const fishOffAfterReload = await page.$eval(`${enrolledSelector} .item-active-toggle[data-item-id="og-fish"]`, el => !el.checked);
  const breadcrustOnAfterReload = await page.$eval(`${enrolledSelector} .item-active-toggle[data-item-id="og-breadcrust"]`, el => el.checked);
  check('the compensated swap (fish off, bread crust on) persists after reload',
    fishOffAfterReload && breadcrustOnAfterReload);

  await page.click(`${enrolledSelector} .item-active-toggle[data-item-id="og-fish"]`);
  await page.click(`${enrolledSelector} .item-active-toggle[data-item-id="og-breadcrust"]`);
  await page.$eval(`${enrolledSelector} .save-items-btn`, el => el.click());
  await page.waitForFunction(
    (sel) => document.querySelector(`${sel} .items-editor`) === null,
    { timeout: 8000 }, enrolledSelector
  );
  await page.click(`${enrolledSelector} .configure-items-btn`);
  await new Promise(r => setTimeout(r, 200));

  // "Also acceptable in" checkboxes.
  const appleCheckboxSelector = `${enrolledSelector} .item-acceptable-checkbox[data-item-id="og-apple"][value="gw"]`;
  await page.$eval(appleCheckboxSelector, el => el.click());
  await page.$eval(`${enrolledSelector} .save-items-btn`, el => el.click());
  await page.waitForFunction(
    (sel) => document.querySelector(`${sel} .items-editor`) === null,
    { timeout: 8000 }, enrolledSelector
  );
  await page.click(`${enrolledSelector} .configure-items-btn`);
  await new Promise(r => setTimeout(r, 200));
  const applePrimaryValue = await page.$eval(`${enrolledSelector} .item-stream-select[data-item-id="og-apple"]`, el => el.value);
  const appleAcceptableChecked = await page.$eval(appleCheckboxSelector, el => el.checked);
  check('an "also acceptable in" checkbox persists after reload without disturbing the item\'s primary stream',
    applePrimaryValue === 'og' && appleAcceptableChecked === true, `primary=${applePrimaryValue} acceptableChecked=${appleAcceptableChecked}`);

  await page.$eval(appleCheckboxSelector, el => el.click());
  await page.$eval(`${enrolledSelector} .save-items-btn`, el => el.click());
  await page.waitForFunction(
    (sel) => document.querySelector(`${sel} .items-editor`) === null,
    { timeout: 8000 }, enrolledSelector
  );
  await page.click(`${enrolledSelector} .configure-items-btn`);
  await new Promise(r => setTimeout(r, 200));
  const appleAcceptableAfterUncheck = await page.$eval(appleCheckboxSelector, el => el.checked);
  check('unchecking "also acceptable in" and saving clears it', appleAcceptableAfterUncheck === false);

  await page.$eval(`${enrolledSelector} .reset-items-btn`, el => el.click());
  await page.$eval(`${enrolledSelector} .save-items-btn`, el => el.click());
  await page.waitForFunction(
    (sel) => document.querySelector(`${sel} .custom-config-badge`) === null,
    { timeout: 8000 }, enrolledSelector
  );
  check('the "Custom bins" badge disappears after resetting to default and saving',
    !(await page.$(`${enrolledSelector} .custom-config-badge`)));

  // Quick-merge shortcut.
  await page.click(`${enrolledSelector} .configure-items-btn`);
  await new Promise(r => setTimeout(r, 200));
  await page.select(`${enrolledSelector} .quick-merge-from`, 'pc');
  await page.select(`${enrolledSelector} .quick-merge-to`, 'mr');
  await page.$eval(`${enrolledSelector} .quick-merge-btn`, el => el.click());
  await new Promise(r => setTimeout(r, 200));
  const pcItemIds = ['pc-box', 'pc-paper', 'pc-envelope', 'pc-newspaper', 'pc-shredded'];
  const mergedValues = await Promise.all(pcItemIds.map(id =>
    page.$eval(`${enrolledSelector} .item-stream-select[data-item-id="${id}"]`, el => el.value)));
  check('quick-merge moves all 5 items from one stream to another in a single action',
    mergedValues.every(v => v === 'mr'), mergedValues.join(','));

  for (const fromStream of ['og', 'ew']){
    await page.select(`${enrolledSelector} .quick-merge-from`, fromStream);
    await page.select(`${enrolledSelector} .quick-merge-to`, 'gw');
    await page.$eval(`${enrolledSelector} .quick-merge-btn`, el => el.click());
    await new Promise(r => setTimeout(r, 150));
  }
  await page.select(`${enrolledSelector} .quick-merge-from`, 'mr');
  await page.select(`${enrolledSelector} .quick-merge-to`, 'gw');
  await page.$eval(`${enrolledSelector} .quick-merge-btn`, el => el.click());
  await new Promise(r => setTimeout(r, 150));
  await page.$eval(`${enrolledSelector} .save-items-btn`, el => el.click());
  await page.waitForFunction(
    (sel) => (document.querySelector(`${sel} .items-editor-error`)?.textContent || '').length > 0,
    { timeout: 5000 }, enrolledSelector
  );
  const validationErrorText = await page.$eval(`${enrolledSelector} .items-editor-error`, el => el.textContent).catch(() => '');
  check('a configuration that would starve a stream of decoys is rejected at save time, not silently accepted',
    validationErrorText.length > 0, validationErrorText);

  await page.$eval(`${enrolledSelector} .cancel-items-btn`, el => el.click());
  await new Promise(r => setTimeout(r, 200));

  // --- Preview button ---
  await page.evaluate(() => { window.__openedUrls = []; window.open = (u) => { window.__openedUrls.push(u); return null; }; });
  await page.click(`${enrolledSelector} .preview-link-btn`);
  const previewUrls = await page.evaluate(() => window.__openedUrls);
  // In emulator mode, the preview window also needs &emulator=1 appended so it talks to the
  // local emulator too (a real, fixed bug found in a code audit — the ephemeral preview window
  // used to silently open against production Firebase during local testing) — this test runs
  // in emulator mode, so expect it appended after &preview=1.
  check('the "Preview" button opens that building\'s real link with &preview=1&emulator=1 appended',
    previewUrls.length === 1 && previewUrls[0].includes(`recycling-training.html?b=${buildingId}`) && previewUrls[0].endsWith('&preview=1&emulator=1'),
    previewUrls.join(', '));

  // --- Tenant-enable checklist: 3-state model — absent/null = everyone, an array = only those
  // tenants, an explicit [] = no one. Verified via a direct Firestore read since the UI alone
  // can't distinguish "null" from "every tenant individually checked". ---
  const enrollmentId = `recycling-sorting__${buildingId}`;
  const initialEnrollment = await readEnrollment(testEnv, enrollmentId);
  check('a freshly auto-enrolled building starts with enabledTenantIds unset (everyone enabled, no restriction)',
    initialEnrollment.enabledTenantIds === undefined || initialEnrollment.enabledTenantIds === null,
    JSON.stringify(initialEnrollment.enabledTenantIds));

  const checklistLis = await page.$$(`${enrolledSelector} .tenant-enable-block li[data-tenant-id]`);
  check('the tenant-enable checklist lists all 6 tenants', checklistLis.length === 6, checklistLis.length);
  const allCheckedInitially = await page.$$eval(`${enrolledSelector} .tenant-enable-checkbox`, els => els.every(el => el.checked));
  check('every tenant starts checked (enabled) by default', allCheckedInitially);

  async function setCheckbox(index, checked){
    await page.$$eval(`${enrolledSelector} .tenant-enable-checkbox`, (els, i, c) => {
      els[i].checked = c;
      els[i].dispatchEvent(new Event('change', { bubbles: true }));
    }, index, checked);
  }
  async function checkboxLabel(index){
    return page.$$eval(`${enrolledSelector} .tenant-enable-block li[data-tenant-id]`, (els, i) => els[i].textContent, index);
  }

  const firstTenantLabel = await checkboxLabel(0);
  await setCheckbox(0, false);
  const confirmCountBefore = await page.evaluate(() => window.__confirmCalls.length);
  await page.click(`${enrolledSelector} .save-tenant-enable-btn`);
  await new Promise(r => setTimeout(r, 600));
  const confirmCallsAfterPartial = await page.evaluate((n) => window.__confirmCalls.slice(n), confirmCountBefore);
  check('unchecking one tenant and saving triggers exactly one confirm dialog naming that tenant',
    confirmCallsAfterPartial.length === 1 && firstTenantLabel.includes(confirmCallsAfterPartial[0].match(/for (.+)\?/)[1]),
    JSON.stringify(confirmCallsAfterPartial) + ' / label=' + firstTenantLabel);
  const statusAfterPartial = await page.$eval(`${enrolledSelector} .save-tenant-enable-status`, el => el.textContent);
  check('tenant-access save confirms via status text (and the message survives the reload that follows it)',
    statusAfterPartial.includes('Saved'), statusAfterPartial);
  const enrollmentAfterPartial = await readEnrollment(testEnv, enrollmentId);
  check('unchecking exactly one of six tenants saves enabledTenantIds as an array of the 5 still-checked tenants',
    Array.isArray(enrollmentAfterPartial.enabledTenantIds) && enrollmentAfterPartial.enabledTenantIds.length === 5,
    JSON.stringify(enrollmentAfterPartial.enabledTenantIds));

  await page.$$eval(`${enrolledSelector} .tenant-enable-checkbox`, els => {
    els.forEach(el => { el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true })); });
  });
  const confirmCountBeforeAll = await page.evaluate(() => window.__confirmCalls.length);
  await page.click(`${enrolledSelector} .save-tenant-enable-btn`);
  await new Promise(r => setTimeout(r, 600));
  const confirmCallsAfterAll = await page.evaluate((n) => window.__confirmCalls.slice(n), confirmCountBeforeAll);
  check('unchecking the remaining 5 tenants together triggers exactly one confirm dialog naming all 5',
    confirmCallsAfterAll.length === 1, JSON.stringify(confirmCallsAfterAll));
  const enrollmentAfterEmpty = await readEnrollment(testEnv, enrollmentId);
  check('unchecking every tenant saves enabledTenantIds as an explicit empty array, not null (paused for everyone without un-enrolling)',
    Array.isArray(enrollmentAfterEmpty.enabledTenantIds) && enrollmentAfterEmpty.enabledTenantIds.length === 0,
    JSON.stringify(enrollmentAfterEmpty.enabledTenantIds));

  await page.$$eval(`${enrolledSelector} .tenant-enable-checkbox`, els => {
    els.forEach(el => { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); });
  });
  const confirmCountBeforeReenable = await page.evaluate(() => window.__confirmCalls.length);
  await page.click(`${enrolledSelector} .save-tenant-enable-btn`);
  await new Promise(r => setTimeout(r, 600));
  const confirmCallsAfterReenable = await page.evaluate((n) => window.__confirmCalls.slice(n), confirmCountBeforeReenable);
  check('re-enabling every tenant needs no confirmation (only newly-disabled tenants trigger one)',
    confirmCallsAfterReenable.length === 0, JSON.stringify(confirmCallsAfterReenable));
  const enrollmentAfterReenable = await readEnrollment(testEnv, enrollmentId);
  check('re-checking every tenant saves enabledTenantIds back to null (the clean "no restriction" default), not a redundant full array',
    enrollmentAfterReenable.enabledTenantIds === null, JSON.stringify(enrollmentAfterReenable.enabledTenantIds));

  // --- "Enrol an existing building" + cross-program isolation + "Configure streams"/"Custom
  // bins" gating to Recycling-Sorting-only, on the second (Organics) program ---
  await page.goto(enrolledUrl(programId), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.getElementById('enrolledBuildingsList')?.textContent.includes('No buildings enrolled'),
    { timeout: 10000 }
  ).catch(() => {});
  // window.confirm/alert stubs don't survive a fresh page.goto() — this is a genuinely new JS
  // context, not the same page — so they need reapplying before remove-enrollment-btn (below)
  // triggers its own confirm() dialog.
  await page.evaluate(() => {
    window.__confirmCalls = [];
    window.confirm = (msg) => { window.__confirmCalls.push(msg); return true; };
    window.__alertCalls = [];
    window.alert = (msg) => { window.__alertCalls.push(msg); };
  });
  check('the recycling-sorting-only building does NOT appear under a fresh Organics Focus',
    !(await page.$(`.enrolled-building-row[data-building-id="${buildingId}"]`)));

  const enrollValue = await page.$$eval('#enrollBuildingSelect option', (opts, name) =>
    (opts.find(o => o.textContent === name) || {}).value, secondBuildingName);
  check('the not-yet-enrolled building is offered in the "enroll existing building" picker', Boolean(enrollValue), enrollValue);
  await page.select('#enrollBuildingSelect', enrollValue);
  await page.click('#enrollBuildingBtn');
  await new Promise(r => setTimeout(r, 600));
  let enrolledNamesForOrganics = await page.$$eval('.enrolled-building-row h3', els => els.map(el => el.textContent));
  check('after enrolling via the picker, the building appears under Organics Focus', enrolledNamesForOrganics.includes(secondBuildingName), enrolledNamesForOrganics.join('|'));
  check('"Configure streams" is not offered for a non-Recycling program (no per-building content to configure)',
    !(await page.$('.configure-items-btn')));
  check('the "Custom bins" badge is also never shown for a non-Recycling program',
    !(await page.$('.custom-config-badge')));

  const secondEnrolledSelector = `.enrolled-building-row[data-building-id="${secondBuildingId}"]`;
  await page.click(`${secondEnrolledSelector} .remove-enrollment-btn`);
  await new Promise(r => setTimeout(r, 600));
  enrolledNamesForOrganics = await page.$$eval('.enrolled-building-row h3', els => els.map(el => el.textContent));
  check('after "Remove from this induction", the building disappears from Organics Focus again',
    !enrolledNamesForOrganics.includes(secondBuildingName), enrolledNamesForOrganics.join('|') || '(none)');

  // --- "← Back to reports" carries ?program= back, and cross-page session persists ---
  const backHref = await page.$eval('#backToReportsLink', el => el.getAttribute('href')).catch(() => null);
  check('"← Back to reports" carries ?program= for this induction, preserving ?emulator=1',
    backHref === `sorting-station-report.html?emulator=1&program=${programId}`, backHref);

  await Promise.all([page.waitForNavigation(), page.click('#backToReportsLink')]);
  await page.waitForFunction(
    () => getComputedStyle(document.getElementById('settingsBtn')).display !== 'none',
    { timeout: 10000 }
  );
  check('"← Back to reports" keeps the same signed-in session (no re-login needed)', true);
  // The ?program= handoff only resolves once refreshProgramSelector()'s own fetch settles and
  // dispatches a 'change' event — #settingsBtn being visible (set synchronously, earlier in the
  // same handler) doesn't mean that's finished yet.
  await page.waitForFunction(
    (name) => document.getElementById('viewingBadge')?.textContent === `Viewing: ${name}`,
    { timeout: 10000 },
    programName
  ).catch(() => {});
  check('...and lands back on the same induction (Viewing badge names it)',
    (await page.$eval('#viewingBadge', el => el.textContent)) === `Viewing: ${programName}`);

  await page.goto(enrolledUrl('recycling-sorting'), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    (name) => [...document.querySelectorAll('.enrolled-building-row h3')].some(el => el.textContent === name),
    { timeout: 10000 },
    buildingName
  );
  check('navigating back to admin-enrolled-buildings.html also keeps the session (round trip, not one-way)', true);

  // --- Sign out must actually clear this page's own real data, not just hide it ---
  await page.click('#signOutBtn');
  await new Promise(r => setTimeout(r, 500));
  check('signing out shows the sign-in form again',
    await page.$eval('#authZone', el => getComputedStyle(el).display !== 'none'));
  check('signing out hides the Enrolled Buildings section',
    await page.$eval('#enrolledBuildingsSection', el => getComputedStyle(el).display === 'none'));
  check('signing out clears the enrolled-buildings list',
    await page.$eval('#enrolledBuildingsList', el => el.innerHTML.trim() === ''));

  return testEnv;
}

main().catch((err) => { console.error('Test harness crashed:', err); process.exit(1); });
