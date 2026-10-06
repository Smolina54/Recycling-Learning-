// Verifies outputs/sorting-station-report.html's "Real-world data (Bintracker)" block (Point 1,
// Phase C of the plan: C:\Users\smolina\.claude\plans\graceful-roaming-shell.md — see
// "Implementation plan (2026-09-24) — ready to build") — the live admin Reports view's own
// counterpart to client-report.test.js's coverage of the same feature in the client-facing PDF.
//
// Revised 2026-09-24 alongside the underlying logic itself (superseding the original single
// agree/disagree design): now covers BOTH comparisons — "Current state" (induction accuracy vs.
// real Bintracker cleanliness, right now) and "Induction impact" (real behavior before vs. after
// each tenant's own most recent induction) — reached via the same two-button toggle, plus the
// sample-size floors, the large-vs-moderate gap-magnitude copy split for both comparisons, the
// General Waste/E-Waste exclusion, and (revised again 2026-10-05, see that date's notes in
// sorting-station-report.html itself) the external-only-data no-finding case — per-tenant real data
// only ever exists internally in production, so external-only rows are what gets excluded now,
// the mirror image of the original internalOnly-excluded design.
//
// Why a new dedicated file rather than extending report-ui.test.js or admin-buildings.test.js:
// report-ui.test.js drives the report entirely via "Load sample data" (no Firestore at all), so
// it can never exercise a Firestore-backed feature like this one. admin-buildings.test.js/
// admin-buildings-bintracker.test.js exercise admin-buildings.html (a different page — the
// Bintracker match-review UI, Phase B), not the live Reports view. scoped-report-access.test.js
// is the closest existing precedent — it seeds real Firestore data and drives
// sorting-station-report.html itself via ?emulator=1 + window.__testSignIn — so this file follows
// that exact same pattern, just seeding Bintracker data instead of a /buildingAccess grant.
// Run: npm run test:report-bintracker
const path = require('path');
const url = require('url');
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc, addDoc, collection, Timestamp } = require('firebase/firestore');

const EDGE_PATH = process.env.TEST_BROWSER_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const REPORT_PATH = path.join(__dirname, '..', 'outputs', 'sorting-station-report.html');
const RULES_PATH = path.join(__dirname, '..', 'firestore.rules');

const results = [];
function check(label, cond, extra){ results.push({ label, ok: Boolean(cond), extra: extra || '' }); }

// Induction accuracy is a SUM(avoided)/SUM(total) across a tenant's submissions in scope, not a
// count of documents — so the exact percentage is free to choose via one "real weight" submission
// doc (avoided/total set directly), padded out to `subCount` total contributing docs with 0/0
// entries so the >=3-submissions sample floor is exercised independently of the percentage itself.
async function seedInductionSubs(db, { buildingId, buildingName, tenantId, tenantName, level, stream, pct, subCount, timestamp }){
  for (let i = 0; i < subCount; i++){
    const breakdown = { [stream]: i === 0 ? { avoided: pct, total: 100 } : { avoided: 0, total: 0 } };
    await addDoc(collection(db, 'submissions'), {
      buildingId, buildingName, tenantId, tenantName, level,
      name: 'Test Person', email: `${tenantId}-${i}@example.com`, programId: 'recycling-sorting',
      score: pct, avoided: pct, total: 100, breakdown,
      timestamp: timestamp || Timestamp.now(),
    });
  }
}

// Real Bintracker rows, by contrast, ARE individually-counted documents — `recycledCount` of the
// first `count` rows are contaminated:false (the "good"/recovered signal the comparison logic
// actually reads, since the 2026-10-05 fix moved off the unreliable `wasteOutcome` field), the rest
// contaminated:true, so the exact "real" share is precision-limited by `count` (unlike the
// induction side above). `wasteOutcome` is still stored (matches the real bintrackerRows doc shape)
// but is deliberately uncorrelated with `recycledCount` here — it's no longer read by the
// comparison logic at all, so it must not accidentally make a wrong test pass.
// Defaults to `externalOnly: false` (internal rows) — per that same fix, per-tenant comparisons can
// only ever be computed from internal data (confirmed against real production data: external rows
// carry no per-tenant granularity at all). Pass `externalOnly: true` explicitly only for the one
// case that proves external-only data is now correctly EXCLUDED.
async function seedBintrackerRows(db, { buildingId, tenantRaw, level, stream, count, recycledCount, externalOnly, collectDate }){
  for (let i = 0; i < count; i++){
    await setDoc(doc(collection(db, 'bintrackerRows')), {
      buildingId, bintrackerTenantRaw: tenantRaw, bintrackerLocationRaw: level,
      ourStream: stream, wasteTypeRaw: 'test',
      contaminated: i >= recycledCount,
      externalOnly: externalOnly === true,
      wasteOutcome: 'Recycled',
      collectDate, weight: 10, fetchedAt: Timestamp.now(),
    });
  }
}

async function seedMatch(db, { buildingId, tenantId, tenantName, tenantRaw, level }){
  await setDoc(doc(db, 'bintrackerTenantMatches', `${buildingId}__${tenantId}`), {
    buildingId, tenantId, tenantName, bintrackerTenantRaw: tenantRaw, bintrackerLocationRaw: level,
    confirmedBy: 'esgtradeflex@gmail.com', confirmedAt: Timestamp.now(), status: 'confirmed',
  });
}

async function seed(){
  const testEnv = await initializeTestEnvironment({
    projectId: 'esg-1-98f35',
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  const suffix = Date.now();
  const b1 = 'report-bt-unmapped-' + suffix;
  const b2 = 'report-bt-mapped-' + suffix;
  const buildingName = 'Mapped Building ' + suffix;

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const yesterdayStr = new Date(today.getTime() - 86400000).toISOString().slice(0, 10);

  // Tenant ids, all namespaced under this run's suffix so parallel/repeated runs never collide.
  const T = {};
  ['LowLow', 'GoodGood', 'Case3Large', 'Case3Moderate', 'Case4Large', 'Case4Moderate',
    'AtFloor', 'BelowFloorSubs', 'BelowFloorReal', 'GwEwOnly', 'ExternalOnlyOrganics',
    'ImpactImprovedLarge', 'ImpactImprovedModerate', 'ImpactDeclined', 'ImpactFloorOneSide', 'ImpactUnderThreshold',
  ].forEach(k => { T[k] = `tenant-${k}-${suffix}`; });

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();

    await setDoc(doc(db, 'buildings', b1), { name: 'Unmapped Building ' + suffix });
    await setDoc(doc(db, 'buildings', b2), { name: buildingName, bintrackerBuildingName: 'BT ' + suffix });

    // b1: ordinary submission, nothing Bintracker-related at all — proves graceful absence.
    await addDoc(collection(db, 'submissions'), {
      buildingId: b1, buildingName: 'Unmapped Building ' + suffix, tenantId: 'irrelevant-tenant', tenantName: 'Irrelevant Tenant',
      level: 'Level 1', name: 'Jane Doe', email: 'jane-unmapped@example.com', programId: 'recycling-sorting',
      score: 90, avoided: 9, total: 10, breakdown: { gw: { avoided: 9, total: 10 } }, timestamp: Timestamp.now(),
    });

    // ---- Comparison #1 ("Current state") cases ----
    const c1 = [
      // key, tenantName, stream, level, inductionPct, realPct, realCount, recycledCount
      ['LowLow', 'Tenant Low Low', 'mr', 'Level 2', 30, 40, 10, 4],           // low+low -> agree, concern
      ['GoodGood', 'Tenant Good Good', 'pc', 'Level 3', 90, 90, 10, 9],       // good+good -> agree, no concern
      ['Case3Large', 'Tenant Case3 Large', 'og', 'Level 4', 90, 60, 10, 6],   // gap 30 -> large disagree
      ['Case3Moderate', 'Tenant Case3 Moderate', 'mr', 'Level 5', 99, 70, 10, 7], // gap 29 -> moderate disagree
      ['Case4Large', 'Tenant Case4 Large', 'pc', 'Level 6', 60, 90, 10, 9],   // gap 30 -> large disagree (real better)
      ['Case4Moderate', 'Tenant Case4 Moderate', 'og', 'Level 7', 51, 80, 10, 8], // gap 29 -> moderate disagree (real better)
    ];
    for (const [key, tenantName, stream, level, inductionPct, realPct, realCount, recycledCount] of c1){
      await seedInductionSubs(db, { buildingId: b2, buildingName, tenantId: T[key], tenantName, level, stream, pct: inductionPct, subCount: 3 });
      await seedBintrackerRows(db, { buildingId: b2, tenantRaw: 'BT ' + key, level, stream, count: realCount, recycledCount, collectDate: todayStr });
      await seedMatch(db, { buildingId: b2, tenantId: T[key], tenantName, tenantRaw: 'BT ' + key, level });
    }

    // Exactly at both floors (3 submissions, 5 real rows) -> must still produce a finding.
    await seedInductionSubs(db, { buildingId: b2, buildingName, tenantId: T.AtFloor, tenantName: 'Tenant At Floor', level: 'Level 8', stream: 'mr', pct: 100, subCount: 3 });
    await seedBintrackerRows(db, { buildingId: b2, tenantRaw: 'BT AtFloor', level: 'Level 8', stream: 'mr', count: 5, recycledCount: 5, collectDate: todayStr });
    await seedMatch(db, { buildingId: b2, tenantId: T.AtFloor, tenantName: 'Tenant At Floor', tenantRaw: 'BT AtFloor', level: 'Level 8' });

    // Below the induction-submission floor (2 < 3) despite plenty of real rows -> no finding.
    await seedInductionSubs(db, { buildingId: b2, buildingName, tenantId: T.BelowFloorSubs, tenantName: 'Tenant Below Floor Subs', level: 'Level 9', stream: 'pc', pct: 20, subCount: 2 });
    await seedBintrackerRows(db, { buildingId: b2, tenantRaw: 'BT BelowFloorSubs', level: 'Level 9', stream: 'pc', count: 10, recycledCount: 2, collectDate: todayStr });
    await seedMatch(db, { buildingId: b2, tenantId: T.BelowFloorSubs, tenantName: 'Tenant Below Floor Subs', tenantRaw: 'BT BelowFloorSubs', level: 'Level 9' });

    // Below the real-rows floor (4 < 5) despite the induction floor being met -> no finding.
    await seedInductionSubs(db, { buildingId: b2, buildingName, tenantId: T.BelowFloorReal, tenantName: 'Tenant Below Floor Real', level: 'Level 10', stream: 'og', pct: 20, subCount: 3 });
    await seedBintrackerRows(db, { buildingId: b2, tenantRaw: 'BT BelowFloorReal', level: 'Level 10', stream: 'og', count: 4, recycledCount: 1, collectDate: todayStr });
    await seedMatch(db, { buildingId: b2, tenantId: T.BelowFloorReal, tenantName: 'Tenant Below Floor Real', tenantRaw: 'BT BelowFloorReal', level: 'Level 10' });

    // General Waste + E-Waste: abundant, "obviously findable" data (30% induction / 30% real, low+low,
    // easily over both floors) on the two streams that must NEVER produce a finding on either comparison.
    await seedInductionSubs(db, { buildingId: b2, buildingName, tenantId: T.GwEwOnly, tenantName: 'Tenant GwEw Only', level: 'Level 11', stream: 'gw', pct: 30, subCount: 5 });
    await seedBintrackerRows(db, { buildingId: b2, tenantRaw: 'BT GwEwOnly', level: 'Level 11', stream: 'gw', count: 10, recycledCount: 3, collectDate: todayStr });
    await seedInductionSubs(db, { buildingId: b2, buildingName, tenantId: T.GwEwOnly, tenantName: 'Tenant GwEw Only', level: 'Level 11', stream: 'ew', pct: 30, subCount: 5 });
    await seedBintrackerRows(db, { buildingId: b2, tenantRaw: 'BT GwEwOnly', level: 'Level 11', stream: 'ew', count: 10, recycledCount: 3, collectDate: todayStr });
    await seedMatch(db, { buildingId: b2, tenantId: T.GwEwOnly, tenantName: 'Tenant GwEw Only', tenantRaw: 'BT GwEwOnly', level: 'Level 11' });

    // A tenant whose Organics data is recorded ONLY via external/contractor hauling (externalOnly:
    // true), with zero internal rows — proves the 2026-10-05 fix's real population requirement
    // (internal rows only) correctly excludes external-only data now, the mirror image of the old
    // (pre-fix) "internalOnly gets excluded" behavior this case used to test.
    await seedInductionSubs(db, { buildingId: b2, buildingName, tenantId: T.ExternalOnlyOrganics, tenantName: 'Tenant External Only Organics', level: 'Level 12', stream: 'og', pct: 20, subCount: 3 });
    await seedBintrackerRows(db, { buildingId: b2, tenantRaw: 'BT ExternalOnlyOrganics', level: 'Level 12', stream: 'og', count: 10, recycledCount: 8, externalOnly: true, collectDate: todayStr });
    await seedMatch(db, { buildingId: b2, tenantId: T.ExternalOnlyOrganics, tenantName: 'Tenant External Only Organics', tenantRaw: 'BT ExternalOnlyOrganics', level: 'Level 12' });

    // ---- Comparison #2 ("Induction impact") cases ----
    // Cutoff = latest submission timestamp for the tenant (Timestamp.now(), i.e. "today" in UTC) —
    // before rows use yesterday's date, after rows use today's, matching collectDate < / >= cutoff.
    const impactTenants = [
      ['ImpactImprovedLarge', 'Tenant Impact Improved Large', 'mr', 5, 2, 5, 4],   // 40% -> 80%, gap 40, AT the 5/5 floor
      ['ImpactImprovedModerate', 'Tenant Impact Improved Moderate', 'pc', 8, 3, 7, 4], // 38% -> 57%, gap 19 (moderate)
      ['ImpactDeclined', 'Tenant Impact Declined', 'og', 10, 8, 10, 5],           // 80% -> 50%, gap 30, declined
      ['ImpactFloorOneSide', 'Tenant Impact Floor One Side', 'mr', 4, 2, 20, 15], // before below floor (4<5) -> no finding
      ['ImpactUnderThreshold', 'Tenant Impact Under Threshold', 'pc', 10, 7, 8, 6], // 70% -> 75%, gap 5 -> no finding
    ];
    for (const [key, tenantName, stream, beforeCount, beforeRecycled, afterCount, afterRecycled] of impactTenants){
      const level = 'Impact Level ' + key;
      await addDoc(collection(db, 'submissions'), {
        buildingId: b2, buildingName, tenantId: T[key], tenantName, level,
        name: 'Test Person', email: `${T[key]}@example.com`, programId: 'recycling-sorting',
        score: 80, avoided: 8, total: 10, timestamp: Timestamp.now(),
      });
      await seedBintrackerRows(db, { buildingId: b2, tenantRaw: 'BT ' + key, level, stream, count: beforeCount, recycledCount: beforeRecycled, collectDate: yesterdayStr });
      await seedBintrackerRows(db, { buildingId: b2, tenantRaw: 'BT ' + key, level, stream, count: afterCount, recycledCount: afterRecycled, collectDate: todayStr });
      await seedMatch(db, { buildingId: b2, tenantId: T[key], tenantName, tenantRaw: 'BT ' + key, level });
    }
  });

  return { testEnv, b1, b2, suffix };
}

async function selectProgram(page, programId){
  await page.waitForFunction(
    (id) => document.querySelector(`#programSelector option[value="${id}"]`) !== null,
    { timeout: 10000 },
    programId
  );
  await page.select('#programSelector', programId);
}

async function main(){
  const seedEnv = await seed();
  const browser = await puppeteer.launch({ executablePath: EDGE_PATH, headless: true });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

  try {
    await runFlow(page, seedEnv);
  } catch (err) {
    console.error('CRASHED — dumping diagnostics:', err.message);
    console.error('--- results so far ---');
    for (const r of results){ console.error(`${r.ok ? 'PASS' : 'FAIL'} — ${r.label}${r.extra ? ' :: ' + r.extra : ''}`); }
    await page.screenshot({ path: path.join(__dirname, '..', 'debug-crash.png') }).catch(() => {});
    await browser.close();
    await seedEnv.testEnv.cleanup();
    process.exit(1);
  }

  await browser.close();
  await seedEnv.testEnv.cleanup();

  const unexpectedErrors = consoleErrors.filter(e =>
    !e.includes('Failed to load resource') && !e.includes('400') && !e.includes('Failed to load admins'));
  check('no UNEXPECTED console/page errors during the whole flow', unexpectedErrors.length === 0, unexpectedErrors.join(' || '));

  console.log('\n--- RESULTS ---');
  let allOk = true;
  for (const r of results){
    console.log(`${r.ok ? 'PASS' : 'FAIL'} — ${r.label}${r.extra ? ' :: ' + r.extra : ''}`);
    if (!r.ok) allOk = false;
  }
  process.exit(allOk ? 0 : 1);
}

async function runFlow(page, { b1, b2 }){
  // --- Pass 1: only the unmapped building (b1) in scope -> block must stay hidden/absent ---
  await page.goto(`${url.pathToFileURL(REPORT_PATH).href}?emulator=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('programSelectorRow') &&
    getComputedStyle(document.getElementById('programSelectorRow')).display !== 'none', { timeout: 10000 });
  await selectProgram(page, 'recycling-sorting');
  await page.waitForFunction(
    () => /^\d+$/.test(document.querySelector('#kpiRow .kpi-tile:nth-child(1) .kpi-value')?.textContent.trim() || ''),
    { timeout: 10000 }
  );

  await page.waitForFunction(() => document.querySelectorAll('#filterBuilding option').length >= 3, { timeout: 10000 });
  const unmappedName = await page.$$eval('#filterBuilding option', opts =>
    opts.map(o => o.value).find(v => v.startsWith('Unmapped Building')));
  check('the unmapped building appears as a filter option', Boolean(unmappedName), unmappedName);
  await page.select('#filterBuilding', unmappedName);
  await new Promise(r => setTimeout(r, 500)); // let the fire-and-forget renderBintrackerComparison() settle

  const blockHiddenForUnmapped = await page.$eval('#bintrackerComparisonBlock', el => getComputedStyle(el).display === 'none');
  check('Bintracker block stays hidden when only an unmapped building is in scope (graceful absence)', blockHiddenForUnmapped);

  // --- Pass 2: back to all buildings in scope -> the mapped building's findings appear ---
  await page.select('#filterBuilding', '');
  await new Promise(r => setTimeout(r, 700));

  const blockVisible = await page.$eval('#bintrackerComparisonBlock', el => getComputedStyle(el).display !== 'none');
  check('Bintracker block becomes visible once a mapped building is back in scope', blockVisible);

  // --- "Current state" tab (default active) ---
  const currentActive = await page.$eval('#bintrackerToggleCurrentBtn', el => el.classList.contains('active'));
  check('"Current state" is the default active tab', currentActive);

  const introCurrent = await page.$eval('#bintrackerIntro', el => el.textContent);
  check('current-state intro includes the count-not-weight note', introCurrent.includes('collection count') && introCurrent.includes('not weight'), introCurrent);
  check('current-state intro includes the representativeness honesty note', introCurrent.includes('reflect only the people who completed the induction'), introCurrent);
  check('current-state intro includes the snapshot-not-causality honesty note', introCurrent.includes('snapshot of current data'), introCurrent);

  const currentText = await page.$eval('#bintrackerComparisonList', el => el.textContent.replace(/\s+/g, ' '));

  check('Case 1 (low+low, agree): headline + both percentages',
    currentText.includes('Tenant Low Low') && currentText.includes('low induction result matches low real recycling') && currentText.includes('30%') && currentText.includes('40%'),
    currentText.slice(0, 300));
  check('Case 2 (good+good, agree): headline + both percentages',
    currentText.includes('Tenant Good Good') && currentText.includes('strong induction result matches strong real recycling') && currentText.includes('90%'),
    currentText.slice(0, 300));
  check('Case 3 large gap (30pts, good induction/low real): significant-gap copy + recommendation',
    currentText.includes('Tenant Case3 Large') && currentText.includes('strong induction result, but a significant gap in real recycling') && currentText.includes('30-point gap') && currentText.includes('Consider checking bin signage'),
    currentText.slice(0, 600));
  check('Case 3 moderate gap (29pts): modest-gap copy, no recommendation text',
    currentText.includes('Tenant Case3 Moderate') && currentText.includes('good induction result, with a modest gap in real recycling') && currentText.includes('29-point gap, worth keeping an eye on'),
    currentText.slice(0, 600));
  check('Case 4 large gap (30pts, low induction/good real): "notably better" copy + recommendation',
    currentText.includes('Tenant Case4 Large') && currentText.includes('real recycling is notably better than the induction result suggests') && currentText.includes('30-point gap') && currentText.includes('Worth understanding who is actually responsible'),
    currentText.slice(0, 600));
  check('Case 4 moderate gap (29pts): "somewhat better" copy',
    currentText.includes('Tenant Case4 Moderate') && currentText.includes('real recycling is somewhat better than the induction result suggests') && currentText.includes('29-point gap, worth keeping an eye on'),
    currentText.slice(0, 600));
  check('exactly-at-floor tenant (3 submissions, 5 real rows) still produces a finding',
    currentText.includes('Tenant At Floor'), currentText.slice(0, 300));
  check('below the induction-submission floor (2 < 3) produces no finding despite ample real data',
    !currentText.includes('Tenant Below Floor Subs'), currentText.slice(0, 300));
  check('below the real-rows floor (4 < 5) produces no finding despite the induction floor being met',
    !currentText.includes('Tenant Below Floor Real'), currentText.slice(0, 300));
  check('General Waste / E-Waste never produce a finding, even with abundant seeded data for those streams',
    !currentText.includes('Tenant GwEw Only') && !currentText.includes('General Waste') && !currentText.includes('E-Waste'),
    currentText.slice(0, 300));
  check('external-only Organics rows (no internal data for that tenant) produce no finding',
    !currentText.includes('Tenant External Only Organics'), currentText.slice(0, 300));

  const case1Li = await page.$$eval('#bintrackerComparisonList li', els => els.find(el => el.textContent.includes('Tenant Low Low'))?.className || '');
  check('Case 1 (both low) is flagged as a concern', case1Li.includes('concern'), case1Li);
  const case2Li = await page.$$eval('#bintrackerComparisonList li', els => els.find(el => el.textContent.includes('Tenant Good Good'))?.className || '');
  check('Case 2 (both good) is NOT flagged as a concern', !case2Li.includes('concern'), case2Li);
  const case4LargeLi = await page.$$eval('#bintrackerComparisonList li', els => els.find(el => el.textContent.includes('Tenant Case4 Large'))?.className || '');
  check('Case 4 (real better than induction suggests) is NOT flagged as a concern', !case4LargeLi.includes('concern'), case4LargeLi);

  // Comparison #2's own tenants must never leak into the Current-state tab's list.
  check('Induction-impact-only tenants do not appear in the Current-state tab',
    !currentText.includes('Tenant Impact'), currentText.slice(0, 200));

  // --- Switch to "Induction impact" tab ---
  await page.click('#bintrackerToggleImpactBtn');
  await new Promise(r => setTimeout(r, 150));

  const impactActive = await page.$eval('#bintrackerToggleImpactBtn', el => el.classList.contains('active'));
  const currentNowInactive = await page.$eval('#bintrackerToggleCurrentBtn', el => !el.classList.contains('active'));
  check('clicking the other toggle makes it active and deactivates the first', impactActive && currentNowInactive);

  const introImpact = await page.$eval('#bintrackerIntro', el => el.textContent);
  check('induction-impact intro includes the count-not-weight note', introImpact.includes('collection count') && introImpact.includes('not weight'), introImpact);
  check('induction-impact intro states it is not scoped to the report date filter', introImpact.includes('before/after split is anchored'), introImpact);

  const impactText = await page.$eval('#bintrackerComparisonList', el => el.textContent.replace(/\s+/g, ' '));
  check('only ONE comparison\'s findings show at a time — Current-state tenants disappear once Induction impact is active',
    !impactText.includes('Tenant Low Low') && !impactText.includes('Tenant Case3') && !impactText.includes('Tenant Case4'),
    impactText.slice(0, 200));

  check('Improved, large gap (40pts, AT the 5/5 sample floor): "improved significantly" copy',
    impactText.includes('Tenant Impact Improved Large') && impactText.includes('real recycling improved significantly after the induction') &&
    impactText.includes('40%') && impactText.includes('80%') && impactText.includes('40-point improvement'),
    impactText.slice(0, 400));
  check('Improved, moderate gap (19pts): plain "improved" copy (not "significantly")',
    impactText.includes('Tenant Impact Improved Moderate') && impactText.includes('recycling improved after the induction') &&
    impactText.includes('38%') && impactText.includes('57%') && impactText.includes('19-point improvement'),
    impactText.slice(0, 400));
  check('Declined (30pts): "dropped" copy + recommendation',
    impactText.includes('Tenant Impact Declined') && impactText.includes('real recycling dropped after the induction') &&
    impactText.includes('80%') && impactText.includes('50%') && impactText.includes('30-point drop') &&
    impactText.includes("Worth checking whether something changed in this tenant's space"),
    impactText.slice(0, 400));
  check('one side below the >=5 floor (4 before) produces no finding despite a large gap on paper',
    !impactText.includes('Tenant Impact Floor One Side'), impactText.slice(0, 300));
  check('gap under the 10-point meaningful-change threshold (5pts) produces no finding despite both floors being met',
    !impactText.includes('Tenant Impact Under Threshold'), impactText.slice(0, 300));

  const improvedLargeLi = await page.$$eval('#bintrackerComparisonList li', els => els.find(el => el.textContent.includes('Tenant Impact Improved Large'))?.className || '');
  check('an improved finding is NOT flagged as a concern', !improvedLargeLi.includes('concern'), improvedLargeLi);
  const declinedLi = await page.$$eval('#bintrackerComparisonList li', els => els.find(el => el.textContent.includes('Tenant Impact Declined'))?.className || '');
  check('a declined finding IS flagged as a concern', declinedLi.includes('concern'), declinedLi);

  // --- Switch back to "Current state" — proves the toggle round-trips without a re-fetch/crash ---
  await page.click('#bintrackerToggleCurrentBtn');
  await new Promise(r => setTimeout(r, 150));
  const backToCurrentText = await page.$eval('#bintrackerComparisonList', el => el.textContent.replace(/\s+/g, ' '));
  check('switching back to Current state restores its own findings', backToCurrentText.includes('Tenant Low Low'), backToCurrentText.slice(0, 200));
}

main().catch((err) => { console.error('Test harness crashed:', err); process.exit(1); });
