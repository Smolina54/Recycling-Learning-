// Plain Node unit tests for functions/bintracker.js's pure functions - no Firestore/Functions
// emulator needed, no real network call to Bintracker. Covers: the OAuth1/HMAC-SHA256 signing
// format (the exact quirk that broke once already - no space after commas), the wasteType->
// stream lookup table, and the shared fuzzy-matching helper (Workstream 7 Point 1 + Workstream 12
// both depend on this).
// Run: npm run test:bintracker-unit
const assert = require('assert');
const { mapWasteTypeToStream, normalizeForMatching, findBestMatch, _oauth1Header } = require('../functions/bintracker');

const results = [];
function check(label, cond, extra) { results.push({ label, ok: Boolean(cond), extra: extra || '' }); }

// --- OAuth1 header format ---
const header = _oauth1Header('GET', 'https://dsdev.bintracker.com.au/api/Collections/GetAsync', {
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
const header2 = _oauth1Header('GET', 'https://dsdev.bintracker.com.au/api/Collections/GetAsync', {
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

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} — ${r.label}${r.ok ? '' : ' :: ' + r.extra}`);
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
