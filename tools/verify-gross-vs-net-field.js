// One-off diagnostic: fetch ONE specific real collection event from Bintracker's PRODUCTION API
// by its known unique id, and print its raw `weight`/`actualWeight` values side by side with the
// already-known real "Gross kg"/"Weight kg" values for that same event (read from a real Bintracker
// Excel export) - settles once and for all which API field is gross and which is net.
//
// Run this yourself, with your own real production credentials, directly in your terminal - never
// paste them into chat:
//   node tools/verify-gross-vs-net-field.js <APP_ID> <APP_KEY>
//
// Prints only the comparison result, nothing secret.
const { _oauth1Header } = require('../functions/bintracker');
const https = require('https');

const [appId, appKey] = process.argv.slice(2);
if (!appId || !appKey) {
  console.error('Usage: node tools/verify-gross-vs-net-field.js <APP_ID> <APP_KEY>');
  process.exit(1);
}

// The exact real collection event already confirmed in the 101 Collins Street Excel export:
// Collection Id 04CDB239-AF59-427F-86EF-FE48F967F989, 2026-09-04, Allens, Level 37,
// Paper & cardboard, 660ltr bin - Gross kg = 54.4, Weight kg (net) = 15.9 (a large, unambiguous gap).
const TARGET_ID = '04cdb239-af59-427f-86ef-fe48f967f989';
const KNOWN_GROSS = 54.4;
const KNOWN_NET = 15.9;

const BASE_URL = 'https://ds.bintracker.com.au/api/Collections/GetAsync';
const params = {
  'request.collectDateFrom': '2026-09-03',
  'request.collectDateTo': '2026-09-05',
  'request.page': '1',
  'request.pageSize': '500',
  'request.building': '101 Collins Street, Melbourne',
};

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

(async () => {
  const header = _oauth1Header('GET', BASE_URL, params, appId, appKey);
  const qs = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const res = await httpGet(`${BASE_URL}?${qs}`, { Authorization: header, Accept: 'application/json' });
  console.log('HTTP status:', res.status);
  if (res.status !== 200) {
    console.log('Response body (first 500 chars):', res.body.slice(0, 500));
    return;
  }
  const json = JSON.parse(res.body);
  const rows = json.data || [];
  console.log('Rows fetched for this window:', rows.length);

  const match = rows.find(r => String(r.id || '').toLowerCase() === TARGET_ID);
  if (!match) {
    console.log('Could not find the target row by id in this window. Try widening the date range, or double-check the building name string matches exactly what Bintracker uses.');
    return;
  }

  console.log('\n=== FOUND THE MATCHING ROW ===');
  console.log('Known from the real Excel export: Gross kg =', KNOWN_GROSS, '| Weight kg (net) =', KNOWN_NET);
  console.log('From the live API: weight =', match.weight, '| actualWeight =', match.actualWeight);

  const weightMatchesGross = Math.abs(match.weight - KNOWN_GROSS) < 0.2;
  const weightMatchesNet = Math.abs(match.weight - KNOWN_NET) < 0.2;
  const actualMatchesGross = Math.abs(match.actualWeight - KNOWN_GROSS) < 0.2;
  const actualMatchesNet = Math.abs(match.actualWeight - KNOWN_NET) < 0.2;

  console.log('\n=== CONCLUSION ===');
  if (weightMatchesGross && actualMatchesNet) {
    console.log('API field "weight" = GROSS kg. API field "actualWeight" = NET (Weight kg). Use actualWeight for the recycling-rate formula.');
  } else if (weightMatchesNet && actualMatchesGross) {
    console.log('API field "weight" = NET (Weight kg). API field "actualWeight" = GROSS kg. Use weight for the recycling-rate formula (current code already prefers this).');
  } else {
    console.log('Neither field matched cleanly - something unexpected. Raw values above need a manual look.');
  }
})();
