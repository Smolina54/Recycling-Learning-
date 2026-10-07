// One-off local diagnostic (never run in production, never committed with real values filled in)
// to verify the hybrid nightly sync's NEW discovery-pass query shape actually works against the
// real Bintracker API before trusting it inside the scheduled Cloud Function: unscoped (no
// `building` filter) + a single wasteType filter + a short 10-day window + the onPage early-stop
// callback - the one combination of parameters that has never been exercised against the real API
// in this project (every other call shape - scoped-by-name, or unscoped-with-no-filter - has
// already been proven working live). Reuses this repo's own already-verified
// fetchBintrackerCollections() (functions/bintracker.js), same signing/pagination/time-budget
// logic the real scheduled function uses.
//
// Usage: node tools/test-discovery-pass-query.js <APP_ID> <APP_KEY>
// Credentials are read from argv only (never hardcoded, never logged) - run this with the real
// production Bintracker credentials as local arguments, same handling as
// tools/time-bintracker-year-pull.js.
const { fetchBintrackerCollections, normalizeForMatching } = require('../functions/bintracker');

const [appId, appKey] = process.argv.slice(2);
if (!appId || !appKey) {
  console.error('Usage: node tools/test-discovery-pass-query.js <APP_ID> <APP_KEY>');
  process.exit(1);
}

// Exact same constants as functions/index.js's runDiscoveryPass - keep these two files in sync if
// either changes.
const DISCOVERY_WINDOW_DAYS = 10;
const DISCOVERY_WASTE_TYPE_FILTER = 'General Waste';
const DISCOVERY_MAX_PAGES = 40;
const DISCOVERY_TIME_BUDGET_MS = 120000;

const today = new Date();
const tenDaysAgo = new Date(today.getTime() - DISCOVERY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
const fmt = (d) => d.toISOString().slice(0, 10);

(async () => {
  console.log(`Discovery-pass query test: unscoped, wasteType="${DISCOVERY_WASTE_TYPE_FILTER}", ${fmt(tenDaysAgo)} to ${fmt(today)}`);
  console.log('---');

  const overallStart = Date.now();
  const seenNormNames = new Set();
  let pageCount = 0;

  let rows;
  try {
    rows = await fetchBintrackerCollections({
      collectDateFrom: fmt(tenDaysAgo),
      collectDateTo: fmt(today),
      wasteType: DISCOVERY_WASTE_TYPE_FILTER,
      appId,
      appKey,
      maxPages: DISCOVERY_MAX_PAGES,
      timeBudgetMs: DISCOVERY_TIME_BUDGET_MS,
      onPage: (pageRows) => {
        pageCount++;
        let foundNew = false;
        for (const row of pageRows) {
          const norm = row && row.building && normalizeForMatching(row.building);
          if (norm && !seenNormNames.has(norm)) { seenNormNames.add(norm); foundNew = true; }
        }
        console.log(`[page ${pageCount}] ${pageRows.length} rows, distinct building names so far: ${seenNormNames.size}${foundNew ? '' : ' (no new names this page - would stop here)'}`);
        return !foundNew;
      },
    });
  } catch (err) {
    console.error('\n=== QUERY FAILED ===');
    console.error(err && err.message);
    process.exit(1);
  }

  const totalMs = Date.now() - overallStart;
  console.log('\n=== RESULTS ===');
  console.log(`Query succeeded with no error.`);
  console.log(`Total rows fetched: ${rows.length}`);
  console.log(`Total pages: ${pageCount}`);
  console.log(`Total time: ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`Distinct building names seen: ${seenNormNames.size}`);
  const distinctRawNames = [...new Set(rows.map((r) => r.building).filter(Boolean))];
  console.log('\nReal building names returned by this query:');
  distinctRawNames.sort().forEach((n) => console.log('  - ' + n));

  console.log('\n=== SAMPLE ROW (first) ===');
  console.log(JSON.stringify(rows[0], null, 2));
})();
