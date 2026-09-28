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

const BASE_URL = 'https://dsdev.bintracker.com.au'; // dev/test environment - stays here per the
// user's explicit decision (2026-09-17/22); moving to a production hostname is a deliberate
// later step, not part of this feature.
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

// Fetches every page of Collections for a date range, optionally scoped to one building name.
// Omitting `building` (undefined/null) queries across every building the credentials can see -
// used by discoverBintrackerBuildings; a real building name scopes to just that one, used by
// both refreshBintrackerData and syncBintrackerTenants.
async function fetchBintrackerCollections({ building, collectDateFrom, collectDateTo, appId, appKey }) {
  const allRows = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const queryParams = {
      'request.collectDateFrom': collectDateFrom,
      'request.collectDateTo': collectDateTo,
      'request.page': String(page),
      'request.pageSize': String(PAGE_SIZE),
    };
    if (building) queryParams['request.building'] = building;
    const baseUrl = BASE_URL + COLLECTIONS_PATH;
    const header = oauth1Header('GET', baseUrl, queryParams, appId, appKey);
    const qs = Object.keys(queryParams).map((k) => `${k}=${encodeURIComponent(queryParams[k])}`).join('&');
    const json = await httpGet(`${baseUrl}?${qs}`, { Authorization: header, Accept: 'application/json' });
    const rows = json.data || [];
    allRows.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
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

// ---- Recycling-level aggregate (Workstream 7 Point 5 sub-idea, 2026-09-24) ----
// The single combined "real recycling level" percentage shown on the id-gate (Point 5) -
// same scope restriction as Point 1's own comparisons: General Waste and E-Waste are excluded,
// since "recycled/non-recycled" has no meaning for them. A plain, pure function over an array of
// bintrackerRows-shaped objects (already filtered to one building, or one building+tenant, by
// the caller) so it can be unit-tested with no Firestore/Functions emulator at all, same as the
// rest of this file's exports.
const RECYCLABLE_STREAMS = new Set(['mr', 'pc', 'og']);
const MIN_ROWS_FOR_RECYCLING_LEVEL = 5; // same floor as Point 1's own comparison guard

// Returns a rounded 0-100 percentage, or null if there aren't at least
// MIN_ROWS_FOR_RECYCLING_LEVEL qualifying rows - never a 0% or otherwise misleading number from
// too thin a sample ("graceful absence", the same principle used everywhere else in this
// workstream). Qualifying = externalOnly === true AND ourStream is one of the 3 recyclable
// streams; among those, the share with wasteOutcome === 'Recycled'.
function computeRecyclingLevelPct(rows) {
  const qualifying = (rows || []).filter((r) => r.externalOnly === true && RECYCLABLE_STREAMS.has(r.ourStream));
  if (qualifying.length < MIN_ROWS_FOR_RECYCLING_LEVEL) return null;
  const recycled = qualifying.filter((r) => r.wasteOutcome === 'Recycled').length;
  return Math.round((recycled / qualifying.length) * 100);
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

  const matchedNormRaws = new Set();
  const missingTenants = [];
  const levelMismatches = [];

  for (const tenant of existingTenants || []) {
    const match = distinctRawTenantNames.length ? findBestMatch(tenant.name, distinctRawTenantNames) : null;
    if (!match) {
      missingTenants.push({ tenantId: tenant.id, tenantName: tenant.name, levels: tenant.levels || [] });
      continue;
    }
    const matchedNorm = normalizeForMatching(match.candidate);
    matchedNormRaws.add(matchedNorm);
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
  for (const [norm, { raw, locations }] of pairsByNormRaw) {
    if (matchedNormRaws.has(norm)) continue;
    newTenants.push({ bintrackerTenantRaw: raw, primaryLocations: [...locations] });
  }

  return { newTenants, missingTenants, levelMismatches };
}

module.exports = {
  BASE_URL,
  fetchBintrackerCollections,
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
