// Verifies processDiscoveryRows and processOneBuildingRows - the two halves of the nightly
// scheduled Bintracker sync's hybrid design (Workstream 15 Part 4, revised 2026-10-07 after a real
// production finding: a single unscoped pull ran ~7x slower than a scoped-by-name pull, so it could
// be cut short by the time/timeout budget before reaching every building - confirmed live, even an
// already-mapped building with 15,612 rows of real history didn't make it through one run).
//
// The hybrid replaces that one big unscoped pull with two independent passes:
//   - DISCOVERY: a short, unscoped pull, just to spot NEW building names (processDiscoveryRows).
//   - PER-BUILDING: a separate SCOPED (by exact name) pull for every already-mapped building,
//     processed one at a time (processOneBuildingRows) - the fast, reliable path.
// Both are exported as pure-ish functions (take already-fetched rows, do the Firestore
// read/diff/write) specifically so they're testable with controlled row data, no real Bintracker
// network call at all - same "separate the fetch from the processing" split used elsewhere in this
// project (e.g. functions/bintracker.js's own pure diff helpers).
//
// Exercises, against the real Firestore emulator via the Admin SDK (no Auth/Functions emulator
// needed - this is a pure Firestore round trip, same reasoning as
// tests/functions-refreshbintrackerdata.test.js):
//   - processDiscoveryRows: a row whose building name matches nothing already mapped surfaces in
//     discovery/bintrackerBuildings with its candidate tenant(s); an already-mapped name does not.
//   - processOneBuildingRows: one building's scoped rows get stored/aggregated correctly, with the
//     same cost-conscious content-diff write logic as before (unchanged data -> zero writes).
//   - per-building error isolation still holds even though each building is now its own separate
//     call in the real orchestrator - simulated here by calling processOneBuildingRows directly
//     for a building with a broken confirmed tenant match and confirming it throws (the real
//     orchestrator's own try/catch around each building is what turns this into isolation, not
//     anything inside processOneBuildingRows itself).
//
// Run: npm run test:functions-scheduledbintrackerrefresh
const { _processDiscoveryRows, _processOneBuildingRows, _getAdminFirestoreForTests } = require('../functions/index.js');

const results = [];
function check(label, cond, extra) { results.push({ label, ok: Boolean(cond), extra: extra || '' }); }

function fmt(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const db = _getAdminFirestoreForTests();
  const suffix = Date.now();
  const buildingAId = 'nightly-tower-a-' + suffix;
  const buildingBId = 'nightly-tower-b-' + suffix;
  const tenantBId = 'nightly-tenant-b-' + suffix;
  const fromDate = fmt(5);
  const toDate = fmt(0);
  const collectDate = fmt(2);

  await db.doc(`buildings/${buildingAId}`).set({ name: 'Nightly Tower A', bintrackerBuildingName: 'Nightly Demo Building A' });
  await db.doc(`buildings/${buildingBId}`).set({ name: 'Nightly Tower B', bintrackerBuildingName: 'Nightly Demo Building B' });
  await db.doc(`buildings/${buildingBId}/tenants/${tenantBId}`).set({ name: 'Tower B Tenant', levels: ['L1'] });
  // A confirmed match with a BLANK tenantId - writeRecyclingLevelAggregates's own tenant-level
  // step builds a Firestore doc reference from this value, which throws on an empty path segment.
  // A real, deterministic failure (not mocked), used to prove processOneBuildingRows itself
  // surfaces the error (rather than swallowing it) - the real orchestrator's own per-building
  // try/catch is what turns this into isolation from other buildings, not anything in here.
  await db.doc('bintrackerTenantMatches/' + `${buildingBId}__broken`).set({
    buildingId: buildingBId, tenantId: '', tenantName: 'Broken Match',
    bintrackerTenantRaw: 'Tower B Tenant', bintrackerLocationRaw: 'Level 1',
    confirmedBy: 'admin@example.com', status: 'confirmed',
  });

  // ---- processDiscoveryRows: a short, unscoped-style pull mixing an already-mapped building's
  // name with a genuinely new one - only the new one should surface. ----
  const discoveryRows = [
    { building: 'Nightly Demo Building A', tenant: 'Tower A Tenant', primaryLocation: 'Level 1', wasteType: 'General Waste', weight: 1, collectDate },
    { building: 'Brand New Unmapped Tower', tenant: 'Mystery Co', primaryLocation: 'Level 9', wasteType: 'General Waste', weight: 8, collectDate },
  ];
  const mappedNames = ['Nightly Demo Building A', 'Nightly Demo Building B'];
  const discoveredCount = await _processDiscoveryRows(db, discoveryRows, mappedNames);
  check('processDiscoveryRows returns the count of genuinely new building names', discoveredCount === 1, String(discoveredCount));

  const discoverySnap = await db.doc('discovery/bintrackerBuildings').get();
  check('the discovery doc exists after a run', discoverySnap.exists, '');
  const discovered = (discoverySnap.data() || {}).discoveredBuildings || [];
  check('the unmapped building name appears in the discovery doc, with its one candidate tenant',
    discovered.length === 1 && discovered[0].name === 'Brand New Unmapped Tower'
      && discovered[0].tenants.length === 1 && discovered[0].tenants[0].bintrackerTenantRaw === 'Mystery Co',
    JSON.stringify(discovered));
  check('the already-mapped building does NOT appear in the discovery doc',
    !discovered.some((b) => b.name === 'Nightly Demo Building A'), JSON.stringify(discovered));

  // ---- processOneBuildingRows: building A's own scoped rows (as if fetched with
  // request.building='Nightly Demo Building A') ----
  const rowsForA = [
    // 5 rows - MIN_ROWS_FOR_RECYCLING_LEVEL's own floor, so recyclingLevelPct actually gets
    // computed (fewer than 5 real-stream rows is deliberately treated as "not enough sample size").
    { tenant: 'Tower A Tenant', primaryLocation: 'Level 1', wasteType: 'General Waste', weight: 10, collectDate, externalOnly: true, contaminated: false, wasteOutcome: 'Recycled' },
    { tenant: 'Tower A Tenant', primaryLocation: 'Level 1', wasteType: 'Mixed recycling', weight: 20, collectDate, externalOnly: true, contaminated: false, wasteOutcome: 'Recycled' },
    { tenant: 'Tower A Tenant', primaryLocation: 'Level 1', wasteType: 'Paper & cardboard', weight: 15, collectDate, externalOnly: true, contaminated: false, wasteOutcome: 'Recycled' },
    { tenant: 'Tower A Tenant', primaryLocation: 'Level 1', wasteType: 'Organics', weight: 5, collectDate, externalOnly: true, contaminated: false, wasteOutcome: 'Recycled' },
    { tenant: 'Tower A Tenant', primaryLocation: 'Level 1', wasteType: 'e-waste', weight: 5, collectDate, externalOnly: true, contaminated: false, wasteOutcome: 'Recycled' },
    { tenant: 'Tower A Tenant', primaryLocation: 'Level 1', wasteType: 'Not A Real Waste Type', weight: 999, collectDate, externalOnly: true, contaminated: false, wasteOutcome: 'Recycled' },
  ];
  const resultA = await _processOneBuildingRows(db, buildingAId, rowsForA, fromDate, toDate);
  check('rowsSkippedNoStream counts the one unmapped-stream row', resultA.rowsSkippedNoStream === 1, JSON.stringify(resultA));
  check('the first-ever run for this building writes all 5 real rows (nothing yet stored to compare against)',
    resultA.rowsWritten === 5 && resultA.rowsDeleted === 0, JSON.stringify(resultA));

  const rowsASnap = await db.collection('bintrackerRows').where('buildingId', '==', buildingAId).get();
  check('all 5 of building A\'s rows were stored', rowsASnap.size === 5, String(rowsASnap.size));

  const buildingASnap = await db.doc(`buildings/${buildingAId}`).get();
  // gw 10 + mr 20 + pc 15 + og 5 + ew 5 = generated 55; recovered (mr+pc+og) = 40 -> 40/55 = 72.7% -> rounds to 73.
  check('building A\'s recyclingLevelPct was computed from its real rows (5 rows clears the sample-size floor)',
    buildingASnap.data().recyclingLevelPct === 73, JSON.stringify(buildingASnap.data()));
  check('building A got a lastAutoRefreshAt timestamp (successful path)',
    Boolean(buildingASnap.data().lastAutoRefreshAt), JSON.stringify(buildingASnap.data()));

  // ---- Building B: its confirmed match is broken (blank tenantId) - processOneBuildingRows must
  // genuinely throw (not swallow the error), which is what lets the real orchestrator's own
  // try/catch count it as failed without aborting other buildings. ----
  const rowsForB = [
    { tenant: 'Tower B Tenant', primaryLocation: 'Level 1', wasteType: 'General Waste', weight: 5, collectDate, externalOnly: true, contaminated: false, wasteOutcome: 'Recycled' },
  ];
  let buildingBThrew = false;
  try {
    await _processOneBuildingRows(db, buildingBId, rowsForB, fromDate, toDate);
  } catch (err) {
    buildingBThrew = true;
  }
  check('processOneBuildingRows throws for a building with a broken confirmed tenant match (lets the caller isolate it)', buildingBThrew, '');

  const buildingBSnap = await db.doc(`buildings/${buildingBId}`).get();
  check('building B has NO lastAutoRefreshAt (its processing genuinely failed, not silently treated as success)',
    !buildingBSnap.data().lastAutoRefreshAt, JSON.stringify(buildingBSnap.data()));
  // The row write happens BEFORE the aggregate step that then throws, so building B's one row is
  // still stored - matches the real orchestrator's own totalRowsWritten accounting (a partial,
  // genuine write, not a rollback) from before this refactor.
  const rowsBSnap = await db.collection('bintrackerRows').where('buildingId', '==', buildingBId).get();
  check('...but its one row was still written before the failure (no rollback, matches prior behavior)',
    rowsBSnap.size === 1, String(rowsBSnap.size));

  // ---- Cost-conscious re-sync (the user's own explicit concern, 2026-10-07): re-running with the
  // EXACT same input a second time must write NOTHING new - every row is already stored with
  // identical content, so there's nothing to change. This is the common case every single run. ----
  const resultAUnchanged = await _processOneBuildingRows(db, buildingAId, rowsForA, fromDate, toDate);
  check('re-running with identical data writes ZERO rows - unchanged data is never rewritten',
    resultAUnchanged.rowsWritten === 0, JSON.stringify(resultAUnchanged));
  check('...and deletes nothing either (nothing vanished)', resultAUnchanged.rowsDeleted === 0, JSON.stringify(resultAUnchanged));

  // ---- A real correction (same row identity - date/tenant/location/wasteType - different weight)
  // must still be detected and written, proving the diff compares actual content, not just doc id
  // presence (the doc id is derived from date/tenant/location/wasteType only, so a weight
  // correction alone would be invisible to an id-only comparison). ----
  const correctedRowsForA = rowsForA.map((r) => (r.wasteType === 'Mixed recycling' ? { ...r, weight: 25 } : r));
  const resultACorrected = await _processOneBuildingRows(db, buildingAId, correctedRowsForA, fromDate, toDate);
  check('a real content change (same row identity, different weight) is detected and written as exactly 1 row',
    resultACorrected.rowsWritten === 1 && resultACorrected.rowsDeleted === 0, JSON.stringify(resultACorrected));

  // ---- A row that genuinely disappears from the fresh pull (Bintracker removed it) must be
  // deleted, not left behind as stale data. ----
  const rowsWithOneRemoved = correctedRowsForA.filter((r) => r.wasteType !== 'Paper & cardboard');
  const resultARemoved = await _processOneBuildingRows(db, buildingAId, rowsWithOneRemoved, fromDate, toDate);
  check('a row no longer present in the fresh pull gets deleted, not left stale', resultARemoved.rowsDeleted === 1, JSON.stringify(resultARemoved));

  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} — ${r.label}${r.ok ? '' : ' ' + r.extra}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error('Test run crashed:', err); process.exit(1); });
