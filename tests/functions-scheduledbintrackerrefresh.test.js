// Verifies processBintrackerRowsAndStore - the core of the nightly scheduled Bintracker sync
// (Workstream 15 Part 4, 2026-10-07), split out of runBintrackerUnscopedNightlySync specifically
// so it's testable with controlled row data, with no real Bintracker network call at all (the
// exact same "separate the fetch from the processing" split already used elsewhere in this
// project, e.g. functions/bintracker.js's own pure diff helpers).
//
// Exercises, against the real Firestore emulator via the Admin SDK (no Auth/Functions emulator
// needed - this is a pure Firestore round trip, same reasoning as
// tests/functions-refreshbintrackerdata.test.js):
//   - matched rows get stored under the right buildingId and recyclingLevelPct gets computed;
//   - a row whose building name matches nothing gets surfaced in discovery/bintrackerBuildings
//     instead of being silently dropped or crashing;
//   - one building's write genuinely failing does not abort processing of the other buildings
//     (per-building error isolation) - simulated via a confirmed bintrackerTenantMatches doc with
//     a blank tenantId, which makes writeRecyclingLevelAggregates's own tenant-level Firestore
//     doc reference throw (an empty path segment), a real, deterministic failure rather than a
//     mocked one.
//
// Run: npm run test:functions-scheduledbintrackerrefresh
const { _processBintrackerRowsAndStore, _getAdminFirestoreForTests } = require('../functions/index.js');

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
  // A real, deterministic failure (not mocked), used to prove building A's processing still
  // completes even though building B's does not.
  await db.doc('bintrackerTenantMatches/' + `${buildingBId}__broken`).set({
    buildingId: buildingBId, tenantId: '', tenantName: 'Broken Match',
    bintrackerTenantRaw: 'Tower B Tenant', bintrackerLocationRaw: 'Level 1',
    confirmedBy: 'admin@example.com', status: 'confirmed',
  });

  // Raw rows in the exact shape fetchBintrackerCollections() returns (building/tenant/
  // primaryLocation/wasteType/weight/collectDate/contaminated/externalOnly/wasteOutcome) -
  // deliberately unscoped across 2 mapped buildings plus one name that matches neither, mirroring
  // a real nightly sweep's mixed response.
  const rawRows = [
    // 5 rows for building A - MIN_ROWS_FOR_RECYCLING_LEVEL's own floor, so recyclingLevelPct
    // actually gets computed (fewer than 5 real-stream rows is deliberately treated as "not
    // enough sample size" and leaves the field unset, per computeRecyclingLevelPct's own design).
    { building: 'Nightly Demo Building A', tenant: 'Tower A Tenant', primaryLocation: 'Level 1', wasteType: 'General Waste', weight: 10, collectDate, externalOnly: true, contaminated: false, wasteOutcome: 'Recycled' },
    { building: 'Nightly Demo Building A', tenant: 'Tower A Tenant', primaryLocation: 'Level 1', wasteType: 'Mixed recycling', weight: 20, collectDate, externalOnly: true, contaminated: false, wasteOutcome: 'Recycled' },
    { building: 'nightly demo building a', tenant: 'Tower A Tenant', primaryLocation: 'Level 1', wasteType: 'Paper & cardboard', weight: 15, collectDate, externalOnly: true, contaminated: false, wasteOutcome: 'Recycled' }, // case/whitespace-insensitive match
    { building: 'Nightly Demo Building A', tenant: 'Tower A Tenant', primaryLocation: 'Level 1', wasteType: 'Organics', weight: 5, collectDate, externalOnly: true, contaminated: false, wasteOutcome: 'Recycled' },
    { building: 'Nightly Demo Building A', tenant: 'Tower A Tenant', primaryLocation: 'Level 1', wasteType: 'e-waste', weight: 5, collectDate, externalOnly: true, contaminated: false, wasteOutcome: 'Recycled' },
    { building: 'Nightly Demo Building B', tenant: 'Tower B Tenant', primaryLocation: 'Level 1', wasteType: 'General Waste', weight: 5, collectDate, externalOnly: true, contaminated: false, wasteOutcome: 'Recycled' },
    { building: 'Brand New Unmapped Tower', tenant: 'Mystery Co', primaryLocation: 'Level 9', wasteType: 'General Waste', weight: 8, collectDate, externalOnly: true, contaminated: false, wasteOutcome: 'Recycled' },
    { building: 'Brand New Unmapped Tower', tenant: 'Mystery Co', primaryLocation: 'Level 9', wasteType: 'Not A Real Waste Type', weight: 999, collectDate, externalOnly: true, contaminated: false, wasteOutcome: 'Recycled' }, // unmapped stream - never even reaches the building-matching step
  ];

  const stats = await _processBintrackerRowsAndStore(rawRows, fromDate, toDate);

  check('rowsFetched reflects the full input, rowsSkippedNoStream counts the one unmapped-stream row',
    stats.rowsFetched === 8 && stats.rowsSkippedNoStream === 1, JSON.stringify(stats));
  check('building A (which has no broken tenant match) is counted as touched',
    stats.buildingsTouched >= 1, JSON.stringify(stats));
  check('building B (which has a broken confirmed tenant match) is counted as failed, not silently skipped',
    stats.buildingsFailed === 1, JSON.stringify(stats));
  // rowsWritten is a total ACROSS buildings, not per-building: building A writes all 5 of its own
  // rows, and building B's one row gets written too (the write happens before the aggregate step
  // that then fails for B) - 5 + 1 = 6.
  check('the first-ever run writes every row with nothing yet stored to compare against (A=5 + B=1 = 6)',
    stats.rowsWritten === 6, JSON.stringify(stats));

  // --- Verify what's actually stored, BEFORE the later diff-testing calls below intentionally
  // mutate this same data - checking this at the very end of the test would see whatever the LAST
  // of those calls left behind, not this first run's real result. ---
  const rowsASnap = await db.collection('bintrackerRows').where('buildingId', '==', buildingAId).get();
  check('all 5 of building A\'s rows were stored, including the one matched via a case/whitespace-insensitive building name',
    rowsASnap.size === 5, String(rowsASnap.size));

  const buildingASnap = await db.doc(`buildings/${buildingAId}`).get();
  // gw 10 + mr 20 + pc 15 + og 5 + ew 5 = generated 55; recovered (mr+pc+og) = 40 -> 40/55 = 72.7% -> rounds to 73.
  check('building A\'s recyclingLevelPct was computed from its real rows (5 rows clears the sample-size floor)',
    buildingASnap.data().recyclingLevelPct === 73, JSON.stringify(buildingASnap.data()));
  check('building A got a lastAutoRefreshAt timestamp (successful path)',
    Boolean(buildingASnap.data().lastAutoRefreshAt), JSON.stringify(buildingASnap.data()));

  // --- Building B: error isolation - its own write/aggregate step failed, so it must NOT have a
  // fresh lastAutoRefreshAt, but this must not have stopped building A's own success above. ---
  const buildingBSnap = await db.doc(`buildings/${buildingBId}`).get();
  check('building B has NO lastAutoRefreshAt (its processing genuinely failed, not silently treated as success)',
    !buildingBSnap.data().lastAutoRefreshAt, JSON.stringify(buildingBSnap.data()));

  // --- Discovery: the unmapped building name surfaces correctly, with its own candidate tenant ---
  const discoverySnap = await db.doc('discovery/bintrackerBuildings').get();
  check('the discovery doc exists after a run', discoverySnap.exists, '');
  const discovered = (discoverySnap.data() || {}).discoveredBuildings || [];
  check('the unmapped building name appears in the discovery doc, with its one candidate tenant',
    discovered.length === 1 && discovered[0].name === 'Brand New Unmapped Tower'
      && discovered[0].tenants.length === 1 && discovered[0].tenants[0].bintrackerTenantRaw === 'Mystery Co',
    JSON.stringify(discovered));
  check('the mapped buildings (A and B) do NOT appear in the discovery doc',
    !discovered.some((b) => b.name.toLowerCase().includes('nightly demo building')), JSON.stringify(discovered));

  // --- Cost-conscious re-sync (the user's own explicit concern, 2026-10-07): re-running with the
  // EXACT same input a second time must write NOTHING new - every row is already stored with
  // identical content, so there's nothing to change. This is the common case every single night,
  // and is exactly what makes the nightly job cheap in practice. (From here on, these calls
  // intentionally mutate the stored data - no more "what's stored" assertions after this point.) ---
  const statsUnchanged = await _processBintrackerRowsAndStore(rawRows, fromDate, toDate);
  check('re-running with identical data writes ZERO rows - unchanged data is never rewritten',
    statsUnchanged.rowsWritten === 0, JSON.stringify(statsUnchanged));
  check('...and deletes nothing either (nothing vanished)', statsUnchanged.rowsDeleted === 0, JSON.stringify(statsUnchanged));

  // --- A real correction (same row identity - date/tenant/location/wasteType - different weight)
  // must still be detected and written, proving the diff compares actual content, not just doc id
  // presence (the doc id is derived from date/tenant/location/wasteType only, so a weight
  // correction alone would be invisible to an id-only comparison). ---
  const correctedRows = rawRows.map((r) => (r.wasteType === 'Mixed recycling' ? { ...r, weight: 25 } : r));
  const statsCorrected = await _processBintrackerRowsAndStore(correctedRows, fromDate, toDate);
  check('a real content change (same row identity, different weight) is detected and written as exactly 1 row',
    statsCorrected.rowsWritten === 1 && statsCorrected.rowsDeleted === 0, JSON.stringify(statsCorrected));

  // --- A row that genuinely disappears from the fresh pull (Bintracker removed it) must be
  // deleted, not left behind as stale data. ---
  const rowsWithOneRemoved = correctedRows.filter((r) => r.wasteType !== 'Paper & cardboard');
  const statsRemoved = await _processBintrackerRowsAndStore(rowsWithOneRemoved, fromDate, toDate);
  check('a row no longer present in the fresh pull gets deleted, not left stale', statsRemoved.rowsDeleted === 1, JSON.stringify(statsRemoved));

  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} — ${r.label}${r.ok ? '' : ' ' + r.extra}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error('Test run crashed:', err); process.exit(1); });
