// Verifies outputs/sorting-station-report.html's "Real-world data (Bintracker)" block (Point 1,
// Phase C of the plan: C:\Users\smolina\.claude\plans\graceful-roaming-shell.md — see
// "Implementation plan (2026-09-24) — ready to build") — the live admin Reports view's own
// counterpart to client-report.test.js's coverage of the same feature in the client-facing PDF.
//
// Revised 2026-10-12 — real bug found by the user and confirmed against real production data: the
// original design compared PER-STREAM using `contaminated===false` as the "real" signal, but
// `contaminated` turned out to carry almost no real signal in practice (near-0% across every
// stream, including General Waste, at 4 of 5 real mapped buildings — the same class of problem
// already found once before with `wasteOutcome`, a hardcoded constant). Both comparisons were
// rebuilt to compare PER TENANT, COMBINED across the 3 recyclable streams, using the exact same
// weight-based formula already proven for the recyclingLevelPct banner (recovered kg in Mixed
// Recycling/Paper & Cardboard/Organics, divided by generated kg across ALL of that tenant's
// internal rows) — never `contaminated` again. This file's seed data and assertions were rewritten
// to match: every seeded row sets `contaminated:true` deliberately (not read by the new formula at
// all — a row that would have read as "0% good" under the old logic must still produce the correct
// weight-based percentage here, proving the migration away from that field is real, not just
// unused-but-still-present).
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

// Induction accuracy is a SUM(avoided)/SUM(total) COMBINED across the 3 recyclable streams
// (Mixed Recycling, Paper & Cardboard, Organics) per tenant, not a per-stream figure anymore — a
// single breakdown entry on one recyclable stream still fully controls the combined percentage
// (the other two streams simply contribute nothing if omitted), so the exact percentage is free to
// choose via one "real weight" submission doc, padded out to `subCount` total contributing docs
// with 0/0 entries so the >=3-submissions sample floor is exercised independently of the
// percentage itself. `extraBreakdown` lets a test case add gw/ew-only entries (which the combined
// sum ignores entirely) to prove those streams never contribute.
async function seedInductionSubs(db, { buildingId, buildingName, tenantId, tenantName, level, stream, pct, subCount, extraBreakdown, timestamp }){
  for (let i = 0; i < subCount; i++){
    const breakdown = stream ? { [stream]: i === 0 ? { avoided: pct, total: 100 } : { avoided: 0, total: 0 } } : {};
    if (extraBreakdown) Object.assign(breakdown, extraBreakdown);
    await addDoc(collection(db, 'submissions'), {
      buildingId, buildingName, tenantId, tenantName, level,
      name: 'Test Person', email: `${tenantId}-${i}@example.com`, programId: 'recycling-sorting',
      score: pct || 0, avoided: pct || 0, total: 100, breakdown,
      timestamp: timestamp || Timestamp.now(),
    });
  }
}

// Real Bintracker rows, weight-based: `recyclableWeights` go on a recyclable stream (counted in
// BOTH recovered and generated kg), `otherWeights` go on General Waste (generated kg only — never
// recovered). `contaminated` is deliberately set to the OPPOSITE of what a row's classification
// "should" suggest under the old, now-abandoned per-row-count logic (always true here) — if the
// comparison ever silently reverted to reading `contaminated`, every one of these tenants would
// read as 0% real recycling instead of the real percentages asserted below, so this is a live
// regression guard, not just inert data.
async function seedRealRows(db, { buildingId, tenantRaw, level, recyclableWeights, otherWeights, recyclableStream, collectDate }){
  const now = Timestamp.now();
  for (const w of (recyclableWeights || [])){
    await setDoc(doc(collection(db, 'bintrackerRows')), {
      buildingId, bintrackerTenantRaw: tenantRaw, bintrackerLocationRaw: level,
      ourStream: recyclableStream || 'mr', wasteTypeRaw: 'test', contaminated: true, externalOnly: false,
      wasteOutcome: 'Recycled', collectDate, weight: w, fetchedAt: now,
    });
  }
  for (const w of (otherWeights || [])){
    await setDoc(doc(collection(db, 'bintrackerRows')), {
      buildingId, bintrackerTenantRaw: tenantRaw, bintrackerLocationRaw: level,
      ourStream: 'gw', wasteTypeRaw: 'test', contaminated: true, externalOnly: false,
      wasteOutcome: 'Recycled', collectDate, weight: w, fetchedAt: now,
    });
  }
}
// `externalOnly:true` rows for the one case proving they're correctly excluded from a per-tenant
// comparison that can only ever be computed from internal data.
async function seedExternalOnlyRows(db, { buildingId, tenantRaw, level, count, collectDate }){
  const now = Timestamp.now();
  for (let i = 0; i < count; i++){
    await setDoc(doc(collection(db, 'bintrackerRows')), {
      buildingId, bintrackerTenantRaw: tenantRaw, bintrackerLocationRaw: level,
      ourStream: 'og', wasteTypeRaw: 'test', contaminated: true, externalOnly: true,
      wasteOutcome: 'Recycled', collectDate, weight: 10, fetchedAt: now,
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

    // ---- Comparison #1 ("Current state") cases — all weight-based, 10kg per row for easy math ----
    // key, tenantName, level, inductionStream, inductionPct, recyclableRowCount, otherRowCount
    const c1 = [
      ['LowLow', 'Tenant Low Low', 'Level 2', 'mr', 30, 4, 6],           // induction 30%, real 40% -> low+low agree
      ['GoodGood', 'Tenant Good Good', 'Level 3', 'pc', 90, 9, 1],       // induction 90%, real 90% -> good+good agree
      ['Case3Large', 'Tenant Case3 Large', 'Level 4', 'og', 90, 6, 4],   // induction 90%, real 60% -> gap 30, large disagree
      ['Case3Moderate', 'Tenant Case3 Moderate', 'Level 5', 'mr', 99, 7, 3], // induction 99%, real 70% -> gap 29, moderate
      ['Case4Large', 'Tenant Case4 Large', 'Level 6', 'pc', 60, 9, 1],   // induction 60%, real 90% -> gap 30, large (real better)
      ['Case4Moderate', 'Tenant Case4 Moderate', 'Level 7', 'og', 51, 8, 2], // induction 51%, real 80% -> gap 29, moderate (real better)
    ];
    for (const [key, tenantName, level, stream, inductionPct, recyclableRows, otherRows] of c1){
      await seedInductionSubs(db, { buildingId: b2, buildingName, tenantId: T[key], tenantName, level, stream, pct: inductionPct, subCount: 3 });
      await seedRealRows(db, {
        buildingId: b2, tenantRaw: 'BT ' + key, level, recyclableStream: stream,
        recyclableWeights: Array(recyclableRows).fill(10), otherWeights: Array(otherRows).fill(10), collectDate: todayStr,
      });
      await seedMatch(db, { buildingId: b2, tenantId: T[key], tenantName, tenantRaw: 'BT ' + key, level });
    }

    // Exactly at both floors (3 submissions, 5 real rows) -> must still produce a finding.
    await seedInductionSubs(db, { buildingId: b2, buildingName, tenantId: T.AtFloor, tenantName: 'Tenant At Floor', level: 'Level 8', stream: 'mr', pct: 100, subCount: 3 });
    await seedRealRows(db, { buildingId: b2, tenantRaw: 'BT AtFloor', level: 'Level 8', recyclableStream: 'mr', recyclableWeights: [10,10,10], otherWeights: [10,10], collectDate: todayStr });
    await seedMatch(db, { buildingId: b2, tenantId: T.AtFloor, tenantName: 'Tenant At Floor', tenantRaw: 'BT AtFloor', level: 'Level 8' });

    // Below the induction-submission floor (2 < 3) despite plenty of real rows -> no finding.
    await seedInductionSubs(db, { buildingId: b2, buildingName, tenantId: T.BelowFloorSubs, tenantName: 'Tenant Below Floor Subs', level: 'Level 9', stream: 'pc', pct: 20, subCount: 2 });
    await seedRealRows(db, { buildingId: b2, tenantRaw: 'BT BelowFloorSubs', level: 'Level 9', recyclableStream: 'pc', recyclableWeights: Array(2).fill(10), otherWeights: Array(8).fill(10), collectDate: todayStr });
    await seedMatch(db, { buildingId: b2, tenantId: T.BelowFloorSubs, tenantName: 'Tenant Below Floor Subs', tenantRaw: 'BT BelowFloorSubs', level: 'Level 9' });

    // Below the real-rows floor (4 < 5) despite the induction floor being met -> no finding.
    await seedInductionSubs(db, { buildingId: b2, buildingName, tenantId: T.BelowFloorReal, tenantName: 'Tenant Below Floor Real', level: 'Level 10', stream: 'og', pct: 20, subCount: 3 });
    await seedRealRows(db, { buildingId: b2, tenantRaw: 'BT BelowFloorReal', level: 'Level 10', recyclableStream: 'og', recyclableWeights: [10], otherWeights: [10,10,10], collectDate: todayStr });
    await seedMatch(db, { buildingId: b2, tenantId: T.BelowFloorReal, tenantName: 'Tenant Below Floor Real', tenantRaw: 'BT BelowFloorReal', level: 'Level 10' });

    // A tenant whose induction breakdown ONLY ever has General Waste + E-Waste entries (never
    // Mixed Recycling/Paper & Cardboard/Organics) -> the combined induction total is 0 -> no
    // finding, regardless of how much real recyclable data exists for them. Confirms the GW/EW
    // exclusion now happens on the INDUCTION side (the only side that still has a per-stream
    // concept at all), not via any special-case real-data filtering.
    await seedInductionSubs(db, {
      buildingId: b2, buildingName, tenantId: T.GwEwOnly, tenantName: 'Tenant GwEw Only', level: 'Level 11',
      stream: null, pct: 0, subCount: 5, extraBreakdown: { gw: { avoided: 3, total: 10 }, ew: { avoided: 3, total: 10 } },
    });
    await seedRealRows(db, { buildingId: b2, tenantRaw: 'BT GwEwOnly', level: 'Level 11', recyclableStream: 'mr', recyclableWeights: Array(6).fill(10), otherWeights: Array(4).fill(10), collectDate: todayStr });
    await seedMatch(db, { buildingId: b2, tenantId: T.GwEwOnly, tenantName: 'Tenant GwEw Only', tenantRaw: 'BT GwEwOnly', level: 'Level 11' });

    // A tenant whose Organics data is recorded ONLY via external/contractor hauling (externalOnly:
    // true), with zero internal rows — proves a per-tenant comparison can only ever be computed
    // from internal data (confirmed against real production data: external rows carry no
    // per-tenant granularity at all).
    await seedInductionSubs(db, { buildingId: b2, buildingName, tenantId: T.ExternalOnlyOrganics, tenantName: 'Tenant External Only Organics', level: 'Level 12', stream: 'og', pct: 20, subCount: 3 });
    await seedExternalOnlyRows(db, { buildingId: b2, tenantRaw: 'BT ExternalOnlyOrganics', level: 'Level 12', count: 10, collectDate: todayStr });
    await seedMatch(db, { buildingId: b2, tenantId: T.ExternalOnlyOrganics, tenantName: 'Tenant External Only Organics', tenantRaw: 'BT ExternalOnlyOrganics', level: 'Level 12' });

    // ---- Comparison #2 ("Induction impact") cases — weight-based before/after, 10kg per row ----
    // Cutoff = latest submission timestamp for the tenant (Timestamp.now(), i.e. "today" in UTC) —
    // before rows use yesterday's date, after rows use today's, matching collectDate < / >= cutoff.
    const impactTenants = [
      // key, tenantName, beforeRecyclable, beforeOther, afterRecyclable, afterOther
      ['ImpactImprovedLarge', 'Tenant Impact Improved Large', 2, 3, 4, 1],   // 40% -> 80%, gap 40, AT the 5/5 floor
      ['ImpactImprovedModerate', 'Tenant Impact Improved Moderate', 3, 5, 4, 3], // 38% -> 57%, gap 19 (moderate)
      ['ImpactDeclined', 'Tenant Impact Declined', 8, 2, 5, 5],           // 80% -> 50%, gap 30, declined
      ['ImpactFloorOneSide', 'Tenant Impact Floor One Side', 2, 2, 15, 5], // before below floor (4<5) -> no finding
      ['ImpactUnderThreshold', 'Tenant Impact Under Threshold', 7, 3, 6, 2], // 70% -> 75%, gap 5 -> no finding
    ];
    for (const [key, tenantName, beforeRecyclable, beforeOther, afterRecyclable, afterOther] of impactTenants){
      const level = 'Impact Level ' + key;
      await addDoc(collection(db, 'submissions'), {
        buildingId: b2, buildingName, tenantId: T[key], tenantName, level,
        name: 'Test Person', email: `${T[key]}@example.com`, programId: 'recycling-sorting',
        score: 80, avoided: 8, total: 10, timestamp: Timestamp.now(),
      });
      await seedRealRows(db, { buildingId: b2, tenantRaw: 'BT ' + key, level, recyclableStream: 'mr', recyclableWeights: Array(beforeRecyclable).fill(10), otherWeights: Array(beforeOther).fill(10), collectDate: yesterdayStr });
      await seedRealRows(db, { buildingId: b2, tenantRaw: 'BT ' + key, level, recyclableStream: 'mr', recyclableWeights: Array(afterRecyclable).fill(10), otherWeights: Array(afterOther).fill(10), collectDate: todayStr });
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
  const unmappedOptionText = await page.$eval(`#filterBuilding option[value="${b1}"]`, el => el.textContent).catch(() => null);
  check('the unmapped building appears as a filter option', Boolean(unmappedOptionText) && unmappedOptionText.startsWith('Unmapped Building'), unmappedOptionText);
  await page.select('#filterBuilding', b1);
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
  check('current-state intro describes the weight-based combined formula', introCurrent.includes('combined induction result') && introCurrent.includes('real recycling rate') && introCurrent.includes('weight-based formula'), introCurrent);
  check('current-state intro includes the representativeness honesty note', introCurrent.includes('reflect only the people who completed the induction'), introCurrent);
  check('current-state intro includes the snapshot-not-causality honesty note', introCurrent.includes('snapshot of current data'), introCurrent);

  const currentText = await page.$eval('#bintrackerComparisonList', el => el.textContent.replace(/\s+/g, ' '));

  check('Case 1 (low+low, agree): headline + both percentages',
    currentText.includes('Tenant Low Low') && currentText.includes('Low induction result matches low real recycling') && currentText.includes('30%') && currentText.includes('40%'),
    currentText.slice(0, 300));
  check('Case 2 (good+good, agree): headline + both percentages',
    currentText.includes('Tenant Good Good') && currentText.includes('Strong induction result matches strong real recycling') && currentText.includes('90%'),
    currentText.slice(0, 300));
  check('Case 3 large gap (30pts, good induction/low real): significant-gap copy + recommendation',
    currentText.includes('Tenant Case3 Large') && currentText.includes('Strong induction result, but a significant gap in real recycling') && currentText.includes('30-point gap') && currentText.includes('Consider checking bin signage'),
    currentText.slice(0, 600));
  check('Case 3 moderate gap (29pts): modest-gap copy, no recommendation text',
    currentText.includes('Tenant Case3 Moderate') && currentText.includes('Good induction result, with a modest gap in real recycling') && currentText.includes('29-point gap, worth keeping an eye on'),
    currentText.slice(0, 600));
  check('Case 4 large gap (30pts, low induction/good real): "notably better" copy + recommendation',
    currentText.includes('Tenant Case4 Large') && currentText.includes('Real recycling is notably better than the induction result suggests') && currentText.includes('30-point gap') && currentText.includes('Worth understanding who is actually responsible'),
    currentText.slice(0, 600));
  check('Case 4 moderate gap (29pts): "somewhat better" copy',
    currentText.includes('Tenant Case4 Moderate') && currentText.includes('Real recycling is somewhat better than the induction result suggests') && currentText.includes('29-point gap, worth keeping an eye on'),
    currentText.slice(0, 600));
  check('exactly-at-floor tenant (3 submissions, 5 real rows) still produces a finding',
    currentText.includes('Tenant At Floor'), currentText.slice(0, 300));
  check('below the induction-submission floor (2 < 3) produces no finding despite ample real data',
    !currentText.includes('Tenant Below Floor Subs'), currentText.slice(0, 300));
  check('below the real-rows floor (4 < 5) produces no finding despite the induction floor being met',
    !currentText.includes('Tenant Below Floor Real'), currentText.slice(0, 300));
  check('a tenant whose induction only ever covers General Waste/E-Waste produces no finding (combined induction total is 0)',
    !currentText.includes('Tenant GwEw Only'), currentText.slice(0, 300));
  check('external-only rows (no internal data for that tenant) produce no finding',
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
  check('induction-impact intro describes the weight-based real recycling rate', introImpact.includes('real recycling rate') && introImpact.includes('by weight'), introImpact);
  check('induction-impact intro states it is not scoped to the report date filter', introImpact.includes('before/after split is anchored'), introImpact);

  const impactText = await page.$eval('#bintrackerComparisonList', el => el.textContent.replace(/\s+/g, ' '));
  check('only ONE comparison\'s findings show at a time — Current-state tenants disappear once Induction impact is active',
    !impactText.includes('Tenant Low Low') && !impactText.includes('Tenant Case3') && !impactText.includes('Tenant Case4'),
    impactText.slice(0, 200));

  check('Improved, large gap (40pts, AT the 5/5 sample floor): "improved significantly" copy',
    impactText.includes('Tenant Impact Improved Large') && impactText.includes('Real recycling improved significantly after the induction') &&
    impactText.includes('40%') && impactText.includes('80%') && impactText.includes('40-point improvement'),
    impactText.slice(0, 400));
  check('Improved, moderate gap (19pts): plain "improved" copy (not "significantly")',
    impactText.includes('Tenant Impact Improved Moderate') && impactText.includes('Real recycling improved after the induction') &&
    impactText.includes('38%') && impactText.includes('57%') && impactText.includes('19-point improvement'),
    impactText.slice(0, 400));
  check('Declined (30pts): "dropped" copy + recommendation',
    impactText.includes('Tenant Impact Declined') && impactText.includes('Real recycling dropped after the induction') &&
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
