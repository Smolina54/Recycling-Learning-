// One-off diagnostic: fetch ONE specific real collection event from Bintracker's PRODUCTION API
// by its known id, and dump EVERY raw field it returns - looking for whichever field holds the
// CORRECTED waste type classification, since the top-level `wasteType` field was confirmed
// 2026-10-15 to sometimes reflect the ORIGINAL (pre-correction) classification instead of the
// final one Bintracker's own export/report shows as "Waste Type".
//
// Widened to the full 90-day window (not just July) after the first attempt found nothing in
// July alone - testing whether the id still exists anywhere in the live API at all, or whether
// Bintracker issues a NEW id when a collection gets corrected.
//
// Run this yourself, with your own real production credentials, directly in your terminal:
//   node tools/inspect-corrected-row.js <APP_ID> <APP_KEY>
const { _oauth1Header } = require('../functions/bintracker');
const https = require('https');

const [appId, appKey] = process.argv.slice(2);
if (!appId || !appKey) {
  console.error('Usage: node tools/inspect-corrected-row.js <APP_ID> <APP_KEY>');
  process.exit(1);
}

const TARGET_ID = '5f883e48-1d4b-42a8-abb7-4be1fe74366d';

const BASE_URL = 'https://ds.bintracker.com.au/api/Collections/GetAsync';
const today = new Date();
const fromDate = new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000);
const fmt = (d) => d.toISOString().slice(0, 10);
const params = {
  'request.collectDateFrom': fmt(fromDate),
  'request.collectDateTo': fmt(today),
  'request.page': '1',
  'request.pageSize': '500',
  'request.building': 'Tower 4 - Collins Square, Docklands',
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
  let page = 1;
  let found = null;
  let totalFetched = 0;
  // Also look for any row matching the same weight (9.4kg) + wasteType changes, as a fallback
  // clue if the id itself truly changed.
  const nearMatches = [];
  while (page <= 20) {
    const pageParams = { ...params, 'request.page': String(page) };
    const header = _oauth1Header('GET', BASE_URL, pageParams, appId, appKey);
    const qs = Object.entries(pageParams).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const res = await httpGet(`${BASE_URL}?${qs}`, { Authorization: header, Accept: 'application/json' });
    if (res.status !== 200) { console.log('HTTP', res.status, res.body.slice(0, 300)); return; }
    const json = JSON.parse(res.body);
    const rows = json.data || [];
    totalFetched += rows.length;
    console.log('Page', page, '-', rows.length, 'rows (total so far:', totalFetched + ')');
    const f = rows.find(r => String(r.id || '').toLowerCase() === TARGET_ID);
    if (f) { found = f; break; }
    for (const r of rows) {
      if (Math.abs((r.weight || 0) - 9.4) < 0.05 || Math.abs((r.actualWeight || 0) - 9.4) < 0.05) {
        nearMatches.push(r);
      }
    }
    if (rows.length < 500) break;
    page++;
  }

  if (found) {
    console.log('\n=== FOUND BY EXACT ID ===');
    console.log(JSON.stringify(found, null, 2));
    return;
  }

  console.log('\nTarget id NOT found anywhere in the full 90-day window (', totalFetched, 'total rows checked ).');
  console.log('This suggests the id may have changed when Bintracker corrected this collection.');
  console.log('\nRows with weight ~9.4kg (possible same event under a different id):', nearMatches.length);
  for (const r of nearMatches.slice(0, 5)) {
    console.log(JSON.stringify(r, null, 2));
  }
})();
