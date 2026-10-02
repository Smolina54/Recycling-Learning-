// One-off local helper (never run in production, never committed with real values filled in) to
// generate a signed Bintracker Authorization header for pasting into Postman - reuses this repo's
// own already-verified OAuth1/HMAC-SHA256 signing code (functions/bintracker.js's _oauth1Header),
// instead of Postman's built-in OAuth 1.0 auth, which adds a space after each comma in the header
// and gets rejected by Bintracker's server (see functions/bintracker.js's own top-of-file comment).
//
// Usage: node tools/generate-bintracker-auth-header.js <APP_ID> <APP_KEY> ["<exact building name>"]
// Prints the exact URL to call and the exact Authorization header value to paste into Postman
// (as a raw header under the Headers tab, NOT Postman's Authorization tab). Pass the building name
// (quoted, exactly as it appears in Bintracker's own `building` field) as a 3rd argument to scope
// the query to just that one building (fast) instead of every building (slow) - the API filters by
// name, not by the buildingId GUID, so this must be the real name string, not the id.
const { _oauth1Header } = require('../functions/bintracker');

const [appId, appKey, buildingName] = process.argv.slice(2);
if (!appId || !appKey){
  console.error('Usage: node tools/generate-bintracker-auth-header.js <APP_ID> <APP_KEY> ["<exact building name>"]');
  process.exit(1);
}

const BASE_URL = 'https://ds.bintracker.com.au/api/Collections/GetAsync';
const today = new Date();
const fromDate = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
const fmt = (d) => d.toISOString().slice(0, 10);

const params = {
  'request.collectDateFrom': fmt(fromDate),
  'request.collectDateTo': fmt(today),
  'request.page': '1',
  'request.pageSize': '500',
};
if (buildingName) params['request.building'] = buildingName;

const header = _oauth1Header('GET', BASE_URL, params, appId, appKey);
const qs = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

console.log('\n--- Paste this URL into Postman (GET request) ---');
console.log(`${BASE_URL}?${qs}`);
console.log('\n--- Paste this as a raw header in Postman\'s Headers tab (key: Authorization) ---');
console.log(header);
console.log('\n(This header is time-sensitive - generate a fresh one if more than a minute or two passes before sending.)\n');
