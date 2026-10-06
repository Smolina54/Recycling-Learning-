// Verifies outputs/admin-buildings.html's Bintracker Sync tab (Workstream 12: building/tenant
// catalog sync). Kept as its own dedicated file, same reasoning as
// tests/admin-buildings-bintracker.test.js's own header comment: admin-buildings-page.test.js is
// already the largest Puppeteer suite in this project and covers a different concern (plain
// building/tenant CRUD).
//
// This suite only starts firestore+auth (no Functions emulator — same deliberate choice as
// admin-buildings-bintracker.test.js and admin-buildings-page.test.js's own "Delete permanently"
// check), so:
//   - the real syncBintrackerTenants/deleteTenantPermanently Cloud Function calls are both
//     expected to fail gracefully (tested explicitly below) - none of this suite's assertions
//     depend on a real Functions emulator round trip for those two. "Check for new buildings"
//     is NOT in this category anymore (Workstream 15 Part 4, 2026-10-07): it's a plain Firestore
//     read (discovery/bintrackerBuildings, written by the nightly scheduled sync) with no Cloud
//     Function involved at all, so it's tested for real against the Firestore emulator below.
//   - the New tenants/Missing tenants/Level mismatches review UI itself is driven by
//     window.__testSetBintrackerSyncResult (an emulator-mode-only test seam admin-buildings.html
//     exposes specifically for this - see its own comment there), which injects a realistic
//     syncBintrackerTenants result shape directly, the same "seed what a real call would have
//     produced, skip the network" approach also used for diffBintrackerTenants-shaped results
//     elsewhere. Unlike bintrackerRows/bintrackerTenantMatches (real Firestore collections this
//     suite can seed directly), syncBintrackerTenants's result itself is never persisted anywhere.
// The actual pure diff logic (diffDiscoveredBuildingNames/diffBintrackerTenants) is covered with
// realistic seeded row shapes, no network/emulator at all, by tests/functions-bintrackersync.test.js,
// which also covers deleteTenantPermanently's real cascade-delete end to end (including proving no
// archive-first gate is required) against the real Functions emulator - this suite only proves the
// page wires all of that into a real, clickable UI correctly.
// Run: npm run test:admin-buildings-bintrackersync
const path = require('path');
const url = require('url');
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc, getDocs, collection, query, where } = require('firebase/firestore');

const EDGE_PATH = process.env.TEST_BROWSER_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BUILDINGS_PATH = path.join(__dirname, '..', 'outputs', 'admin-buildings.html');
const RULES_PATH = path.join(__dirname, '..', 'firestore.rules');
const BUILDINGS_URL = `${url.pathToFileURL(BUILDINGS_PATH).href}?emulator=1`;

const results = [];
function check(label, cond, extra){ results.push({ label, ok: Boolean(cond), extra: extra || '' }); }

async function findRowByName(page, rowSelector, name){
  return page.evaluateHandle((sel, n) => {
    return [...document.querySelectorAll(sel)].find(r => r.querySelector('h3') && r.querySelector('h3').textContent === n);
  }, rowSelector, name).then(h => h.asElement());
}

// Follow-up fix (2026-09-30): .discovered-building-row now uses the same <h3> name convention as
// the real .building-row elsewhere on this page (a clearer "this is expandable" affordance), so
// findRowByName above works for it directly - no separate helper needed anymore.
async function findDiscoveredBuildingRow(page, name){
  return findRowByName(page, '#discoveredBuildingsList .discovered-building-row', name);
}

async function findTenantLi(row, tenantName){
  const lis = await row.$$('li');
  for (const li of lis){
    const nameSpan = await li.$('.tenant-name');
    if (!nameSpan) continue;
    const text = await nameSpan.evaluate(el => el.textContent);
    if (text === tenantName) return li;
  }
  return null;
}

// Seeds one building with NO Bintracker mapping (proves graceful absence from the Synchronize
// list) and one WITH a mapping + 4 real tenants exercising every review-action combination: Acme
// Legal (Update path), Ignore Co (Ignore path), Keep Co (Keep path), Delete Co (Delete path). The
// actual syncBintrackerTenants diff result referencing these tenant ids is injected later via
// window.__testSetBintrackerSyncResult, not produced by a real API call.
async function seedTestData(){
  const testEnv = await initializeTestEnvironment({
    projectId: 'esg-1-98f35',
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  const suffix = Date.now();
  const unmappedBuildingId = 'sync-tower-no-bintracker-' + suffix;
  const unmappedBuildingName = 'Sync Tower No Bintracker ' + suffix;
  const mappedBuildingId = 'sync-tower-bintracker-' + suffix;
  const mappedBuildingName = 'Sync Tower Bintracker ' + suffix;
  const acmeId = 'acme-legal-' + suffix;
  const ignoreCoId = 'ignore-co-' + suffix;
  const keepCoId = 'keep-co-' + suffix;
  const deleteCoId = 'delete-co-' + suffix;

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();

    await setDoc(doc(db, 'buildings', unmappedBuildingId), { name: unmappedBuildingName });
    await setDoc(doc(db, 'buildings', unmappedBuildingId, 'tenants', 'only-tenant-' + suffix), {
      name: 'Only Tenant', levels: ['Level 1'], emails: [],
    });

    await setDoc(doc(db, 'buildings', mappedBuildingId), { name: mappedBuildingName, bintrackerBuildingName: 'Bintracker Sync Test Tower' });
    await setDoc(doc(db, 'buildings', mappedBuildingId, 'tenants', acmeId), { name: 'Acme Legal', levels: ['Level 5'], emails: [] });
    await setDoc(doc(db, 'buildings', mappedBuildingId, 'tenants', ignoreCoId), { name: 'Ignore Co', levels: ['Level 3'], emails: [] });
    await setDoc(doc(db, 'buildings', mappedBuildingId, 'tenants', keepCoId), { name: 'Keep Co', levels: ['Level 2'], emails: [] });
    await setDoc(doc(db, 'buildings', mappedBuildingId, 'tenants', deleteCoId), { name: 'Delete Co', levels: ['Level 9'], emails: [] });
  });

  return {
    testEnv, unmappedBuildingId, unmappedBuildingName,
    mappedBuildingId, mappedBuildingName, acmeId, ignoreCoId, keepCoId, deleteCoId,
  };
}

async function withRulesDisabled(fn) {
  const testEnv = await initializeTestEnvironment({
    projectId: 'esg-1-98f35',
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  await testEnv.withSecurityRulesDisabled(fn);
  await testEnv.cleanup();
}

async function readTenantsForBuilding(buildingId){
  const testEnv = await initializeTestEnvironment({
    projectId: 'esg-1-98f35',
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  let tenants = [];
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const snap = await getDocs(collection(context.firestore(), 'buildings', buildingId, 'tenants'));
    tenants = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  });
  await testEnv.cleanup();
  return tenants;
}

async function readMatchDoc(buildingId, tenantId){
  const testEnv = await initializeTestEnvironment({
    projectId: 'esg-1-98f35',
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  let data = null;
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const { getDoc, doc: docRef } = require('firebase/firestore');
    const snap = await getDoc(docRef(context.firestore(), 'bintrackerTenantMatches', `${buildingId}__${tenantId}`));
    data = snap.exists() ? snap.data() : null;
  });
  await testEnv.cleanup();
  return data;
}

async function main(){
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
    console.error('--- results so far ---');
    for (const r of results){ console.error(`${r.ok ? 'PASS' : 'FAIL'} — ${r.label}${r.extra ? ' :: ' + r.extra : ''}`); }
    await page.screenshot({ path: path.join(__dirname, '..', 'debug-crash.png') }).catch(() => {});
    await browser.close();
    process.exit(1);
  }

  // Expected graceful-failure noise from the real (unreachable, in this suite) Cloud Functions -
  // same reasoning as admin-buildings-bintracker.test.js's own "Refresh Bintracker data" check.
  // "Check for new buildings" is NOT in this list (Workstream 15 Part 4) - it's a plain Firestore
  // read now, expected to succeed for real, so an error from it here would be a genuine bug.
  const unexpectedErrors = consoleErrors.filter(e =>
    !e.includes('Failed to load resource') && !e.includes('400')
    && !e.includes('syncBintrackerTenants') && !e.includes('deleteTenantPermanently')
    && !e.includes('CORS policy')
    && !e.includes('Failed to synchronize Bintracker tenants') && !e.includes('Failed to permanently delete tenant'));
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

async function runFlow(page){
  const {
    unmappedBuildingId, unmappedBuildingName,
    mappedBuildingId, mappedBuildingName, acmeId, ignoreCoId, keepCoId, deleteCoId,
  } = await seedTestData();

  await page.goto(BUILDINGS_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.getElementById('buildingsSection') && getComputedStyle(document.getElementById('buildingsSection')).display !== 'none',
    { timeout: 10000 }
  );

  // Same in-app-modal auto-responder as the sibling Bintracker suite (Workstream 11 replaced
  // window.alert()/confirm() with a real DOM overlay).
  await page.evaluate(() => {
    window.__alertCalls = [];
    const overlay = document.getElementById('appModalOverlay');
    new MutationObserver(() => {
      if (!overlay.classList.contains('open')) return;
      const message = document.getElementById('appModalMessage').textContent;
      const buttons = [...document.getElementById('appModalActions').querySelectorAll('button')];
      window.__alertCalls.push(message);
      buttons[buttons.length - 1].click();
    }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
  });

  // Wait for both seeded buildings to show up in the plain Buildings tab first (proves the seed
  // landed and the page's normal load path works) before switching tabs.
  await page.waitForFunction(
    (n1, n2) => {
      const names = [...document.querySelectorAll('.building-row h3')].map(el => el.textContent);
      return names.includes(n1) && names.includes(n2);
    },
    { timeout: 8000 }, unmappedBuildingName, mappedBuildingName
  );

  // --- Switch to the Bintracker Sync tab ---
  await page.click('#tabBintrackerSyncBtn');
  check('clicking the "Bintracker Sync" tab makes it active and shows its pane',
    await page.evaluate(() => document.getElementById('tabBintrackerSyncBtn').classList.contains('active')
      && getComputedStyle(document.getElementById('bintrackerSyncPane')).display !== 'none'
      && getComputedStyle(document.getElementById('activeBuildingsPane')).display === 'none'));

  // --- Graceful absence: a building with no bintrackerBuildingName never appears in the
  // Synchronize list ---
  await page.waitForFunction(
    (name) => [...document.querySelectorAll('#bintrackerSyncBuildingsList .building-row h3')].some(el => el.textContent === name),
    { timeout: 8000 }, mappedBuildingName
  );
  const namesInSyncList = await page.evaluate(() => [...document.querySelectorAll('#bintrackerSyncBuildingsList .building-row h3')].map(el => el.textContent));
  check('the Bintracker Sync tab lists the mapped building', namesInSyncList.includes(mappedBuildingName), JSON.stringify(namesInSyncList));
  check('...and does NOT list the unmapped building at all (graceful absence)', !namesInSyncList.includes(unmappedBuildingName), JSON.stringify(namesInSyncList));

  // --- "Check for new buildings" (Workstream 15 Part 4, 2026-10-07): no longer a live Bintracker
  // call - it reads a plain Firestore doc (discovery/bintrackerBuildings) the nightly scheduled
  // sync writes. With no doc seeded yet, it should read as "nothing found" gracefully, not error. ---
  await page.click('#discoverBuildingsBtn');
  await page.waitForFunction(
    () => document.getElementById('discoverBuildingsStatus').textContent.length > 0,
    { timeout: 8000 }
  );
  const discoverStatusTextEmpty = await page.$eval('#discoverBuildingsStatus', el => el.textContent);
  check('with no discovery doc yet, "Check for new buildings" reads as "no new buildings" gracefully, not an error',
    discoverStatusTextEmpty.includes('No new buildings found'), discoverStatusTextEmpty);
  const discoverBtnAfterEmpty = await page.$eval('#discoverBuildingsBtn', el => ({ text: el.textContent, disabled: el.disabled }));
  check('the "Check for new buildings" button resets (not stuck on "Checking…") afterward',
    discoverBtnAfterEmpty.text === 'Check for new buildings' && !discoverBtnAfterEmpty.disabled, JSON.stringify(discoverBtnAfterEmpty));

  // --- Follow-up fix (2026-09-30), now driven via a REAL Firestore read instead of the old
  // live Bintracker call: each discovered building is its own expandable row, with its own
  // tenants+checkboxes+editable name, and "Add this building" creates everything in one action.
  // Seeds the exact doc shape runBintrackerUnscopedNightlySync() itself writes. Must go through
  // withSecurityRulesDisabled (Admin-SDK-equivalent), not a plain client-side setDoc() - this
  // collection is deliberately write-locked to every real client (firestore.rules:
  // "discovery/{docId} { allow write: if false }"), same as bintrackerRows, since only the Admin
  // SDK (the nightly scheduled sync) is ever meant to write it. ---
  await withRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'discovery', 'bintrackerBuildings'), {
      discoveredBuildings: [
        { name: 'New Tower Pty Ltd', tenants: [
          { bintrackerTenantRaw: 'Acme Startup', primaryLocations: ['Level 3'] },
          { bintrackerTenantRaw: 'Beta Co', primaryLocations: ['Level 4'] },
        ] },
        { name: 'Empty Tower', tenants: [] },
      ],
      updatedAt: new Date(),
    });
  });
  await page.click('#discoverBuildingsBtn');
  await page.waitForFunction(
    () => document.querySelectorAll('#discoveredBuildingsList .discovered-building-row').length === 2,
    { timeout: 8000 }
  );
  const discoverStatusTextFound = await page.$eval('#discoverBuildingsStatus', el => el.textContent);
  check('after seeding the discovery doc for real, "Check for new buildings" reads it back correctly (not just the test seam)',
    discoverStatusTextFound.includes('Found 2 building names not yet mapped'), discoverStatusTextFound);
  check('both discovered buildings appear, collapsed by default, with their tenant counts',
    (await page.$eval('#discoveredBuildingsList', el => el.textContent)).includes('2 tenants found')
    && (await page.$eval('#discoveredBuildingsList', el => el.textContent)).includes('0 tenants found'));
  check('a discovered building with no tenants shows no tenant list at all yet (collapsed)',
    !(await page.$('#discoveredBuildingsList .discovered-tenant-checkbox')));

  const newTowerRow = await findDiscoveredBuildingRow(page, 'New Tower Pty Ltd');
  await newTowerRow.$eval('.building-toggle-btn', el => el.click());
  await page.waitForSelector('#discoveredBuildingsList .discovered-building-name-input', { timeout: 8000 });
  const expandedNewTowerRow = await findDiscoveredBuildingRow(page, 'New Tower Pty Ltd');
  check('expanding a discovered building shows an editable name field pre-filled with the Bintracker name',
    (await expandedNewTowerRow.$eval('.discovered-building-name-input', el => el.value)) === 'New Tower Pty Ltd');
  check('...and both its tenants, each with a checkbox checked by default',
    (await expandedNewTowerRow.$$eval('.discovered-tenant-checkbox', els => els.length)) === 2
    && (await expandedNewTowerRow.$$eval('.discovered-tenant-checkbox', els => els.every(el => el.checked))));

  // Rename it for our own display, uncheck one tenant, then add it - in one single action, no
  // tab-switching, no second confirmation.
  await expandedNewTowerRow.$eval('.discovered-building-name-input', el => { el.value = 'My Tower'; });
  const checkboxes = await expandedNewTowerRow.$$('.discovered-tenant-checkbox');
  await checkboxes[1].evaluate(el => { el.checked = false; }); // uncheck "Beta Co"
  await expandedNewTowerRow.$eval('.add-discovered-building-btn', el => el.click());
  await page.waitForFunction(
    () => !document.getElementById('discoverBuildingsStatus').textContent.includes('Adding') &&
      document.getElementById('discoverBuildingsStatus').textContent.includes('Added'),
    { timeout: 10000 }
  );
  check('after "Add this building", the discovered-building row is gone from the list (only "Empty Tower" remains)',
    (await page.$$eval('#discoveredBuildingsList .discovered-building-row', els => els.length)) === 1
    && !(await page.$eval('#discoveredBuildingsList', el => el.textContent)).includes('New Tower Pty Ltd'));

  const verifyEnv = await initializeTestEnvironment({
    projectId: 'esg-1-98f35',
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  let newBuildingDocData = null, newBuildingId = null, newTenantNames = [], enrollmentCount = 0;
  await verifyEnv.withSecurityRulesDisabled(async (context) => {
    const verifyDb = context.firestore();
    const newBuildingSnap = await getDocs(query(collection(verifyDb, 'buildings'), where('name', '==', 'My Tower')));
    check('the building was created with the EDITED display name', newBuildingSnap.size === 1, newBuildingSnap.size);
    if (newBuildingSnap.size === 1){
      newBuildingId = newBuildingSnap.docs[0].id;
      newBuildingDocData = newBuildingSnap.docs[0].data();
      const newTenantsSnap = await getDocs(collection(verifyDb, 'buildings', newBuildingId, 'tenants'));
      newTenantNames = newTenantsSnap.docs.map(d => d.data().name);
      enrollmentCount = (await getDocs(query(collection(verifyDb, 'enrollments'), where('buildingId', '==', newBuildingId)))).size;
    }
  });
  await verifyEnv.cleanup();
  check('...but mapped to the ORIGINAL Bintracker name, not the edited one',
    newBuildingDocData && newBuildingDocData.bintrackerBuildingName === 'New Tower Pty Ltd', newBuildingDocData && newBuildingDocData.bintrackerBuildingName);
  check('only the CHECKED tenant (Acme Startup) was created, not the unchecked one (Beta Co)',
    newTenantNames.length === 1 && newTenantNames[0] === 'Acme Startup', JSON.stringify(newTenantNames));
  check('the new building is NOT auto-enrolled in anything, same as a plain "+ Add building"',
    enrollmentCount === 0, enrollmentCount);

  // --- Clicking "Synchronise" with no reachable Cloud Function also fails gracefully ---
  let mappedRow = await findRowByName(page, '#bintrackerSyncBuildingsList .building-row', mappedBuildingName);
  const alertCountBeforeSync = await page.evaluate(() => window.__alertCalls.length);
  await mappedRow.$eval('.sync-tenants-btn', el => el.click());
  await page.waitForFunction((n) => window.__alertCalls.length > n, { timeout: 8000 }, alertCountBeforeSync);
  check('a failed "Synchronise" call shows an error alert instead of crashing', true);
  mappedRow = await findRowByName(page, '#bintrackerSyncBuildingsList .building-row', mappedBuildingName);
  const syncBtnAfterFailure = await mappedRow.$eval('.sync-tenants-btn', el => ({ text: el.textContent, disabled: el.disabled }));
  check('the "Synchronise" button resets to normal (not stuck on "Synchronising…") after the failure',
    syncBtnAfterFailure.text === 'Synchronise' && !syncBtnAfterFailure.disabled, JSON.stringify(syncBtnAfterFailure));

  // --- Inject a realistic syncBintrackerTenants result via the test-only seam, and drive the
  // resulting New/Missing/Mismatch review UI for real ---
  await page.evaluate((buildingId, ids) => {
    window.__testSetBintrackerSyncResult(buildingId, {
      newTenants: [
        { bintrackerTenantRaw: 'New Startup Pty Ltd', primaryLocations: ['Level 12'] },
      ],
      missingTenants: [
        { tenantId: ids.keepCoId, tenantName: 'Keep Co', levels: ['Level 2'] },
        { tenantId: ids.deleteCoId, tenantName: 'Delete Co', levels: ['Level 9'] },
      ],
      levelMismatches: [
        { tenantId: ids.acmeId, tenantName: 'Acme Legal', currentLevels: ['Level 5'], bintrackerTenantRaw: 'Acme Legal', newLevels: ['Level 6'] },
        { tenantId: ids.ignoreCoId, tenantName: 'Ignore Co', currentLevels: ['Level 3'], bintrackerTenantRaw: 'Ignore Co', newLevels: ['Level 4'] },
      ],
      dateRange: { fromDate: '2026-08-01', toDate: '2026-08-31' },
    });
  }, mappedBuildingId, { acmeId, ignoreCoId, keepCoId, deleteCoId });

  await page.waitForFunction(
    () => [...document.querySelectorAll('.bintracker-sync-result')].length > 0, { timeout: 8000 }
  );
  mappedRow = await findRowByName(page, '#bintrackerSyncBuildingsList .building-row', mappedBuildingName);
  const resultPanelText = await mappedRow.$eval('.bintracker-sync-result', el => el.textContent);
  check('the injected result shows the date range compared', resultPanelText.includes('2026-08-01') && resultPanelText.includes('2026-08-31'), resultPanelText);
  check('...the new tenant candidate', resultPanelText.includes('New Startup Pty Ltd') && resultPanelText.includes('Level 12'));
  check('...both missing tenants', resultPanelText.includes('Keep Co') && resultPanelText.includes('Delete Co'));
  check('...both level mismatches', resultPanelText.includes('Acme Legal') && resultPanelText.includes('Ignore Co') && resultPanelText.includes('Level 6') && resultPanelText.includes('Level 4'));

  // --- New tenants: importing with nothing checked is rejected with a clear alert ---
  const alertCountBeforeEmptyImport = await page.evaluate(() => window.__alertCalls.length);
  await mappedRow.$eval('.import-new-tenants-btn', el => el.click());
  await page.waitForFunction((n) => window.__alertCalls.length > n, { timeout: 8000 }, alertCountBeforeEmptyImport);
  const alertsAfterEmptyImport = await page.evaluate((n) => window.__alertCalls.slice(n), alertCountBeforeEmptyImport);
  check('"Import selected" with no checkbox ticked shows a clear alert instead of writing garbage',
    alertsAfterEmptyImport.some(a => a.includes('Tick at least one')), JSON.stringify(alertsAfterEmptyImport));

  // --- New tenants: tick the checkbox and import for real ---
  mappedRow = await findRowByName(page, '#bintrackerSyncBuildingsList .building-row', mappedBuildingName);
  await mappedRow.$eval('.new-tenant-import-checkbox', (el) => {
    el.checked = true;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await mappedRow.$eval('.import-new-tenants-btn', el => el.click());
  await page.waitForFunction(
    () => {
      const panel = document.querySelector('.bintracker-sync-result');
      return panel && panel.textContent.includes('every Bintracker tenant/location pair seen matches an existing tenant');
    },
    { timeout: 8000 }
  );
  check('after importing, the "New tenants found" section shows the empty-state message', true);
  const tenantsAfterImport = await readTenantsForBuilding(mappedBuildingId);
  const imported = tenantsAfterImport.find(t => t.name === 'New Startup Pty Ltd');
  check('a real tenant doc was written to Firestore with the Bintracker raw name/location',
    Boolean(imported) && Array.isArray(imported.levels) && imported.levels.includes('Level 12'), JSON.stringify(imported));

  // A tenant imported straight from Bintracker Sync has zero fuzzy-matching risk (its name IS the
  // real Bintracker string) - its match must be auto-confirmed in the same batch as the import,
  // not left for the admin to re-confirm a second time via the per-tenant review row (fixed
  // 2026-10-06, see admin-buildings.html's .import-new-tenants-btn handler).
  const importedMatch = imported ? await readMatchDoc(mappedBuildingId, imported.id) : null;
  check('the imported tenant\'s Bintracker match is auto-confirmed in the same batch, not left pending',
    Boolean(importedMatch) && importedMatch.status === 'confirmed' && importedMatch.bintrackerTenantRaw === 'New Startup Pty Ltd',
    JSON.stringify(importedMatch));

  // --- Missing tenants: Keep just dismisses it, no Firestore change ---
  mappedRow = await findRowByName(page, '#bintrackerSyncBuildingsList .building-row', mappedBuildingName);
  const keepCoLi = await findTenantLi(mappedRow, 'Keep Co');
  await keepCoLi.$eval('.keep-missing-tenant-btn', el => el.click());
  await page.waitForFunction(
    () => {
      const panel = document.querySelector('.bintracker-sync-result');
      return panel && !panel.textContent.includes('Keep Co');
    },
    { timeout: 8000 }
  );
  check('clicking "Keep" removes Keep Co from the missing-tenants view', true);
  const tenantsAfterKeep = await readTenantsForBuilding(mappedBuildingId);
  check('...and Keep Co\'s real tenant doc is untouched (Keep is a no-op)',
    tenantsAfterKeep.some(t => t.id === keepCoId && t.name === 'Keep Co'), JSON.stringify(tenantsAfterKeep));

  // --- Missing tenants: Delete opens the type-the-name confirm panel, mirroring the Archived
  // buildings tab's own permanent-delete pattern ---
  mappedRow = await findRowByName(page, '#bintrackerSyncBuildingsList .building-row', mappedBuildingName);
  const deleteCoLi = await findTenantLi(mappedRow, 'Delete Co');
  await deleteCoLi.$eval('.delete-missing-tenant-btn', el => el.click());
  await page.waitForFunction(
    () => [...document.querySelectorAll('.tenant-delete-confirm-input')].length > 0, { timeout: 8000 }
  );
  mappedRow = await findRowByName(page, '#bintrackerSyncBuildingsList .building-row', mappedBuildingName);
  let deleteCoLiOpen = await findTenantLi(mappedRow, 'Delete Co');
  check('the Delete confirm panel\'s button starts disabled', await deleteCoLiOpen.$eval('.tenant-delete-confirm-btn', el => el.disabled));

  await deleteCoLiOpen.$eval('.tenant-delete-confirm-input', el => {
    el.value = 'Not The Real Name';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  check('typing the WRONG name keeps the confirm button disabled',
    await deleteCoLiOpen.$eval('.tenant-delete-confirm-btn', el => el.disabled));

  await deleteCoLiOpen.$eval('.tenant-delete-confirm-input', el => {
    el.value = 'Delete Co';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  check('typing the CORRECT name enables the confirm button',
    !(await deleteCoLiOpen.$eval('.tenant-delete-confirm-btn', el => el.disabled)));

  // No Functions emulator in this suite (same deliberate choice as admin-buildings-page.test.js's
  // own "Delete permanently" building check) - the real cascade delete itself is fully covered,
  // end to end, by tests/functions-bintrackersync.test.js. This only proves the call is attempted
  // and fails gracefully rather than crashing or silently doing nothing.
  await deleteCoLiOpen.$eval('.tenant-delete-confirm-btn', el => el.click());
  await page.waitForFunction(
    () => {
      const statusEls = [...document.querySelectorAll('.tenant-delete-status')];
      return statusEls.some(el => el.textContent.length > 0);
    },
    { timeout: 8000 }
  );
  check('a failed tenant delete call shows a status message instead of crashing or silently doing nothing', true);
  const tenantsAfterFailedDelete = await readTenantsForBuilding(mappedBuildingId);
  check('...and Delete Co\'s real tenant doc survives the failed call (nothing deleted client-side)',
    tenantsAfterFailedDelete.some(t => t.id === deleteCoId), JSON.stringify(tenantsAfterFailedDelete));

  // --- Level mismatches: Update writes the new level onto the real tenant doc ---
  mappedRow = await findRowByName(page, '#bintrackerSyncBuildingsList .building-row', mappedBuildingName);
  const acmeLi = await findTenantLi(mappedRow, 'Acme Legal');
  await acmeLi.$eval('.update-level-mismatch-btn', el => el.click());
  await page.waitForFunction(
    () => {
      const panel = document.querySelector('.bintracker-sync-result');
      return panel && !panel.textContent.includes('Bintracker also shows: Level 6');
    },
    { timeout: 8000 }
  );
  check('clicking "Update" removes Acme Legal from the level-mismatch view', true);
  const tenantsAfterUpdate = await readTenantsForBuilding(mappedBuildingId);
  const acmeAfter = tenantsAfterUpdate.find(t => t.id === acmeId);
  check('...and Acme Legal\'s real tenant doc now includes the new level, keeping the old one too',
    acmeAfter && acmeAfter.levels.includes('Level 5') && acmeAfter.levels.includes('Level 6'), JSON.stringify(acmeAfter));

  // --- Level mismatches: Ignore just dismisses it, no Firestore change ---
  mappedRow = await findRowByName(page, '#bintrackerSyncBuildingsList .building-row', mappedBuildingName);
  const ignoreCoLi = await findTenantLi(mappedRow, 'Ignore Co');
  await ignoreCoLi.$eval('.ignore-level-mismatch-btn', el => el.click());
  await page.waitForFunction(
    () => {
      const panel = document.querySelector('.bintracker-sync-result');
      return panel && panel.textContent.includes('every matched tenant\'s stored level(s) already cover what Bintracker showed');
    },
    { timeout: 8000 }
  );
  check('clicking "Ignore" removes Ignore Co from the level-mismatch view, leaving it empty', true);
  const tenantsAfterIgnore = await readTenantsForBuilding(mappedBuildingId);
  const ignoreCoAfter = tenantsAfterIgnore.find(t => t.id === ignoreCoId);
  check('...and Ignore Co\'s real tenant doc is untouched (Ignore is a no-op)',
    ignoreCoAfter && JSON.stringify(ignoreCoAfter.levels) === JSON.stringify(['Level 3']), JSON.stringify(ignoreCoAfter));
}

main().catch((err) => { console.error('Test harness crashed:', err); process.exit(1); });
