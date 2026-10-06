// One-off local diagnostic (never run in production, never committed with real values filled in)
// to measure how long a real, full-year Bintracker pull actually takes for one real building -
// reuses this repo's own already-verified fetchBintrackerCollections() (functions/bintracker.js),
// the exact same pagination/signing/time-budget logic the real scheduled refresh would use, so the
// timing reflects reality (including its built-in MAX_PAGES/LOOP_TIME_BUDGET_MS safety caps), not
// a hand-rolled approximation.
//
// Usage: node tools/time-bintracker-year-pull.js <APP_ID> <APP_KEY>
// Credentials are read from argv only (never hardcoded, never logged) - run this with the real
// production Bintracker credentials as local arguments, same handling as
// tools/generate-bintracker-auth-header.js.
const { fetchBintrackerCollections } = require('../functions/bintracker');

const [appId, appKey] = process.argv.slice(2);
if (!appId || !appKey) {
  console.error('Usage: node tools/time-bintracker-year-pull.js <APP_ID> <APP_KEY>');
  process.exit(1);
}

const BUILDING_NAME = 'Tower 2 - Collins Square, Docklands'; // exact Bintracker name, confirmed via bintrackerBuildingName
const today = new Date();
const oneYearAgo = new Date(today.getTime() - 365 * 24 * 60 * 60 * 1000);
const fmt = (d) => d.toISOString().slice(0, 10);

function fmtDuration(ms) {
  const totalSeconds = ms / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds % 60).toFixed(1);
  return minutes > 0 ? `${minutes}m ${seconds}s (${ms}ms total)` : `${seconds}s (${ms}ms total)`;
}

(async () => {
  console.log(`Pulling Bintracker Collections for "${BUILDING_NAME}"`);
  console.log(`Date range: ${fmt(oneYearAgo)} to ${fmt(today)} (365 days)`);
  console.log('---');

  const overallStart = Date.now();
  let pageCount = 0;
  let lastPageLoggedAt = overallStart;

  const rows = await fetchBintrackerCollections({
    building: BUILDING_NAME,
    collectDateFrom: fmt(oneYearAgo),
    collectDateTo: fmt(today),
    appId,
    appKey,
    onPage: (rowsSoFar) => {
      pageCount++;
      const now = Date.now();
      const sinceStart = now - overallStart;
      const sinceLastPage = now - lastPageLoggedAt;
      lastPageLoggedAt = now;
      console.log(`[page ${pageCount}] +rows so far: ${rowsSoFar.length} | elapsed: ${fmtDuration(sinceStart)} | this page took: ${sinceLastPage}ms`);
      return false; // never stop early - we want the real, full pull for this measurement
    },
  });

  const overallEnd = Date.now();
  const totalMs = overallEnd - overallStart;

  console.log('\n=== RESULTS ===');
  console.log(`Total rows fetched: ${rows.length}`);
  console.log(`Total pages: ${pageCount}`);
  console.log(`Total time: ${fmtDuration(totalMs)}`);
  if (rows.length > 0) {
    console.log(`Average: ${(totalMs / rows.length).toFixed(2)}ms per row, ${(rows.length / (totalMs / 1000)).toFixed(1)} rows/sec`);
  }
  console.log(`Average time per page: ${(totalMs / Math.max(pageCount, 1)).toFixed(0)}ms`);

  console.log('\n=== SAMPLE DATA (first 5 rows) ===');
  console.log(JSON.stringify(rows.slice(0, 5), null, 2));

  console.log('\n=== SAMPLE DATA (last 5 rows) ===');
  console.log(JSON.stringify(rows.slice(-5), null, 2));

  // Quick breakdown, useful context alongside the timing - mirrors the kind of analysis already
  // done earlier this session on stored (already-fetched) data, but this is a LIVE pull.
  const byWasteType = {};
  const byExternalOnly = { true: 0, false: 0 };
  rows.forEach((r) => {
    byWasteType[r.wasteType] = (byWasteType[r.wasteType] || 0) + 1;
    byExternalOnly[String(Boolean(r.externalOnly))]++;
  });
  console.log('\n=== BREAKDOWN ===');
  console.log('By externalOnly:', byExternalOnly);
  console.log('By wasteType:', byWasteType);
})().catch((err) => {
  console.error('Fetch failed:', err && err.message);
  process.exit(1);
});
