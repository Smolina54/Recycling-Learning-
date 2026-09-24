// Verifies outputs/admin-buildings.html's Bintracker tenant-match review UI (Workstream 7, Point 1,
// Phase B in the plan: C:\Users\smolina\.claude\plans\graceful-roaming-shell.md). Kept as its own
// dedicated file rather than added to the already-695-line tests/admin-buildings-page.test.js
// (that file covers a different concern — plain building/tenant CRUD — and is already the
// largest Puppeteer suite in this project; bolting an unrelated multi-step matching/review flow
// onto it would make both harder to read and to debug on failure).
//
// This suite only starts firestore+auth (no Functions emulator — same deliberate choice as
// admin-buildings-page.test.js's own "Delete permanently" check and admin-distribution-page.test.js's
// "Send via email" check), so:
//   - the real refreshBintrackerData call is expected to fail gracefully (tested explicitly below);
//   - the matching/review UI itself is tested against bintrackerRows/bintrackerTenantMatches seeded
//     DIRECTLY via Firestore (bypassing the real network call entirely), which is exactly what the
//     page's own client-side read (loadBintrackerDataForBuilding) consumes regardless of whether a
//     real Cloud Function refresh ever produced those rows.
// The real fetch/mapping/storage side of refreshBintrackerData itself is covered by
// tests/functions-refreshbintrackerdata.test.js; the pure findBestMatch()/normalizeForMatching()
// matching logic is covered by tests/bintracker-unit.test.js against functions/bintracker.js's own
// copy — this file only proves the page wires that same logic (duplicated per this codebase's
// established per-page-helper convention) into a real, clickable review UI correctly.
// Run: npm run test:admin-buildings-bintracker
const path = require('path');
const url = require('url');
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc, getDoc, collection } = require('firebase/firestore');

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

// Matches on the tenant's OWN name span (exact text), not a substring of the whole <li>'s text —
// once a tenant gets matched to a Bintracker raw name that happens to equal another tenant's own
// name (as this suite deliberately does, matching "No Match Co" to the raw string "Acme Legal"),
// a substring search against the full <li> text would ambiguously match the wrong tenant's row.
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

// Seeds two buildings directly via Firestore (bypassing the UI entirely, same as
// admin-distribution-page.test.js's own seedTestBuilding): one with NO Bintracker mapping (proves
// graceful absence of the whole feature), and one WITH a mapping, 3 tenants exercising all three
// review states (exact-ish/contains candidate, a candidate needing "Change", and no candidate at
// all), plus bintrackerRows seeded directly so the review UI has real data to react to without any
// live Cloud Function call.
async function seedTestData(){
  const testEnv = await initializeTestEnvironment({
    projectId: 'esg-1-98f35',
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  const suffix = Date.now();
  const unmappedBuildingId = 'test-tower-no-bintracker-' + suffix;
  const unmappedBuildingName = 'Test Tower No Bintracker ' + suffix;
  const mappedBuildingId = 'test-tower-bintracker-' + suffix;
  const mappedBuildingName = 'Test Tower Bintracker ' + suffix;
  const acmeLegalId = 'acme-legal-' + suffix;
  const widgetcoId = 'widgetco-' + suffix;
  const noMatchCoId = 'no-match-co-' + suffix;

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();

    await setDoc(doc(db, 'buildings', unmappedBuildingId), { name: unmappedBuildingName });
    await setDoc(doc(db, 'buildings', unmappedBuildingId, 'tenants', 'only-tenant-' + suffix), {
      name: 'Only Tenant', levels: ['Level 1'], emails: [],
    });

    await setDoc(doc(db, 'buildings', mappedBuildingId), { name: mappedBuildingName, bintrackerBuildingName: 'Bintracker Test Tower' });
    await setDoc(doc(db, 'buildings', mappedBuildingId, 'tenants', acmeLegalId), {
      name: 'Acme Legal', levels: ['Level 5'], emails: [],
    });
    await setDoc(doc(db, 'buildings', mappedBuildingId, 'tenants', widgetcoId), {
      name: 'Widgetco', levels: ['Level 3'], emails: [],
    });
    await setDoc(doc(db, 'buildings', mappedBuildingId, 'tenants', noMatchCoId), {
      name: 'No Match Co', levels: ['Level 9'], emails: [],
    });

    // bintrackerRows — as refreshBintrackerData itself would have written them, minus the fields
    // the review UI doesn't read (ourStream/wasteTypeRaw/contaminated/collectDate/weight/fetchedAt).
    // "Acme Legal" gets 3 rows (2x Level 5, 1x Level 6) to exercise the most-common-location logic;
    // "WIDGETCO PTY LTD" gets 1 row — its own raw name deliberately differs from the tenant's own
    // name ("Widgetco") so it only matches via substring-contains, not exact.
    const rows = [
      { bintrackerTenantRaw: 'Acme Legal', bintrackerLocationRaw: 'Level 5' },
      { bintrackerTenantRaw: 'Acme Legal', bintrackerLocationRaw: 'Level 5' },
      { bintrackerTenantRaw: 'Acme Legal', bintrackerLocationRaw: 'Level 6' },
      { bintrackerTenantRaw: 'WIDGETCO PTY LTD', bintrackerLocationRaw: 'Level 3' },
    ];
    for (const r of rows){
      await setDoc(doc(collection(db, 'bintrackerRows')), {
        buildingId: mappedBuildingId,
        bintrackerTenantRaw: r.bintrackerTenantRaw,
        bintrackerLocationRaw: r.bintrackerLocationRaw,
        ourStream: 'gw',
        wasteTypeRaw: 'General Waste',
        contaminated: false,
        collectDate: '2026-09-01',
        weight: 12.5,
        fetchedAt: new Date(),
      });
    }
  });

  return {
    testEnv, unmappedBuildingId, unmappedBuildingName,
    mappedBuildingId, mappedBuildingName, acmeLegalId, widgetcoId, noMatchCoId,
  };
}

// Reads a bintrackerTenantMatches doc back directly (rules-bypassed, own short-lived testEnv,
// mirrors this project's established "verify a write really landed" pattern) rather than trusting
// the UI's own re-render as proof.
async function readMatchDoc(buildingId, tenantId){
  const testEnv = await initializeTestEnvironment({
    projectId: 'esg-1-98f35',
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  let data = null;
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const snap = await getDoc(doc(context.firestore(), 'bintrackerTenantMatches', `${buildingId}__${tenantId}`));
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

  // refreshBintrackerData/CORS policy: expected — this suite doesn't start the Functions emulator
  // (only firestore,auth), so the real call is expected to fail with a CORS/network error, same
  // reasoning as admin-buildings-page.test.js's own "deleteBuildingPermanently" graceful-failure check.
  const unexpectedErrors = consoleErrors.filter(e =>
    !e.includes('Failed to load resource') && !e.includes('400')
    && !e.includes('refreshBintrackerData') && !e.includes('CORS policy') && !e.includes('Failed to refresh Bintracker data'));
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
    mappedBuildingId, mappedBuildingName, acmeLegalId, widgetcoId, noMatchCoId,
  } = await seedTestData();

  await page.goto(BUILDINGS_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.getElementById('buildingsSection') && getComputedStyle(document.getElementById('buildingsSection')).display !== 'none',
    { timeout: 10000 }
  );

  // Same in-app-modal auto-responder as admin-buildings-page.test.js (Workstream 11 replaced
  // window.alert()/confirm() with a real DOM overlay — there's no native dialog to stub).
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

  // --- Graceful absence: no bintrackerBuildingName set → no Refresh button, no match review ---
  await page.waitForFunction(
    (name) => [...document.querySelectorAll('.building-row h3')].some(el => el.textContent === name),
    { timeout: 8000 }, unmappedBuildingName
  );
  let unmappedRow = await findRowByName(page, '.building-row', unmappedBuildingName);
  await unmappedRow.$eval('.building-toggle-btn', el => el.click());
  await new Promise(r => setTimeout(r, 300));
  unmappedRow = await findRowByName(page, '.building-row', unmappedBuildingName);
  check('a building with no Bintracker mapping shows no "Refresh Bintracker data" button',
    !(await unmappedRow.$('.refresh-bintracker-btn')));
  check('...and no Bintracker match review row for its tenant either',
    !(await unmappedRow.$('.bintracker-match-row')));

  // --- The mapped building: expand it, confirm the Refresh button is present ---
  let mappedRow = await findRowByName(page, '.building-row', mappedBuildingName);
  await mappedRow.$eval('.building-toggle-btn', el => el.click());
  await new Promise(r => setTimeout(r, 300));
  mappedRow = await findRowByName(page, '.building-row', mappedBuildingName);
  check('a building WITH a Bintracker mapping shows the "Refresh Bintracker data" button',
    Boolean(await mappedRow.$('.refresh-bintracker-btn')));

  // --- Clicking Refresh with no Functions emulator running fails gracefully (no crash, no stuck
  // "Refreshing…" state) — mirrors the "Delete permanently" precedent. This must NOT clobber the
  // bintrackerRows already seeded directly above (the real fetch fails before ever reaching
  // Firestore), which the next section relies on. ---
  await mappedRow.$eval('.refresh-bintracker-btn', el => el.click());
  await page.waitForFunction(() => window.__alertCalls && window.__alertCalls.length > 0, { timeout: 8000 });
  check('a failed refresh (no reachable Cloud Function) shows an error alert instead of crashing',
    true);
  mappedRow = await findRowByName(page, '.building-row', mappedBuildingName);
  const refreshBtnAfterFailure = await mappedRow.$('.refresh-bintracker-btn');
  const refreshBtnText = await refreshBtnAfterFailure.evaluate(el => el.textContent);
  check('the Refresh button resets to its normal label (not stuck on "Refreshing…") after the failure',
    refreshBtnText === 'Refresh Bintracker data', refreshBtnText);

  // --- Matching/review UI, driven by the bintrackerRows seeded directly via Firestore ---
  await page.waitForFunction(
    () => [...document.querySelectorAll('.bintracker-match-row')].some(r => r.textContent.includes('Acme Legal')),
    { timeout: 8000 }
  );

  mappedRow = await findRowByName(page, '.building-row', mappedBuildingName);
  const acmeLi = await findTenantLi(mappedRow, 'Acme Legal');
  const acmeMatchText = await acmeLi.$eval('.bintracker-match-row', el => el.textContent);
  check('Acme Legal (an exact-name match) shows a suggested candidate with "exact match" confidence',
    acmeMatchText.includes('Acme Legal') && acmeMatchText.includes('exact match'), acmeMatchText);

  const widgetcoLi = await findTenantLi(mappedRow, 'Widgetco');
  const widgetcoMatchText = await widgetcoLi.$eval('.bintracker-match-row', el => el.textContent);
  check('Widgetco (matches "WIDGETCO PTY LTD" only via substring) shows a "contains match" candidate',
    widgetcoMatchText.includes('WIDGETCO PTY LTD') && widgetcoMatchText.includes('contains match'), widgetcoMatchText);

  const noMatchLi = await findTenantLi(mappedRow, 'No Match Co');
  const noMatchText = await noMatchLi.$eval('.bintracker-match-row', el => el.textContent);
  check('No Match Co (shares no words with any raw Bintracker tenant) shows "No Bintracker match found"',
    noMatchText.includes('No Bintracker match found for "No Match Co"'), noMatchText);
  check('...with a "Pick manually" action, not a Confirm button (nothing to confirm)',
    Boolean(await noMatchLi.$('.bintracker-open-change-btn')) && !(await noMatchLi.$('.bintracker-confirm-candidate-btn')));

  // --- Confirm the suggested candidate for Acme Legal ---
  await acmeLi.$eval('.bintracker-confirm-candidate-btn', el => el.click());
  await page.waitForFunction(
    () => [...document.querySelectorAll('.bintracker-match-row')].some(r => r.textContent.includes('Bintracker match: "Acme Legal" ✓')),
    { timeout: 8000 }
  );
  mappedRow = await findRowByName(page, '.building-row', mappedBuildingName);
  const acmeLiAfterConfirm = await findTenantLi(mappedRow, 'Acme Legal');
  check('after confirming, Acme Legal shows the plain confirmed-match line with a Change link',
    Boolean(await acmeLiAfterConfirm.$('.bintracker-open-change-btn')) && !(await acmeLiAfterConfirm.$('.bintracker-confirm-candidate-btn')));

  const acmeMatchDoc = await readMatchDoc(mappedBuildingId, acmeLegalId);
  check('the confirmed match was really written to bintrackerTenantMatches, not just shown in the UI',
    Boolean(acmeMatchDoc), JSON.stringify(acmeMatchDoc));
  check('the written doc has the expected shape (status/bintrackerTenantRaw/tenantName/confirmedBy)',
    acmeMatchDoc && acmeMatchDoc.status === 'confirmed' && acmeMatchDoc.bintrackerTenantRaw === 'Acme Legal'
      && acmeMatchDoc.tenantName === 'Acme Legal' && acmeMatchDoc.buildingId === mappedBuildingId
      && acmeMatchDoc.tenantId === acmeLegalId && acmeMatchDoc.confirmedBy === 'esgtradeflex@gmail.com',
    JSON.stringify(acmeMatchDoc));
  check('the most-common bintrackerLocationRaw (2x Level 5 vs 1x Level 6) was computed correctly',
    acmeMatchDoc && acmeMatchDoc.bintrackerLocationRaw === 'Level 5', JSON.stringify(acmeMatchDoc));

  // --- The "Change" picker flow: for Widgetco, open the picker instead of confirming the
  // suggested candidate, and pick a value explicitly ---
  // Re-fetch fresh (the earlier `widgetcoLi` handle was captured before Acme Legal's confirm
  // click re-rendered #buildingsList's whole innerHTML, detaching it from the live document —
  // same stale-handle trap already documented in admin-buildings-page.test.js).
  mappedRow = await findRowByName(page, '.building-row', mappedBuildingName);
  const widgetcoLiForChange = await findTenantLi(mappedRow, 'Widgetco');
  await widgetcoLiForChange.$eval('.bintracker-open-change-btn', el => el.click());
  await page.waitForFunction(
    () => [...document.querySelectorAll('.bintracker-manual-select')].length > 0, { timeout: 8000 }
  );
  mappedRow = await findRowByName(page, '.building-row', mappedBuildingName);
  const widgetcoLiChanging = await findTenantLi(mappedRow, 'Widgetco');
  const selectOptions = await widgetcoLiChanging.$eval('.bintracker-manual-select', el => [...el.options].map(o => o.value));
  check('the "Change" picker lists every distinct raw Bintracker tenant string seen for this building, plus a blank option',
    selectOptions.includes('') && selectOptions.includes('Acme Legal') && selectOptions.includes('WIDGETCO PTY LTD'),
    JSON.stringify(selectOptions));

  // Confirming with nothing picked is rejected with a clear alert, not a silent/garbage write.
  const alertCountBeforeEmptyPick = await page.evaluate(() => window.__alertCalls.length);
  await widgetcoLiChanging.$eval('.bintracker-confirm-manual-btn', el => el.click());
  await new Promise(r => setTimeout(r, 300));
  const alertsAfterEmptyPick = await page.evaluate((n) => window.__alertCalls.slice(n), alertCountBeforeEmptyPick);
  check('confirming the manual picker with nothing selected shows a clear alert instead of writing garbage',
    alertsAfterEmptyPick.some(a => a.includes('Pick a Bintracker tenant first')), JSON.stringify(alertsAfterEmptyPick));

  await widgetcoLiChanging.$eval('.bintracker-manual-select', (el) => {
    el.value = 'WIDGETCO PTY LTD';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await widgetcoLiChanging.$eval('.bintracker-confirm-manual-btn', el => el.click());
  await page.waitForFunction(
    () => [...document.querySelectorAll('.bintracker-match-row')].some(r => r.textContent.includes('Bintracker match: "WIDGETCO PTY LTD" ✓')),
    { timeout: 8000 }
  );
  const widgetcoMatchDoc = await readMatchDoc(mappedBuildingId, widgetcoId);
  check('the manually-picked match for Widgetco was written correctly',
    widgetcoMatchDoc && widgetcoMatchDoc.status === 'confirmed' && widgetcoMatchDoc.bintrackerTenantRaw === 'WIDGETCO PTY LTD'
      && widgetcoMatchDoc.bintrackerLocationRaw === 'Level 3', JSON.stringify(widgetcoMatchDoc));

  // --- "Pick manually" for a tenant with no suggested candidate at all (No Match Co) ---
  mappedRow = await findRowByName(page, '.building-row', mappedBuildingName);
  const noMatchLiForPick = await findTenantLi(mappedRow, 'No Match Co');
  await noMatchLiForPick.$eval('.bintracker-open-change-btn', el => el.click());
  await page.waitForFunction(
    () => [...document.querySelectorAll('.bintracker-manual-select')].length > 0, { timeout: 8000 }
  );
  mappedRow = await findRowByName(page, '.building-row', mappedBuildingName);
  const noMatchLiChanging = await findTenantLi(mappedRow, 'No Match Co');
  await noMatchLiChanging.$eval('.bintracker-manual-select', (el) => {
    el.value = 'Acme Legal';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await noMatchLiChanging.$eval('.bintracker-confirm-manual-btn', el => el.click());
  // Scoped to the specific "No Match Co" <li> (not just any row) — by this point Acme Legal's own
  // row already shows an identical "Bintracker match: ... ✓" line for a different tenant, so an
  // unscoped search across every .bintracker-match-row could match the wrong one.
  await page.waitForFunction(
    () => {
      const li = [...document.querySelectorAll('.tenant-list li')].find(el => el.textContent.includes('No Match Co'));
      return Boolean(li) && li.textContent.includes('Bintracker match: "Acme Legal" ✓');
    },
    { timeout: 8000 }
  );
  const noMatchCoMatchDoc = await readMatchDoc(mappedBuildingId, noMatchCoId);
  check('a tenant with no suggested candidate can still be matched manually via "Pick manually"',
    noMatchCoMatchDoc && noMatchCoMatchDoc.status === 'confirmed' && noMatchCoMatchDoc.bintrackerTenantRaw === 'Acme Legal',
    JSON.stringify(noMatchCoMatchDoc));

  // --- Cancel: opening "Change" on an already-confirmed match and cancelling leaves it untouched ---
  mappedRow = await findRowByName(page, '.building-row', mappedBuildingName);
  const acmeLiForCancelTest = await findTenantLi(mappedRow, 'Acme Legal');
  await acmeLiForCancelTest.$eval('.bintracker-open-change-btn', el => el.click());
  await page.waitForFunction(
    () => [...document.querySelectorAll('.bintracker-manual-select')].length > 0, { timeout: 8000 }
  );
  mappedRow = await findRowByName(page, '.building-row', mappedBuildingName);
  const acmeLiChanging = await findTenantLi(mappedRow, 'Acme Legal');
  const preselected = await acmeLiChanging.$eval('.bintracker-manual-select', el => el.value);
  check('opening "Change" on an already-confirmed match pre-selects its current raw value',
    preselected === 'Acme Legal', preselected);
  await acmeLiChanging.$eval('.bintracker-cancel-change-btn', el => el.click());
  await new Promise(r => setTimeout(r, 300));
  mappedRow = await findRowByName(page, '.building-row', mappedBuildingName);
  const acmeLiAfterCancel = await findTenantLi(mappedRow, 'Acme Legal');
  check('cancelling "Change" reverts back to the plain confirmed-match display',
    Boolean(await acmeLiAfterCancel.$('.bintracker-open-change-btn')) && !(await acmeLiAfterCancel.$('.bintracker-manual-select')));
  const acmeMatchDocAfterCancel = await readMatchDoc(mappedBuildingId, acmeLegalId);
  check('cancelling did not change the previously-confirmed match doc',
    acmeMatchDocAfterCancel && acmeMatchDocAfterCancel.bintrackerTenantRaw === 'Acme Legal', JSON.stringify(acmeMatchDocAfterCancel));
}

main().catch((err) => { console.error('Test harness crashed:', err); process.exit(1); });
