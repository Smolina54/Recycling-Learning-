// Verifies writeRecyclingLevelAggregates - the recyclingLevelPct aggregate write step shared by
// the nightly scheduled sync (runBintrackerUnscopedNightlySync) and the id-gate banner feature.
// (The function this file used to test, refreshBintrackerData, was removed 2026-10-07 - Workstream
// 15 Part 4 moved all Bintracker API calls onto a schedule; admin buttons no longer trigger a live
// call at all, so there's no more onCall surface here to exercise auth/validation against.)
//
// Calls functions/index.js's exported _writeRecyclingLevelAggregates directly against
// bintrackerRows/bintrackerTenantMatches seeded straight into the Firestore emulator via the
// Admin SDK (obtained through the also-exported _getAdminFirestoreForTests() - bypasses rules
// entirely) - no Auth or Functions emulator needed at all, this is a pure Firestore round trip.
//
// Run: npm run test:functions-bintracker
const results = [];
function check(label, cond, extra) { results.push({ label, ok: Boolean(cond), extra: extra || '' }); }

function fmt(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

// --- Recycling-level aggregate (Workstream 7 Point 5 sub-idea, 2026-09-24; formula revised
// 2026-10-05/06 to NABERS' kg-recovered/kg-generated definition, building=external/tenant=internal
// split; window narrowed from 365 to 90 days 2026-10-07) ---
// Exercises _writeRecyclingLevelAggregates directly (exported from functions/index.js purely for
// this test) against bintrackerRows/bintrackerTenantMatches seeded straight into the Firestore
// emulator via the admin SDK — the real refreshBintrackerData handler also calls the real
// Bintracker network (fetchBintrackerCollections) before ever reaching this step, which this
// suite deliberately never does (see the file header) — same "seed the data a real refresh would
// have produced, skip the network" approach as admin-buildings-bintracker.test.js's own review-UI
// coverage. Requires firebase-admin, which only functions/node_modules has installed — got via
// functions/index.js's own `_admin` export rather than requiring firebase-admin directly here.
//
// `wasteOutcome` is stored (matches the real doc shape) but deliberately uncorrelated with the
// expected result — it's no longer read by the formula, only `ourStream` (recovered = mr/pc/og
// weight) and `weight` (generated = ALL streams' weight) matter now, which is why every row below
// uses a DISTINCT, deliberately non-uniform weight — proves the math is really weight-based, not
// accidentally passing because every row happened to weigh the same.
async function testRecyclingLevelAggregation() {
  const { _writeRecyclingLevelAggregates, _getAdminFirestoreForTests } = require('../functions/index.js');
  const db = _getAdminFirestoreForTests();
  const suffix = Date.now() + '-agg';
  const buildingId = 'agg-tower-' + suffix;
  const tenantConfirmedId = 'agg-tenant-confirmed-' + suffix;
  const tenantUnconfirmedId = 'agg-tenant-unconfirmed-' + suffix;
  const tenantGhostId = 'agg-tenant-ghost-' + suffix; // confirmed match, tenant doc never created

  await db.doc(`buildings/${buildingId}`).set({ name: 'Aggregate Tower', bintrackerBuildingName: 'Agg Demo Building' });
  await db.doc(`buildings/${buildingId}/tenants/${tenantConfirmedId}`).set({ name: 'Confirmed Co', levels: ['L1'] });
  await db.doc(`buildings/${buildingId}/tenants/${tenantUnconfirmedId}`).set({ name: 'Unconfirmed Co', levels: ['L1'] });

  // Building-level population = EXTERNAL (externalOnly:true) rows only, regardless of tenant.
  // mr 40 + pc 30 + og 20 + gw 5 + ew 5 = generated 100; recovered (mr+pc+og) = 90 -> 90%.
  // gw/ew legitimately count toward "generated" now (real NABERS denominator = ALL waste), but
  // never toward "recovered" — this is the actual behavior change from the pre-2026-10-05 formula.
  const buildingExternalRows = [
    { ourStream: 'mr', weight: 40, bintrackerTenantRaw: 'Confirmed Raw Co' },
    { ourStream: 'pc', weight: 30, bintrackerTenantRaw: 'Confirmed Raw Co' },
    { ourStream: 'og', weight: 20, bintrackerTenantRaw: 'Other Co' },
    { ourStream: 'gw', weight: 5, bintrackerTenantRaw: 'Confirmed Raw Co' },
    { ourStream: 'ew', weight: 5, bintrackerTenantRaw: 'Other Co' },
  ];
  // An INTERNAL row, huge distinctive weight (999) — must NEVER count toward the building total
  // (building reads external rows only); if wrongly included, generated would balloon to 1099 and
  // the building percentage below would be very different, making this a real discriminating check.
  // Tagged with a raw string that has NO confirmed match doc at all, so it also can't accidentally
  // feed any tenant-level number either — isolates this to testing the building-level exclusion only.
  const buildingExcludedInternalRow = { ourStream: 'mr', weight: 999, externalOnly: false, bintrackerTenantRaw: 'Unrelated Internal Co' };

  // Confirmed Co's own tenant-level population = INTERNAL rows for 'Confirmed Raw Co' exactly.
  // mr 40 + pc 20 + og 10 + gw 20 + ew 10 = generated 100; recovered = 70 -> 70%.
  const confirmedTenantInternalRows = [
    { ourStream: 'mr', weight: 40, externalOnly: false, bintrackerTenantRaw: 'Confirmed Raw Co' },
    { ourStream: 'pc', weight: 20, externalOnly: false, bintrackerTenantRaw: 'Confirmed Raw Co' },
    { ourStream: 'og', weight: 10, externalOnly: false, bintrackerTenantRaw: 'Confirmed Raw Co' },
    { ourStream: 'gw', weight: 20, externalOnly: false, bintrackerTenantRaw: 'Confirmed Raw Co' },
    { ourStream: 'ew', weight: 10, externalOnly: false, bintrackerTenantRaw: 'Confirmed Raw Co' },
  ];
  // A different-case variant of the confirmed raw string, INTERNAL, huge distinctive weight (500) —
  // bintrackerTenantRaw matching is documented as case-sensitive exact match; this row must NOT
  // count toward Confirmed Co's own tenant-level number (would balloon generated to 600 if wrongly
  // included, a real discriminating check, not just "happens to still pass").
  const caseVariantInternalRow = { ourStream: 'mr', weight: 500, externalOnly: false, bintrackerTenantRaw: 'confirmed raw co' };

  // "Other Co" — 5 internal rows, would be 30/50=60% IF its match were confirmed; its match doc
  // below is deliberately left as status:'pending' to prove an unconfirmed match never feeds the
  // tenant-level field, same "admin reviews, never fully automatic" principle established for the
  // rest of this workstream.
  const otherTenantInternalRows = [
    { ourStream: 'mr', weight: 10, externalOnly: false, bintrackerTenantRaw: 'Other Co' },
    { ourStream: 'pc', weight: 10, externalOnly: false, bintrackerTenantRaw: 'Other Co' },
    { ourStream: 'og', weight: 10, externalOnly: false, bintrackerTenantRaw: 'Other Co' },
    { ourStream: 'gw', weight: 10, externalOnly: false, bintrackerTenantRaw: 'Other Co' },
    { ourStream: 'ew', weight: 10, externalOnly: false, bintrackerTenantRaw: 'Other Co' },
  ];

  const allRows = [
    ...buildingExternalRows.map((r) => ({ externalOnly: true, ...r })),
    buildingExcludedInternalRow,
    ...confirmedTenantInternalRows,
    caseVariantInternalRow,
    ...otherTenantInternalRows,
  ];
  for (const r of allRows) {
    await db.collection('bintrackerRows').add({
      buildingId, bintrackerLocationRaw: 'Level 1', wasteTypeRaw: 'x', contaminated: false,
      wasteOutcome: 'Recycled', collectDate: fmt(2), fetchedAt: new Date(), ...r,
    });
  }

  await db.doc('bintrackerTenantMatches/' + `${buildingId}__${tenantConfirmedId}`).set({
    buildingId, tenantId: tenantConfirmedId, tenantName: 'Confirmed Co',
    bintrackerTenantRaw: 'Confirmed Raw Co', bintrackerLocationRaw: 'Level 1',
    confirmedBy: 'admin@example.com', status: 'confirmed',
  });
  await db.doc('bintrackerTenantMatches/' + `${buildingId}__${tenantUnconfirmedId}`).set({
    buildingId, tenantId: tenantUnconfirmedId, tenantName: 'Unconfirmed Co',
    bintrackerTenantRaw: 'Other Co', bintrackerLocationRaw: 'Level 1',
    confirmedBy: '', status: 'pending',
  });
  await db.doc('bintrackerTenantMatches/' + `${buildingId}__${tenantGhostId}`).set({
    buildingId, tenantId: tenantGhostId, tenantName: 'Ghost Co',
    bintrackerTenantRaw: 'Ghost Raw Co', bintrackerLocationRaw: 'Level 1',
    confirmedBy: 'admin@example.com', status: 'confirmed',
  });

  await _writeRecyclingLevelAggregates(db, buildingId);

  const buildingSnap = await db.doc(`buildings/${buildingId}`).get();
  check('building-wide recyclingLevelPct computed from EXTERNAL rows only, kg recovered/generated (90/100 -> 90%)',
    buildingSnap.data().recyclingLevelPct === 90, JSON.stringify(buildingSnap.data()));

  const confirmedTenantSnap = await db.doc(`buildings/${buildingId}/tenants/${tenantConfirmedId}`).get();
  check('confirmed tenant recyclingLevelPct computed from only its own exact-case INTERNAL rows (70/100 -> 70%)',
    confirmedTenantSnap.data().recyclingLevelPct === 70, JSON.stringify(confirmedTenantSnap.data()));

  const unconfirmedTenantSnap = await db.doc(`buildings/${buildingId}/tenants/${tenantUnconfirmedId}`).get();
  check('a tenant whose match is only "pending" (not confirmed) gets no recyclingLevelPct field at all',
    unconfirmedTenantSnap.data().recyclingLevelPct === undefined, JSON.stringify(unconfirmedTenantSnap.data()));

  const ghostTenantSnap = await db.doc(`buildings/${buildingId}/tenants/${tenantGhostId}`).get();
  check('a confirmed match pointing at a tenant doc that was never created is skipped gracefully, not crashing and not creating a phantom doc',
    !ghostTenantSnap.exists, JSON.stringify(ghostTenantSnap.data()));

  // --- Below-the-floor + stale-field deletion: delete every bintrackerRows doc for this building
  // (simulating a re-refresh over a narrower/emptier range) and re-run the aggregate — both the
  // building's and the tenant's previously-written numbers must be REMOVED (FieldValue.delete()),
  // not left stale and not zeroed out. ---
  const rowsSnap = await db.collection('bintrackerRows').where('buildingId', '==', buildingId).get();
  const batch = db.batch();
  rowsSnap.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();

  await _writeRecyclingLevelAggregates(db, buildingId);

  const buildingSnapAfter = await db.doc(`buildings/${buildingId}`).get();
  check('after the qualifying rows disappear, the building doc\'s stale recyclingLevelPct is removed entirely (not left, not zeroed)',
    buildingSnapAfter.exists && !('recyclingLevelPct' in buildingSnapAfter.data()), JSON.stringify(buildingSnapAfter.data()));

  const confirmedTenantSnapAfter = await db.doc(`buildings/${buildingId}/tenants/${tenantConfirmedId}`).get();
  check('...and the confirmed tenant\'s stale recyclingLevelPct is removed the same way',
    confirmedTenantSnapAfter.exists && !('recyclingLevelPct' in confirmedTenantSnapAfter.data()), JSON.stringify(confirmedTenantSnapAfter.data()));
}

// --- 90-day cutoff (narrowed from 365 to 90 on 2026-10-07 - see writeRecyclingLevelAggregates'
// own comment for the full reasoning: a deliberate, temporary interim measure pending the planned
// Bintracker Data Hub project, not a new permanent definition). Two cases: rows from 400 days ago
// stay excluded either way (doesn't discriminate between a 90-day and a 365-day cutoff on its
// own); rows from 150 days ago are the real, newly-added discriminating case - they WOULD have
// qualified under the old 365-day window but must NOT under the new 90-day one, which is the one
// genuinely new behavior this change introduces. Both computed relative to the real clock, not
// hardcoded, so this test never goes stale.
async function testNinetyDayCutoff() {
  const { _writeRecyclingLevelAggregates, _getAdminFirestoreForTests } = require('../functions/index.js');
  const db = _getAdminFirestoreForTests();

  async function seedFiveRows(buildingId, dateStr, tenantRaw) {
    const oldRows = [
      ['mr', 'Recycled'], ['mr', 'Recycled'], ['pc', 'Recycled'], ['og', 'Recycled'], ['og', 'Non-Recycled'],
    ];
    for (const [ourStream, wasteOutcome] of oldRows) {
      await db.collection('bintrackerRows').add({
        buildingId, bintrackerTenantRaw: tenantRaw, bintrackerLocationRaw: 'Level 1', wasteTypeRaw: 'x',
        ourStream, externalOnly: true, contaminated: wasteOutcome !== 'Recycled', wasteOutcome,
        collectDate: dateStr, weight: 10, fetchedAt: new Date(),
      });
    }
  }

  const suffix400 = Date.now() + '-cutoff400';
  const buildingId400 = 'cutoff-tower-' + suffix400;
  await db.doc(`buildings/${buildingId400}`).set({ name: 'Cutoff Tower 400', bintrackerBuildingName: 'Cutoff Demo Building 400' });
  await seedFiveRows(buildingId400, fmt(400), 'Old Data Co');
  await _writeRecyclingLevelAggregates(db, buildingId400);
  const buildingSnap400 = await db.doc(`buildings/${buildingId400}`).get();
  check('rows from 400 days ago are excluded by the 90-day cutoff - recyclingLevelPct stays unset even though 5 rows exist (would otherwise sit exactly at the floor)',
    buildingSnap400.exists && !('recyclingLevelPct' in buildingSnap400.data()), JSON.stringify(buildingSnap400.data()));

  const suffix150 = Date.now() + '-cutoff150';
  const buildingId150 = 'cutoff-tower-' + suffix150;
  await db.doc(`buildings/${buildingId150}`).set({ name: 'Cutoff Tower 150', bintrackerBuildingName: 'Cutoff Demo Building 150' });
  await seedFiveRows(buildingId150, fmt(150), '150-Day Co');
  await _writeRecyclingLevelAggregates(db, buildingId150);
  const buildingSnap150 = await db.doc(`buildings/${buildingId150}`).get();
  check('rows from 150 days ago are ALSO excluded under the new 90-day cutoff - would have qualified under the old 365-day window, proving the narrower window actually took effect',
    buildingSnap150.exists && !('recyclingLevelPct' in buildingSnap150.data()), JSON.stringify(buildingSnap150.data()));
}

async function main() {
  await testRecyclingLevelAggregation();
  await testNinetyDayCutoff();

  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} — ${r.label}${r.ok ? '' : ' ' + r.extra}`);
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(err => { console.error('Test run crashed:', err); process.exit(1); });
