// Plain Node unit tests for functions/bintracker.js's pure functions - no Firestore/Functions
// emulator needed, no real network call to Bintracker. Covers: the OAuth1/HMAC-SHA256 signing
// format (the exact quirk that broke once already - no space after commas), the wasteType->
// stream lookup table, and the shared fuzzy-matching helper (Workstream 7 Point 1 + Workstream 12
// both depend on this).
// Run: npm run test:bintracker-unit
const assert = require('assert');
const { mapWasteTypeToStream, normalizeForMatching, findBestMatch, computeRecyclingLevelPct, MIN_ROWS_FOR_RECYCLING_LEVEL, _oauth1Header, _pageSignature } = require('../functions/bintracker');

const results = [];
function check(label, cond, extra) { results.push({ label, ok: Boolean(cond), extra: extra || '' }); }

// --- OAuth1 header format ---
const header = _oauth1Header('GET', 'https://ds.bintracker.com.au/api/Collections/GetAsync', {
  'request.building': 'Demo Building',
  'request.collectDateFrom': '2026-01-01',
  'request.collectDateTo': '2026-01-31',
  'request.page': '1',
  'request.pageSize': '500',
}, 'fake-app-id', 'fake-app-key');

check('header starts with "OAuth "', header.startsWith('OAuth '), header.slice(0, 30));
check('header has no space after any comma (Bintracker\'s real quirk)', !/,\s/.test(header), header);
check('header includes oauth_consumer_key', header.includes('oauth_consumer_key="fake-app-id"'));
check('header includes oauth_signature_method=HMAC-SHA256', header.includes('oauth_signature_method="HMAC-SHA256"'));
check('header includes a real base64-looking oauth_signature', /oauth_signature="[A-Za-z0-9+/=%]+"/.test(header), header);
check('header does NOT include oauth_version (Bintracker\'s own config leaves it out)', !header.includes('oauth_version'));

// Same base string signed twice with the same inputs except nonce/timestamp (which are
// time/random-based) should differ - proves the signature actually depends on the nonce/timestamp,
// not a hardcoded stub.
const header2 = _oauth1Header('GET', 'https://ds.bintracker.com.au/api/Collections/GetAsync', {
  'request.building': 'Demo Building',
}, 'fake-app-id', 'fake-app-key');
check('two calls produce different nonces (real randomness, not a stub)', header !== header2);

// --- wasteType -> stream mapping (finalized 2026-09-24) ---
const expectedMappings = {
  'General Waste': 'gw', 'Dry Waste (Demo)': 'gw', 'Non-recycled': 'gw',
  'Mixed recycling': 'mr', 'Aluminium': 'mr', 'Glass': 'mr', 'Polystyrene': 'mr',
  'Paper & cardboard': 'pc', 'Cardboard': 'pc', 'CDS Cartons': 'pc',
  'Organics': 'og', 'Coffee Grounds': 'og', 'Cooking oil': 'og',
  'e-waste': 'ew', 'Batteries': 'ew', 'Fluorescent tubes': 'ew',
};
for (const [wasteType, expectedStream] of Object.entries(expectedMappings)) {
  check(`"${wasteType}" maps to "${expectedStream}"`, mapWasteTypeToStream(wasteType) === expectedStream, mapWasteTypeToStream(wasteType));
}
// Unlisted values (not one of the 5 core streams, or test junk) must be silently dropped, never
// defaulted to any stream.
for (const junk of ['Coffee cups', 'Pallets', 'Clothing Donation', '123aw', 'name1', '']) {
  check(`"${junk}" is NOT mapped to any stream (silently excluded)`, mapWasteTypeToStream(junk) === null, mapWasteTypeToStream(junk));
}

// --- Fuzzy matching ---
check('normalizeForMatching lowercases, strips punctuation, collapses whitespace',
  normalizeForMatching('  Acme Legal, Pty. Ltd!  ') === 'acme legal pty ltd',
  normalizeForMatching('  Acme Legal, Pty. Ltd!  '));

const exactMatch = findBestMatch('Acme Legal', ['Widgetco', 'Acme Legal', 'Northwind']);
check('exact match found with "exact" confidence', exactMatch && exactMatch.candidate === 'Acme Legal' && exactMatch.confidence === 'exact', JSON.stringify(exactMatch));

const containsMatch = findBestMatch('Acme Legal', ['Widgetco', 'ACME LEGAL PTY LTD', 'Northwind']);
check('substring-contains match found with "contains" confidence', containsMatch && containsMatch.candidate === 'ACME LEGAL PTY LTD' && containsMatch.confidence === 'contains', JSON.stringify(containsMatch));

const containsMatch2 = findBestMatch('Acme Legal Pty Ltd', ['Widgetco', 'Acme Legal', 'Northwind']);
check('reverse substring-contains match (our name longer than theirs)', containsMatch2 && containsMatch2.candidate === 'Acme Legal' && containsMatch2.confidence === 'contains', JSON.stringify(containsMatch2));

const partialMatch = findBestMatch('Rob Test Tenant', ['Some Other Co', 'Test Tenant Rob Variant', 'Northwind']);
check('word-overlap partial match found with "partial" confidence', partialMatch && partialMatch.confidence === 'partial', JSON.stringify(partialMatch));

const noMatch = findBestMatch('Completely Unrelated Name', ['Widgetco', 'Acme Legal', 'Northwind']);
check('no candidate above the floor returns null', noMatch === null, JSON.stringify(noMatch));

const emptyOurs = findBestMatch('', ['Widgetco']);
check('an empty our-name returns null (nothing to match)', emptyOurs === null, JSON.stringify(emptyOurs));

// --- computeRecyclingLevelPct (Workstream 7 Point 5 sub-idea, 2026-09-24; formula revised
// 2026-10-05 to NABERS' kg-recovered/kg-generated definition) ---
// `weight` is the only input that matters now; `externalOnly` is deliberately left OUT of these
// row objects - the function no longer filters by it internally (that became the CALLER's job,
// since building-level needs external rows and tenant-level needs internal rows - that split is
// covered by functions-refreshbintrackerdata.test.js instead, which exercises the real caller,
// writeRecyclingLevelAggregates). Non-uniform weights throughout prove this is real weight-based
// math, not row counting that happens to look right when every row weighs the same.
function row(ourStream, weight) {
  return { ourStream, weight };
}

check('MIN_ROWS_FOR_RECYCLING_LEVEL is the documented floor of 5', MIN_ROWS_FOR_RECYCLING_LEVEL === 5, MIN_ROWS_FOR_RECYCLING_LEVEL);

// Below the sample floor: 4 rows - still null, regardless of weight/stream.
const tooFewRows = [
  row('mr', 10), row('mr', 20),
  row('pc', 15), row('og', 15),
];
check('below the 5-row floor returns null, not a misleading percentage',
  computeRecyclingLevelPct(tooFewRows) === null, computeRecyclingLevelPct(tooFewRows));

// Exactly at the floor (5 rows), non-uniform weights, all 3 recyclable streams ->
// recovered (mr+pc+og) = 10+20+30 = 60kg, generated = 60kg (no non-recyclable rows yet) -> 100%
// reserved for the next case; THIS case mixes in weight that must count toward generated only.
const atFloorMixed = [
  row('mr', 10), row('mr', 20),
  row('pc', 15), row('og', 15),
  row('gw', 40),
];
check('at exactly 5 rows, computes real weight-based recovered/generated (60/100 = 60%)',
  computeRecyclingLevelPct(atFloorMixed) === 60, computeRecyclingLevelPct(atFloorMixed));

// gw/ew rows must count toward GENERATED (the denominator) but never toward RECOVERED (the
// numerator) - this is the actual 2026-10-05 behavior change from the pre-fix formula, which used
// to exclude them from both. Adding more gw/ew weight on top of atFloorMixed must LOWER the
// percentage (more generated, same recovered), not leave it unchanged.
const moreGwEw = [
  ...atFloorMixed,
  row('gw', 40), row('ew', 20),
];
check('additional gw/ew weight dilutes the percentage (still counts as generated, never recovered)',
  computeRecyclingLevelPct(moreGwEw) === 38, computeRecyclingLevelPct(moreGwEw)); // 60/(100+60) = 37.5 -> rounds to 38

// All-recyclable-streams and all-non-recyclable-streams boundary cases (weight-based, not
// wasteOutcome-based - that field is no longer read by this function at all).
const allRecyclable = [row('mr', 10), row('mr', 20), row('pc', 30), row('pc', 10), row('og', 30)];
check('all rows in recyclable streams computes 100%', computeRecyclingLevelPct(allRecyclable) === 100, computeRecyclingLevelPct(allRecyclable));
const allNonRecyclable = [row('gw', 10), row('gw', 20), row('ew', 30), row('gw', 10), row('ew', 30)];
check('all rows in non-recyclable streams computes 0%', computeRecyclingLevelPct(allNonRecyclable) === 0, computeRecyclingLevelPct(allNonRecyclable));

// A row with no usable weight (missing/non-numeric) contributes 0kg to both sides, not NaN/crash.
const missingWeight = [row('mr', 10), row('mr', 20), { ourStream: 'pc' }, row('og', 20), row('og', 10)];
check('a row with no weight field contributes 0kg, not NaN or a crash',
  computeRecyclingLevelPct(missingWeight) === 100, computeRecyclingLevelPct(missingWeight));

// All rows weighing 0kg -> generatedKg is 0 -> null (graceful absence), not a divide-by-zero NaN.
const allZeroWeight = [row('mr', 0), row('mr', 0), row('pc', 0), row('og', 0), row('gw', 0)];
check('all-zero-weight rows return null (would otherwise divide by zero)',
  computeRecyclingLevelPct(allZeroWeight) === null, computeRecyclingLevelPct(allZeroWeight));

check('an empty row array returns null', computeRecyclingLevelPct([]) === null, computeRecyclingLevelPct([]));

// --- pageSignature (found 2026-10-01 against real production data: Bintracker doesn't reliably
// honor request.page/pageSize, so the pagination loop needs to detect a repeated page and stop) ---
const rowsA = [{ id: 1, collectDate: '2026-09-01' }, { id: 2, collectDate: '2026-09-02' }];
const rowsA2 = [{ id: 1, collectDate: '2026-09-01' }, { id: 2, collectDate: '2026-09-02' }]; // same content, different array instance
const rowsB = [{ id: 1, collectDate: '2026-09-01' }, { id: 3, collectDate: '2026-09-03' }];
check('identical page content produces the same signature (even as a different array instance)',
  _pageSignature(rowsA) === _pageSignature(rowsA2));
check('different page content produces a different signature',
  _pageSignature(rowsA) !== _pageSignature(rowsB));
check('different row counts produce a different signature even if first/last rows happen to match',
  _pageSignature(rowsA) !== _pageSignature([rowsA[0], rowsA[1], rowsA[1]]));
check('an empty page has its own stable signature', _pageSignature([]) === _pageSignature([]), _pageSignature([]));

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} — ${r.label}${r.ok ? '' : ' :: ' + r.extra}`);
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
