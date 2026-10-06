// Bintracker Data Sharing API client + shared matching logic, used by BOTH the induction-vs-
// real-data comparison feature (Point 1) and the building/tenant catalog sync feature
// (Workstream 12) — genuinely shared code between two otherwise-separate features, not a
// coupling of the features themselves.
//
// Auth is OAuth 1.0 / HMAC-SHA256, ported from bin-tally-app/bintracker_client.py (a sister
// project's already-verified connector against Bintracker's real dev environment) and confirmed
// working again directly against the real API on 2026-09-24. One real quirk their server
// requires, not the OAuth1 norm: the Authorization header's comma-separated parameters must have
// NO space after the comma, or the server rejects the request — hand-rolled here rather than via
// an off-the-shelf OAuth1 library, none of which allow suppressing that separator.
const crypto = require('crypto');
const https = require('https');

const BASE_URL = 'https://ds.bintracker.com.au'; // production environment - cut over 2026-10-01,
// once the user received real production credentials (was https://dsdev.bintracker.com.au, the
// dev/test sandbox used throughout 2026-09-17 to 2026-09-30).
const COLLECTIONS_PATH = '/api/Collections/GetAsync';
const PAGE_SIZE = 500;
const MAX_PAGES = 50; // safety cap against the Cloud Function's own timeout - the real test pull
// was 9,505 rows in one call; this caps at 25,000 rows, generous but not unbounded.

function percentEncode(str) {
  return encodeURIComponent(str).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function oauth1Header(method, baseUrl, queryParams, appId, appKey) {
  const oauthParams = {
    oauth_consumer_key: appId,
    oauth_nonce: crypto.randomUUID().replace(/-/g, ''),
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
  };
  const allParams = { ...queryParams, ...oauthParams };
  const encodedPairs = Object.keys(allParams)
    .map((k) => [percentEncode(k), percentEncode(String(allParams[k]))])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const paramString = encodedPairs.map(([k, v]) => `${k}=${v}`).join('&');
  const baseString = [method.toUpperCase(), percentEncode(baseUrl), percentEncode(paramString)].join('&');
  const signingKey = `${percentEncode(appKey)}&`; // no token secret
  const signature = crypto.createHmac('sha256', signingKey).update(baseString).digest('base64');
  oauthParams.oauth_signature = signature;
  return 'OAuth ' + Object.keys(oauthParams).map((k) => `${k}="${percentEncode(oauthParams[k])}"`).join(',');
}

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Bintracker API returned ${res.statusCode}: ${data.slice(0, 500)}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error('Bintracker API returned non-JSON response: ' + data.slice(0, 200)));
        }
      });
    }).on('error', reject);
  });
}

// Found against real production data (2026-10-01): Bintracker's prod environment does not
// reliably honor request.page/request.pageSize the way the dev sandbox did - a single page came
// back with 4,123 rows instead of the requested 500, each page taking ~10s. Without a guard, the
// old "keep going while rows.length >= PAGE_SIZE" loop would re-request up to MAX_PAGES (50) times,
// blowing well past this function's own 300s timeout (confirmed: that's exactly what happened).
// Two independent, defensive stops, neither depending on knowing which failure mode is real:
// (1) if a page's content is identical to the previous page's, the API isn't actually advancing -
//     stop immediately instead of re-fetching the same (possibly huge) blob up to 50 times.
// (2) a wall-clock time budget, well under the function's own timeout - if genuinely distinct,
//     large data keeps coming back, stop and return what's been gathered so far rather than being
//     hard-killed with nothing to show for it.
const LOOP_TIME_BUDGET_MS = 200000; // leaves headroom under every caller's 300s function timeout

function pageSignature(rows) {
  if (!rows.length) return 'empty';
  const first = JSON.stringify(rows[0]);
  const last = JSON.stringify(rows[rows.length - 1]);
  return rows.length + '|' + first + '|' + last;
}

// Fetches every page of Collections for a date range, optionally scoped to one building name.
// Omitting `building` (undefined/null) queries across every building the credentials can see -
// used by discoverBintrackerBuildings; a real building name scopes to just that one, used by
// both refreshBintrackerData and syncBintrackerTenants.
// `onPage(rows, allRowsSoFar)` is an optional callback invoked after each page is fetched and
// added to the running total - return true to stop fetching further pages early. Used by
// discoverBintrackerBuildings (see its own comment) to stop once distinct building names have
// stopped appearing, instead of blindly fetching every row Bintracker has for the window.
async function fetchBintrackerCollections({ building, wasteType, collectDateFrom, collectDateTo, appId, appKey, onPage }) {
  const allRows = [];
  const startedAt = Date.now();
  let prevSignature = null;
  let page = 1;
  for (; page <= MAX_PAGES; page++) {
    if (Date.now() - startedAt > LOOP_TIME_BUDGET_MS) {
      console.log(`[bintracker] stopped: time budget exceeded after page ${page - 1}, ${allRows.length} rows so far`);
      break;
    }
    const queryParams = {
      'request.collectDateFrom': collectDateFrom,
      'request.collectDateTo': collectDateTo,
      'request.page': String(page),
      'request.pageSize': String(PAGE_SIZE),
    };
    if (building) queryParams['request.building'] = building;
    if (wasteType) queryParams['request.wasteType'] = wasteType;
    const baseUrl = BASE_URL + COLLECTIONS_PATH;
    const header = oauth1Header('GET', baseUrl, queryParams, appId, appKey);
    const qs = Object.keys(queryParams).map((k) => `${k}=${encodeURIComponent(queryParams[k])}`).join('&');
    const pageStartedAt = Date.now();
    const json = await httpGet(`${baseUrl}?${qs}`, { Authorization: header, Accept: 'application/json' });
    const rows = json.data || [];
    console.log(`[bintracker] page ${page}: ${rows.length} rows in ${Date.now() - pageStartedAt}ms (total so far: ${allRows.length + rows.length})`);
    const signature = pageSignature(rows);
    if (signature === prevSignature) {
      console.log(`[bintracker] stopped: page ${page} identical to page ${page - 1}, pagination isn't advancing`);
      break;
    }
    prevSignature = signature;
    allRows.push(...rows);
    if (onPage && onPage(rows, allRows)) {
      console.log(`[bintracker] stopped: onPage callback signaled no more pages needed after page ${page}`);
      break;
    }
    if (rows.length < PAGE_SIZE) {
      console.log(`[bintracker] stopped: page ${page} returned fewer than ${PAGE_SIZE} rows (real last page)`);
      break;
    }
  }
  if (page > MAX_PAGES) console.log(`[bintracker] stopped: reached MAX_PAGES (${MAX_PAGES}), ${allRows.length} rows total`);
  return allRows;
}

// Fixed wasteType -> our-stream lookup, finalized with the user 2026-09-24 (Workstream 7, Point 1
// in the plan) - only the 5 core streams this induction evaluates matter; anything not listed
// here is silently excluded from any comparison, never forced into an "other" bucket.
const WASTE_TYPE_TO_STREAM = {
  'General Waste': 'gw', 'Dry Waste (Demo)': 'gw', 'Dry waste': 'gw', 'Non-recycled': 'gw',
  'Mixed recycling': 'mr', 'CDS mixed recycling': 'mr', 'Aluminium': 'mr', 'HDPE': 'mr',
  'Soft plastic': 'mr', 'CDS plastic containers': 'mr', 'Glass': 'mr', 'Polystyrene': 'mr',
  'Paper & cardboard': 'pc', 'Cardboard': 'pc', 'Secure paper': 'pc', 'Paper towel': 'pc', 'CDS Cartons': 'pc',
  'Organics': 'og', 'Green/garden waste': 'og', 'Coffee Grounds': 'og', 'Coffee pods': 'og',
  'Fish and Meat': 'og', 'Cooking oil': 'og',
  'e-waste': 'ew', 'Batteries': 'ew', 'Mobile phones': 'ew', 'Fluorescent tubes': 'ew',
};

function mapWasteTypeToStream(wasteType) {
  return WASTE_TYPE_TO_STREAM[wasteType] || null;
}

// ---- Recycling-level aggregate (Workstream 7 Point 5 sub-idea, 2026-09-24; formula revised
// 2026-10-05 after a real production bug report) ----
// The single combined "real recycling level" percentage shown on the id-gate (Point 5), matching
// NABERS' own definition (Recycling rate % = Total materials recovered (kg) / Total materials
// generated (kg)): recovered = weight that landed in one of the 3 recyclable streams, generated =
// weight across EVERY stream (General Waste/E-Waste included) - so a building with real landfill
// volume alongside its recycling correctly shows less than 100%. The CALLER decides which
// population of rows to pass in: building-level uses externalOnly:true rows (the official,
// contractor-weighed export); tenant-level uses externalOnly:false rows for that tenant (internal/
// per-floor weighing) - confirmed directly with the user 2026-10-05 that no per-tenant EXTERNAL
// weighing exists in Bintracker's data, so a tenant-level figure can only ever come from internal
// rows. This function itself just does the recovered/generated math on whatever's handed to it.
//
// Originally (2026-09-24) this filtered to externalOnly:true rows only and used
// wasteOutcome==='Recycled' as the "good" signal. Replaced after real production data (Tower 2 -
// Collins Square, Docklands, 15,612 real rows, checked 2026-10-05) showed `wasteOutcome` is a
// HARDCODED CONSTANT - literally "Recycled" on every single row for this Bintracker account -
// carrying zero real signal, which made the old formula always return 100% no matter how the
// building actually performs. The stream classification itself (which bin something ended up in)
// already encodes what counts as "recovered" for this aggregate figure - no extra per-row quality
// field is needed here (contrast with Point 1's own per-stream comparison, which DOES still need a
// quality signal within one already-identified stream, and uses `contaminated` for that instead).
const RECYCLABLE_STREAMS = new Set(['mr', 'pc', 'og']);
const MIN_ROWS_FOR_RECYCLING_LEVEL = 5; // same floor as Point 1's own comparison guard

// Returns a rounded 0-100 percentage, or null if there aren't at least MIN_ROWS_FOR_RECYCLING_LEVEL
// rows, or the rows carry no usable weight at all - never a 0% or otherwise misleading number from
// too thin a sample ("graceful absence", the same principle used everywhere else in this
// workstream). `rows` must already be scoped to the right population (one building + externalOnly,
// or one building + tenant + internal-only) by the caller.
function computeRecyclingLevelPct(rows) {
  const scoped = rows || [];
  if (scoped.length < MIN_ROWS_FOR_RECYCLING_LEVEL) return null;
  const weightOf = (r) => (typeof r.weight === 'number' ? r.weight : 0);
  const generatedKg = scoped.reduce((sum, r) => sum + weightOf(r), 0);
  if (generatedKg <= 0) return null;
  const recoveredKg = scoped.filter((r) => RECYCLABLE_STREAMS.has(r.ourStream)).reduce((sum, r) => sum + weightOf(r), 0);
  return Math.round((recoveredKg / generatedKg) * 100);
}

// ---- Shared fuzzy matching (Point 1's Phase B + Workstream 12's tenant sync both use this) ----
// Deliberately simple - no fuzzy-string-distance library (none exists in this codebase today):
// normalize, then try exact match, then substring-contains either direction, then a trivial
// word-overlap ratio as a lower-confidence fallback. Every candidate is reviewed/confirmed by an
// admin before being trusted anywhere - this never silently drives a comparison or a delete.
function normalizeForMatching(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function wordOverlapRatio(a, b) {
  const wordsA = new Set(a.split(' ').filter(Boolean));
  const wordsB = new Set(b.split(' ').filter(Boolean));
  if (!wordsA.size || !wordsB.size) return 0;
  let shared = 0;
  wordsA.forEach((w) => { if (wordsB.has(w)) shared++; });
  const unionSize = new Set([...wordsA, ...wordsB]).size;
  return shared / unionSize;
}

// Returns the best candidate match (or null) for `ourName` among `candidateNames` (an array of
// raw, un-normalized strings) - { candidate, confidence: 'exact'|'contains'|'partial' }.
function findBestMatch(ourName, candidateNames) {
  const ours = normalizeForMatching(ourName);
  if (!ours) return null;
  let best = null;
  for (const raw of candidateNames) {
    const theirs = normalizeForMatching(raw);
    if (!theirs) continue;
    if (theirs === ours) return { candidate: raw, confidence: 'exact' };
    if (!best && (theirs.includes(ours) || ours.includes(theirs))) {
      best = { candidate: raw, confidence: 'contains' };
    }
  }
  if (best) return best;
  const PARTIAL_FLOOR = 0.5;
  let bestRatio = 0;
  let bestRaw = null;
  for (const raw of candidateNames) {
    const ratio = wordOverlapRatio(ours, normalizeForMatching(raw));
    if (ratio > bestRatio) { bestRatio = ratio; bestRaw = raw; }
  }
  if (bestRaw && bestRatio >= PARTIAL_FLOOR) return { candidate: bestRaw, confidence: 'partial' };
  return null;
}

// ---- Workstream 12: building/tenant catalog sync — pure diff helpers ----
// Both functions below take ALREADY-FETCHED raw Bintracker rows (never touch the network
// themselves) and diff them against already-loaded Firestore data the caller supplies - same
// "separate the fetch from the diff" split as computeRecyclingLevelPct above, done specifically
// so tests/functions-bintrackersync.test.js can exercise the actual diff logic with realistic
// seeded row shapes, with no real Bintracker network call and no Functions/Firestore emulator
// needed for these two functions in isolation.

// discoverBintrackerBuildings: distinct `building` values from a building-unscoped Collections
// pull, minus any Bintracker building name already mapped to one of the app's own buildings.
// Compares via normalizeForMatching (not raw ===) so a saved mapping that differs only in
// whitespace/case/punctuation from the live API value still counts as "already mapped" - the
// mapping is meant to be an exact name per admin-buildings.html's own instructions, but the two
// could easily drift after being typed by hand in two different places over time.
function diffDiscoveredBuildingNames(rawRows, existingBintrackerBuildingNames) {
  const existingNormalized = new Set(
    (existingBintrackerBuildingNames || []).map(normalizeForMatching).filter(Boolean)
  );
  const seen = new Map(); // normalized name -> first-seen raw name
  for (const row of rawRows || []) {
    const raw = row && row.building;
    if (!raw) continue;
    const norm = normalizeForMatching(raw);
    if (!norm || existingNormalized.has(norm) || seen.has(norm)) continue;
    seen.set(norm, raw);
  }
  return [...seen.values()];
}

// syncBintrackerTenants: diffs distinct (tenant, primaryLocation) pairs seen in a building's last-
// 30-days Collections rows against that building's REAL, already-active tenants subcollection.
// `existingTenants` must already be filtered to active-only (mirrors admin-buildings.html's own
// `.filter(t => t.data().active !== false)` for the same reason - an archived tenant is meant to
// stay hidden, not resurface here as "missing" or a level-mismatch candidate).
// Matching direction mirrors admin-buildings.html's existing Phase B review UI exactly:
// findBestMatch(tenant.name, distinctRawRoles) - the app's own tenant name is `ourName`, the raw
// Bintracker strings are the candidates - so this reuses the identical confidence/floor behavior
// admins already see and trust from that screen, not a mirror-image of it.
function diffBintrackerTenants(rawRows, existingTenants) {
  const pairsByNormRaw = new Map(); // normalized raw tenant -> { raw, locations: Set<string> }
  for (const row of rawRows || []) {
    const tenantRaw = row && row.tenant;
    if (!tenantRaw) continue;
    const norm = normalizeForMatching(tenantRaw);
    if (!norm) continue;
    if (!pairsByNormRaw.has(norm)) pairsByNormRaw.set(norm, { raw: tenantRaw, locations: new Set() });
    const loc = row.primaryLocation;
    if (loc) pairsByNormRaw.get(norm).locations.add(loc);
  }
  const distinctRawTenantNames = [...pairsByNormRaw.values()].map((v) => v.raw);

  // Each raw Bintracker tenant name may be claimed by at most one existing tenant. The original
  // version ran findBestMatch(tenant.name, distinctRawTenantNames) independently per tenant with
  // no exclusion of names already claimed by an earlier tenant in the loop — two real tenants
  // with similar names (e.g. "Acme Legal" and "Acme Legal Services") could both "contains"-match
  // the same raw string, corrupting one tenant's level-mismatch comparison with the other's real
  // location data and potentially hiding a genuinely new tenant behind a wrongly-claimed match
  // (found in a pre-production audit). Fixed with a two-pass greedy claim: every tenant with an
  // EXACT match claims it first (exact matches are unambiguous, so claim order among them doesn't
  // matter), then every remaining tenant matches against whatever raw names are still unclaimed.
  // Not a full optimal bipartite match — just enough to guarantee no raw name is ever double-
  // claimed, which is what the audit actually flagged.
  const availableRawNames = new Set(distinctRawTenantNames);
  const matches = new Map(); // tenant.id -> { candidate, confidence }

  for (const tenant of existingTenants || []) {
    const ours = normalizeForMatching(tenant.name);
    if (!ours) continue;
    for (const raw of availableRawNames) {
      if (normalizeForMatching(raw) === ours) {
        matches.set(tenant.id, { candidate: raw, confidence: 'exact' });
        availableRawNames.delete(raw);
        break;
      }
    }
  }
  for (const tenant of existingTenants || []) {
    if (matches.has(tenant.id) || !availableRawNames.size) continue;
    const match = findBestMatch(tenant.name, [...availableRawNames]);
    if (match) {
      matches.set(tenant.id, match);
      availableRawNames.delete(match.candidate);
    }
  }

  const missingTenants = [];
  const levelMismatches = [];
  for (const tenant of existingTenants || []) {
    const match = matches.get(tenant.id);
    if (!match) {
      missingTenants.push({ tenantId: tenant.id, tenantName: tenant.name, levels: tenant.levels || [] });
      continue;
    }
    const matchedNorm = normalizeForMatching(match.candidate);
    const seenLocations = [...pairsByNormRaw.get(matchedNorm).locations];
    const tenantLevels = new Set(tenant.levels || []);
    const newLevels = seenLocations.filter((loc) => !tenantLevels.has(loc));
    if (newLevels.length) {
      levelMismatches.push({
        tenantId: tenant.id,
        tenantName: tenant.name,
        currentLevels: tenant.levels || [],
        bintrackerTenantRaw: match.candidate,
        confidence: match.confidence,
        newLevels,
      });
    }
  }

  const newTenants = [];
  for (const [, { raw, locations }] of pairsByNormRaw) {
    if (!availableRawNames.has(raw)) continue; // claimed by some tenant above
    newTenants.push({ bintrackerTenantRaw: raw, primaryLocations: [...locations] });
  }

  return { newTenants, missingTenants, levelMismatches };
}

module.exports = {
  fetchBintrackerCollections,
  _pageSignature: pageSignature, // exported for the isolated unit test only, same pattern as _oauth1Header
  mapWasteTypeToStream,
  WASTE_TYPE_TO_STREAM,
  normalizeForMatching,
  findBestMatch,
  RECYCLABLE_STREAMS,
  MIN_ROWS_FOR_RECYCLING_LEVEL,
  computeRecyclingLevelPct,
  diffDiscoveredBuildingNames,
  diffBintrackerTenants,
  // exported for the isolated signing unit test - not used by other modules
  _oauth1Header: oauth1Header,
};
