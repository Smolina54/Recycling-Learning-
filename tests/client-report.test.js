// Verifies outputs/client-report.html — the standalone, printable client-facing report
// (Workstream 7, Point 6 of the plan: C:\Users\smolina\.claude\plans\graceful-roaming-shell.md):
// the "no ?program=" / unrecognized ?program= fallback, the building checklist, an accurate
// Firestore-level date-range query (not the live dashboard's row-capped client-side filter),
// combined KPI/stream-accuracy/most-missed-items/completion-rate content, the rule-based "Key
// findings" summary, the full per-building breakdown (its own stats, chart, and findings - not
// just a name and a couple of numbers), and the empty-date-range state.
//
// Also covers Point 1, Phase C's "Real-world data (Bintracker)" sub-block, revised 2026-09-24 into
// two independent comparisons ("current state" / "induction impact", see the plan's "Implementation
// plan (2026-09-24)" section, and the 2026-10-05 revision note right below it) — the two checkboxes
// in the config step, the internal-rows/contaminated-based metric, the 4/2-case narratives, and the
// General Waste/E-Waste exclusion. The
// deep gap-magnitude-boundary and sample-floor matrix lives in report-bintracker-comparison.test.js
// (same underlying logic, the live Reports view's own toggle-driven counterpart) — this file's own
// Bintracker coverage stays proportionate to what's actually unique to the PDF: the two checkboxes'
// independence and the per-building "only if checked AND has findings" gating.
// Run: npm run test:client-report
const path = require('path');
const url = require('url');
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc, collection, Timestamp } = require('firebase/firestore');

const EDGE_PATH = process.env.TEST_BROWSER_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const REPORT_PATH = path.join(__dirname, '..', 'outputs', 'client-report.html');
const ADMIN_PATH = path.join(__dirname, '..', 'outputs', 'sorting-station-report.html');
const RULES_PATH = path.join(__dirname, '..', 'firestore.rules');
const ALLOWED_EMAIL = 'esgtradeflex@gmail.com';

function reportUrl(programId){
  const q = programId === undefined ? '' : `?program=${encodeURIComponent(programId)}`;
  return `${url.pathToFileURL(REPORT_PATH).href}${q}${q ? '&' : '?'}emulator=1`;
}

// Two buildings, three submissions skewed so the rule-based "Key findings" section has something
// real to say: Collins Tower's two scores (60, 68) both sit under the 75 pass mark (0% pass
// rate) while Harbor Plaza's one submission is a clean 100% - a 100-point gap, well over the
// 10-point finding threshold - and 'mr-jar' is missed often enough (67%) to clear the 25%
// most-commonly-missed threshold. Without this, the findings test would only ever see the
// generic "no major concerns" fallback and never prove the real logic fires.
//
// Also seeds a matching 'attempts' doc per submission's email, PLUS one extra attempt at
// Collins Tower (a3@example.com) with no matching submission - a person who started but never
// finished - so completed-vs-did-not-complete has a real, non-trivial number to check per
// building and combined, not just 100% everywhere.
async function seedTestData(){
  const testEnv = await initializeTestEnvironment({
    projectId: 'esg-1-98f35',
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  const b1 = 'client-report-test-collins-' + Date.now();
  const b2 = 'client-report-test-harbor-' + Date.now();
  // Point 1, Phase C: a third building, mapped to Bintracker, with three tenants exercising the
  // comparison's three interesting outcomes — deliberately separate from b1/b2 so none of the
  // pre-existing KPI/completion/findings assertions above (which count exact submissions/attempts
  // across b1+b2) need to change.
  const b3 = 'client-report-test-bintracker-' + Date.now();
  const tenantAgreeId = 'tenant-agree-' + Date.now();
  const tenantDisagreeId = 'tenant-disagree-' + Date.now();
  const tenantFloorId = 'tenant-floor-' + Date.now();
  const tenantAtFloorId = 'tenant-atfloor-' + Date.now();
  const tenantGwEwId = 'tenant-gwew-' + Date.now();
  const tenantExternalOnlyOrganicsId = 'tenant-external-only-organics-' + Date.now();
  const tenantImpactImprovedId = 'tenant-impact-improved-' + Date.now();
  const tenantImpactDeclinedId = 'tenant-impact-declined-' + Date.now();
  const isoLocal = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const todayStr = isoLocal(new Date()); // matches client-report.html's own default 90-day range (local-date based)
  // Comparison #2's before/after cutoff is UTC-based (submission timestamp.toDate().toISOString()),
  // independent of the local-date range above — computed separately so "before"/"after" collectDate
  // strings land unambiguously on either side of it regardless of the machine's local timezone.
  const todayUTCStr = new Date().toISOString().slice(0, 10);
  const yesterdayUTCStr = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'buildings', b1), { name: 'Collins Tower' });
    await setDoc(doc(db, 'buildings', b2), { name: 'Harbor Plaza' });
    await setDoc(doc(db, 'buildings', b3), { name: 'Bintracker Test Tower', bintrackerBuildingName: 'BT Tower' });
    await setDoc(doc(db, 'enrollments', `recycling-sorting__${b1}`), { programId: 'recycling-sorting', buildingId: b1, active: true });
    await setDoc(doc(db, 'enrollments', `recycling-sorting__${b2}`), { programId: 'recycling-sorting', buildingId: b2, active: true });
    await setDoc(doc(db, 'enrollments', `recycling-sorting__${b3}`), { programId: 'recycling-sorting', buildingId: b3, active: true });

    const now = Timestamp.now();
    const subs = [
      { buildingId: b1, buildingName: 'Collins Tower', email: 'a1@example.com', score: 60, avoided: 15, total: 25, breakdown: { gw:{avoided:3,total:5}, mr:{avoided:2,total:5}, pc:{avoided:3,total:5}, og:{avoided:3,total:5}, ew:{avoided:4,total:5} }, items: { 'mr-jar': 0, 'og-coffee': 1 } },
      { buildingId: b1, buildingName: 'Collins Tower', email: 'a2@example.com', score: 68, avoided: 17, total: 25, breakdown: { gw:{avoided:4,total:5}, mr:{avoided:2,total:5}, pc:{avoided:3,total:5}, og:{avoided:4,total:5}, ew:{avoided:4,total:5} }, items: { 'mr-jar': 0, 'og-coffee': 0 } },
      { buildingId: b2, buildingName: 'Harbor Plaza', email: 'c1@example.com', score: 100, avoided: 25, total: 25, breakdown: { gw:{avoided:5,total:5}, mr:{avoided:5,total:5}, pc:{avoided:5,total:5}, og:{avoided:5,total:5}, ew:{avoided:5,total:5} }, items: { 'mr-jar': 1, 'og-coffee': 1 } },
    ];
    for (let i = 0; i < subs.length; i++){
      await setDoc(doc(db, 'submissions', 'client-report-test-sub-' + i + '-' + Date.now()), {
        ...subs[i], programId: 'recycling-sorting', tenantName: 'Test Tenant', level: 'Level 1',
        name: 'Test Person', timestamp: now, device_type: 'desktop', duration_seconds: 180,
      });
      await setDoc(doc(db, 'attempts', 'client-report-test-attempt-' + i + '-' + Date.now()), {
        buildingId: subs[i].buildingId, programId: 'recycling-sorting', email: subs[i].email, startedAt: now,
      });
    }
    await setDoc(doc(db, 'attempts', 'client-report-test-attempt-unfinished-' + Date.now()), {
      buildingId: b1, programId: 'recycling-sorting', email: 'a3@example.com', startedAt: now,
    });

    // --- Point 1, Phase C (revised 2026-09-24): Real-world data seed data for b3 ---
    // Induction accuracy is SUM(avoided)/SUM(total) across a tenant's submissions, not a doc count —
    // so an exact percentage is free to set via one "real weight" doc, padded to `subCount` total
    // contributing docs with 0/0 entries so the >=3-submissions floor is exercised on its own.
    async function seedInductionSubs({ tenantId, tenantName, level, stream, pct, subCount, timestamp }){
      for (let i = 0; i < subCount; i++){
        const breakdown = { [stream]: i === 0 ? { avoided: pct, total: 100 } : { avoided: 0, total: 0 } };
        await setDoc(doc(db, 'submissions', `client-report-test-${tenantId}-${i}`), {
          buildingId: b3, buildingName: 'Bintracker Test Tower', tenantId, tenantName, level,
          email: `${tenantId}-${i}@example.com`, name: 'Test Person', programId: 'recycling-sorting',
          score: pct, avoided: pct, total: 100, breakdown,
          timestamp: timestamp || now, device_type: 'desktop', duration_seconds: 120,
        });
      }
    }
    // Real Bintracker rows ARE individually-counted documents, so the exact "real" share is limited
    // by `count` — `recycledCount` of the first `count` rows are contaminated:false (the actual
    // "good"/recovered signal the comparison logic reads, since the 2026-10-05 fix moved off the
    // unreliable `wasteOutcome` field). `wasteOutcome` is still stored (matches the real doc shape)
    // but deliberately uncorrelated with `recycledCount` — it's no longer read, so it must not
    // accidentally make a wrong test pass. Defaults to `externalOnly: false` (internal rows) — per
    // that same fix, per-tenant comparisons can only ever be computed from internal data; pass
    // `externalOnly: true` explicitly only for the one case proving external-only data is excluded.
    async function seedBintrackerRows({ tenantRaw, level, stream, count, recycledCount, externalOnly, collectDate }){
      for (let i = 0; i < count; i++){
        await setDoc(doc(collection(db, 'bintrackerRows')), {
          buildingId: b3, bintrackerTenantRaw: tenantRaw, bintrackerLocationRaw: level,
          ourStream: stream, wasteTypeRaw: 'test',
          contaminated: i >= recycledCount,
          externalOnly: externalOnly === true,
          wasteOutcome: 'Recycled',
          collectDate: collectDate || todayStr, weight: 10, fetchedAt: now,
        });
      }
    }
    async function seedMatch({ tenantId, tenantName, tenantRaw, level }){
      await setDoc(doc(db, 'bintrackerTenantMatches', `${b3}__${tenantId}`), {
        buildingId: b3, tenantId, tenantName, bintrackerTenantRaw: tenantRaw, bintrackerLocationRaw: level,
        confirmedBy: ALLOWED_EMAIL, confirmedAt: now, status: 'confirmed',
      });
    }

    // Tenant Agree: induction 30% on Mixed Recycling (low, <75%), real Bintracker data shows 40%
    // successfully recycled (also low, internal rows) -> AGREE (low+low).
    await seedInductionSubs({ tenantId: tenantAgreeId, tenantName: 'Tenant Agree', level: 'Level 5', stream: 'mr', pct: 30, subCount: 3 });
    await seedBintrackerRows({ tenantRaw: 'BT Acme Agree', level: 'Level 5', stream: 'mr', count: 5, recycledCount: 2 });
    await seedMatch({ tenantId: tenantAgreeId, tenantName: 'Tenant Agree', tenantRaw: 'BT Acme Agree', level: 'Level 5' });

    // Tenant Disagree: induction 30% on Paper & Cardboard (low), but real data is 100% recycled
    // (good) -> DISAGREE, a 70-point gap (large, "real recycling is notably better...").
    await seedInductionSubs({ tenantId: tenantDisagreeId, tenantName: 'Tenant Disagree', level: 'Level 6', stream: 'pc', pct: 30, subCount: 3 });
    await seedBintrackerRows({ tenantRaw: 'BT Acme Disagree', level: 'Level 6', stream: 'pc', count: 5, recycledCount: 5 });
    await seedMatch({ tenantId: tenantDisagreeId, tenantName: 'Tenant Disagree', tenantRaw: 'BT Acme Disagree', level: 'Level 6' });

    // Tenant BelowFloor: 3 induction submissions (clears that floor) on Organics, but only 4
    // matching internal Bintracker rows (below the >=5 floor) -> must produce NO finding at all.
    await seedInductionSubs({ tenantId: tenantFloorId, tenantName: 'Tenant BelowFloor', level: 'Level 7', stream: 'og', pct: 30, subCount: 3 });
    await seedBintrackerRows({ tenantRaw: 'BT Acme Floor', level: 'Level 7', stream: 'og', count: 4, recycledCount: 1 });
    await seedMatch({ tenantId: tenantFloorId, tenantName: 'Tenant BelowFloor', tenantRaw: 'BT Acme Floor', level: 'Level 7' });

    // Tenant AtFloor: exactly at BOTH floors (3 submissions, 5 real rows) -> must still produce a
    // finding — proves the floors are inclusive, not exclusive.
    await seedInductionSubs({ tenantId: tenantAtFloorId, tenantName: 'Tenant AtFloor', level: 'Level 8', stream: 'mr', pct: 100, subCount: 3 });
    await seedBintrackerRows({ tenantRaw: 'BT Acme AtFloor', level: 'Level 8', stream: 'mr', count: 5, recycledCount: 5 });
    await seedMatch({ tenantId: tenantAtFloorId, tenantName: 'Tenant AtFloor', tenantRaw: 'BT Acme AtFloor', level: 'Level 8' });

    // Tenant GwEw: abundant, "obviously findable" data (30% induction / 30% real, low+low, well over
    // both floors) on General Waste AND E-Waste — the two streams that must NEVER produce a finding
    // on either comparison, a hard scope filter rather than a low-probability outcome.
    await seedInductionSubs({ tenantId: tenantGwEwId, tenantName: 'Tenant GwEw', level: 'Level 9', stream: 'gw', pct: 30, subCount: 5 });
    await seedBintrackerRows({ tenantRaw: 'BT Acme GwEw', level: 'Level 9', stream: 'gw', count: 10, recycledCount: 3 });
    await seedInductionSubs({ tenantId: tenantGwEwId, tenantName: 'Tenant GwEw', level: 'Level 9', stream: 'ew', pct: 30, subCount: 5 });
    await seedBintrackerRows({ tenantRaw: 'BT Acme GwEw', level: 'Level 9', stream: 'ew', count: 10, recycledCount: 3 });
    await seedMatch({ tenantId: tenantGwEwId, tenantName: 'Tenant GwEw', tenantRaw: 'BT Acme GwEw', level: 'Level 9' });

    // Tenant ExternalOnlyOrganics: Organics data recorded ONLY via external/contractor hauling
    // (externalOnly:true), zero internal rows -> no Organics finding, with no special-case code
    // (falls out of the internal-only >=5 floor) — proves the 2026-10-05 fix's real population
    // requirement (internal rows only) correctly excludes external-only data.
    await seedInductionSubs({ tenantId: tenantExternalOnlyOrganicsId, tenantName: 'Tenant ExternalOnlyOrganics', level: 'Level 10', stream: 'og', pct: 20, subCount: 3 });
    await seedBintrackerRows({ tenantRaw: 'BT Acme ExternalOnlyOrganics', level: 'Level 10', stream: 'og', count: 10, recycledCount: 8, externalOnly: true });
    await seedMatch({ tenantId: tenantExternalOnlyOrganicsId, tenantName: 'Tenant ExternalOnlyOrganics', tenantRaw: 'BT Acme ExternalOnlyOrganics', level: 'Level 10' });

    // --- Comparison #2 ("Induction impact") ---
    // Cutoff = the tenant's own submission timestamp (`now`, i.e. today in UTC) — before rows use
    // yesterday's date, after rows use today's, matching collectDate < / >= cutoff exactly.
    await setDoc(doc(db, 'submissions', `client-report-test-${tenantImpactImprovedId}`), {
      buildingId: b3, buildingName: 'Bintracker Test Tower', tenantId: tenantImpactImprovedId, tenantName: 'Tenant ImpactImproved',
      level: 'Level 11', email: `${tenantImpactImprovedId}@example.com`, name: 'Test Person', programId: 'recycling-sorting',
      score: 80, avoided: 8, total: 10, timestamp: now, device_type: 'desktop', duration_seconds: 120,
    });
    // Before: 2/5 = 40% recycled. After: 4/5 = 80% recycled. Gap 40pts (large, at exactly the 5/5 floor).
    await seedBintrackerRows({ tenantRaw: 'BT Acme ImpactImproved', level: 'Level 11', stream: 'mr', count: 5, recycledCount: 2, collectDate: yesterdayUTCStr });
    await seedBintrackerRows({ tenantRaw: 'BT Acme ImpactImproved', level: 'Level 11', stream: 'mr', count: 5, recycledCount: 4, collectDate: todayUTCStr });
    await seedMatch({ tenantId: tenantImpactImprovedId, tenantName: 'Tenant ImpactImproved', tenantRaw: 'BT Acme ImpactImproved', level: 'Level 11' });

    await setDoc(doc(db, 'submissions', `client-report-test-${tenantImpactDeclinedId}`), {
      buildingId: b3, buildingName: 'Bintracker Test Tower', tenantId: tenantImpactDeclinedId, tenantName: 'Tenant ImpactDeclined',
      level: 'Level 12', email: `${tenantImpactDeclinedId}@example.com`, name: 'Test Person', programId: 'recycling-sorting',
      score: 80, avoided: 8, total: 10, timestamp: now, device_type: 'desktop', duration_seconds: 120,
    });
    // Before: 8/10 = 80% recycled. After: 5/10 = 50% recycled. Gap 30pts, declined.
    await seedBintrackerRows({ tenantRaw: 'BT Acme ImpactDeclined', level: 'Level 12', stream: 'pc', count: 10, recycledCount: 8, collectDate: yesterdayUTCStr });
    await seedBintrackerRows({ tenantRaw: 'BT Acme ImpactDeclined', level: 'Level 12', stream: 'pc', count: 10, recycledCount: 5, collectDate: todayUTCStr });
    await seedMatch({ tenantId: tenantImpactDeclinedId, tenantName: 'Tenant ImpactDeclined', tenantRaw: 'BT Acme ImpactDeclined', level: 'Level 12' });
  });
  return { b1, b2, b3 };
}

const results = [];
function check(label, cond, extra){ results.push({ label, ok: Boolean(cond), extra: extra || '' }); }

async function main(){
  const browser = await puppeteer.launch({ executablePath: EDGE_PATH, headless: true });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  try {
    await runFlow(page, consoleErrors);
  } catch (err) {
    console.error('CRASHED — dumping diagnostics:', err.message);
    console.error('--- results so far ---');
    for (const r of results){ console.error(`${r.ok ? 'PASS' : 'FAIL'} — ${r.label}${r.extra ? ' :: ' + r.extra : ''}`); }
    await page.screenshot({ path: path.join(__dirname, '..', 'debug-crash.png') }).catch(() => {});
    await browser.close();
    process.exit(1);
  }

  const unexpectedErrors = consoleErrors.filter(e => !e.includes('Failed to load resource') && !e.includes('400'));
  check('no unexpected console/page errors', unexpectedErrors.length === 0, unexpectedErrors.join(' || '));

  await browser.close();
  console.log('\n--- RESULTS ---');
  let allOk = true;
  for (const r of results){
    console.log(`${r.ok ? 'PASS' : 'FAIL'} — ${r.label}${r.extra ? ' :: ' + r.extra : ''}`);
    if (!r.ok) allOk = false;
  }
  process.exit(allOk ? 0 : 1);
}

async function runFlow(page, consoleErrors){
  const { b1, b3 } = await seedTestData();

  // --- "No ?program=" and an unrecognized one: the explicit fallback, never a silent default ---
  await page.goto(reportUrl(undefined), { waitUntil: 'domcontentloaded' });
  await page.evaluate(async (email) => { await window.__testSignIn(email, 'test-password-123'); }, ALLOWED_EMAIL);
  await page.waitForFunction(() => document.getElementById('noProgramNote').style.display !== 'none', { timeout: 10000 });
  check('missing ?program= shows the "go back and pick one" note, not a crash', true);

  await page.goto(reportUrl('not-a-real-program'), { waitUntil: 'domcontentloaded' });
  await page.evaluate(async (email) => { await window.__testSignIn(email, 'test-password-123'); }, ALLOWED_EMAIL);
  await page.waitForFunction(() => document.getElementById('noProgramNote').style.display !== 'none', { timeout: 10000 });
  check('unrecognized ?program= shows the same fallback note', true);

  // --- The real flow ---
  await page.goto(reportUrl('recycling-sorting'), { waitUntil: 'domcontentloaded' });
  await page.evaluate(async (email) => { await window.__testSignIn(email, 'test-password-123'); }, ALLOWED_EMAIL);
  await page.waitForFunction(() => document.getElementById('reportSection').style.display !== 'none', { timeout: 10000 });
  check('report section becomes visible after sign-in', true);

  await page.waitForFunction(() => document.querySelectorAll('.building-check').length >= 3, { timeout: 10000 });
  const checklistCount = await page.$$eval('.building-check', els => els.length);
  check('all three seeded buildings appear in the checklist', checklistCount === 3, checklistCount);

  // Every checkbox defaults to checked - uncheck the Bintracker-dedicated building (b3) for the
  // main flow below, which is tested separately, later, and would otherwise perturb every
  // existing KPI/completion/findings assertion below (all written assuming exactly b1+b2's data).
  await page.evaluate((id) => {
    const cb = document.querySelector(`.building-check[value="${id}"]`);
    if (cb) cb.checked = false;
  }, b3);

  // Leave the default date range untouched - this is the real, load-bearing regression check for
  // the local-timezone bug found 2026-09-18 (setDefaultDateRange() used toISOString(), a UTC
  // date, while generateReport() parses the typed value as local time; for any timezone ahead of
  // UTC this silently excluded "today"'s own submissions from the default range).
  await page.click('#generateBtn');
  await page.waitForFunction(() => getComputedStyle(document.getElementById('reportDoc')).display !== 'none', { timeout: 10000 });
  const emptyVisibleOnDefaultRange = await page.$eval('#reportEmptyNote', el => getComputedStyle(el).display !== 'none');
  check('the untouched default date range includes "now"-timestamped submissions (no false empty state)', !emptyVisibleOnDefaultRange);

  const kpiText = await page.$eval('#kpiStrip', el => el.textContent.replace(/\s+/g,' '));
  check('KPI strip shows 3 submissions combined', kpiText.includes('3'), kpiText);
  // 4 people attempted combined (a1, a2, a3, c1), 3 completed (a3 never finished) - 75%.
  check('KPI strip shows the combined completion rate (75%, a3 never finished)', kpiText.includes('75%') && kpiText.includes('Completion rate'), kpiText);

  const streamChartText = await page.$eval('#streamChart', el => el.textContent);
  check('stream chart renders stream names', streamChartText.includes('Mixed Recycling') && streamChartText.includes('General Waste'), streamChartText.replace(/\s+/g,' ').slice(0,200));

  const missedText = await page.$eval('#missedList', el => el.textContent);
  check('missed items list shows a seeded item name', missedText.includes('Rinsed glass jar') || missedText.includes('Coffee grounds'), missedText.replace(/\s+/g,' ').slice(0,200));

  const findingsText = await page.$eval('#keyFindings', el => el.textContent);
  check('key findings calls out the weaker building by name', findingsText.includes('Collins Tower') && findingsText.includes('Harbor Plaza'), findingsText.replace(/\s+/g,' ').slice(0,300));

  // --- Print / Save as PDF (Paged.js) actually completes, no uncaught pageerror ---
  // Regression test for a real production bug (2026-09-24): Paged.js does its own internal
  // url(...) parsing while building its virtual page model, separate from the browser's native
  // CSS engine - it throws "Failed to construct 'URL': Invalid URL" on the @font-face src's
  // relative branding/*.otf paths, silently hanging pagination forever (the print overlay never
  // clears, "Still working..." shows after 8s and never resolves). Fixed in buildPrintDocument()
  // by rewriting relative branding/ references to absolute ones before handing the stylesheet to
  // Paged.js. This check would have caught it (a pageerror during/after the click).
  const errorsBeforePrint = consoleErrors.length;
  await page.click('#printReportBtn');
  // Paged.js actually finishing pagination (real .pagedjs_page boxes exist in the iframe) is the
  // real signal that the bug is fixed - checked instead of waiting for the overlay to clear via
  // window.print()/'afterprint', since headless Puppeteer/Edge doesn't reliably resolve a nested
  // iframe's own window.print() the way a real user's OS print dialog would.
  const pagingCompleted = await page.waitForFunction(
    () => {
      const iframe = document.querySelector('.print-frame');
      return iframe && iframe.contentDocument && iframe.contentDocument.querySelector('.pagedjs_page');
    },
    { timeout: 15000 }
  ).then(() => true).catch(() => false);
  check('clicking "Print / Save as PDF" actually paginates the report (real .pagedjs_page boxes appear)', pagingCompleted);
  const printErrors = consoleErrors.slice(errorsBeforePrint);
  check('no pageerror during the print/Paged.js flow', !printErrors.some(e => e.startsWith('pageerror:')), printErrors.join(' || '));
  // Headless window.print() may never fire 'afterprint' on a nested iframe, unlike a real user's
  // OS print dialog closing - clean up directly instead of waiting on it, so later steps in this
  // same test aren't blocked by the still-open, full-viewport overlay.
  await page.evaluate(() => { const btn = document.getElementById('cancelPrintBtn'); if (btn) btn.click(); });
  check('key findings calls out the most commonly missed item', findingsText.includes('Rinsed glass jar'), findingsText.replace(/\s+/g,' ').slice(0,300));

  const byBuildingVisible = await page.$eval('#byBuildingSection', el => getComputedStyle(el).display !== 'none');
  check('by-building breakdown shows when 2 buildings selected', byBuildingVisible);

  const buildingBlocks = await page.$$eval('.building-block', els => els.map(el => el.textContent.replace(/\s+/g,' ')));
  check('by-building breakdown renders one block per building', buildingBlocks.length === 2, buildingBlocks.length);
  const collinsBlock = buildingBlocks.find(t => t.includes('Collins Tower')) || '';
  const harborBlock = buildingBlocks.find(t => t.includes('Harbor Plaza')) || '';

  // Collins Tower: 2 attempts completed (a1, a2), 1 did not (a3) - 67% completion rate.
  check('Collins Tower block shows its own completed/did-not-complete/completion-rate stats', collinsBlock.includes('2') && collinsBlock.includes('Completed') && collinsBlock.includes('1') && collinsBlock.includes('Did not complete') && collinsBlock.includes('67%'), collinsBlock.slice(0,400));
  check('Collins Tower block includes its own stream accuracy chart', collinsBlock.includes('Accuracy by stream') && collinsBlock.includes('Mixed Recycling'), collinsBlock.slice(0,400));
  check('Collins Tower block flags its own weak stream and missed item', collinsBlock.includes('Mixed Recycling accuracy below average') && collinsBlock.includes('Rinsed glass jar'), collinsBlock.slice(0,600));

  // Harbor Plaza: 1 attempt, 1 completed, 0 did not - 100% completion rate, no issues of its own.
  check('Harbor Plaza block shows its own completed/did-not-complete/completion-rate stats', harborBlock.includes('Completed') && harborBlock.includes('Did not complete') && harborBlock.includes('100%'), harborBlock.slice(0,400));
  check('Harbor Plaza block shows the graceful fallback (no issues of its own)', harborBlock.includes('No significant issues identified'), harborBlock.slice(0,600));

  const metaText = await page.$eval('#reportBuildingsMeta', el => el.textContent);
  check('cover shows both building names', metaText.includes('Collins Tower') && metaText.includes('Harbor Plaza'), metaText);

  const coverLogos = await page.$$eval('.report-cover img', els => els.map(el => el.getAttribute('src')));
  check('report cover uses the white (dark-background) Tradeflex + FutureGreen logos', coverLogos[0] === 'branding/tradeflex-logo-white.png' && coverLogos[1] === 'branding/futuregreen-logo-white.png', JSON.stringify(coverLogos));

  // --- Deselect one building, regenerate: per-building section hides, findings adapt to 1 building ---
  const editBtn = await page.waitForSelector('#editSelectionBtn', { visible: true, timeout: 5000 });
  await editBtn.evaluate(el => el.scrollIntoView());
  await editBtn.click();
  await page.waitForFunction(() => document.getElementById('configSection').style.display !== 'none', { timeout: 5000 });
  await page.evaluate((id) => {
    document.querySelectorAll('.building-check').forEach(el => { el.checked = (el.value === id); });
  }, b1);
  const genBtn2 = await page.waitForSelector('#generateBtn', { visible: true, timeout: 5000 });
  await genBtn2.evaluate(el => el.scrollIntoView());
  await genBtn2.click();
  await page.waitForFunction(() => getComputedStyle(document.getElementById('reportDoc')).display !== 'none', { timeout: 10000 });
  const singleKpi = await page.$eval('#kpiStrip', el => el.textContent);
  check('single-building regenerate shows 2 submissions (only Collins Tower)', singleKpi.includes('2'), singleKpi.replace(/\s+/g,' '));
  const singleByBuildingHidden = await page.$eval('#byBuildingSection', el => getComputedStyle(el).display === 'none');
  check('by-building breakdown hides when only 1 building selected', singleByBuildingHidden);

  // --- Point 1, Phase C (revised): Real-world data sub-blocks (all 3 buildings). Both Bintracker
  // checkboxes default to UNCHECKED (decided 2026-09-28 - an admin opts in per report rather than
  // it appearing automatically), so this test explicitly checks both before generating. ---
  const editBtnBt = await page.waitForSelector('#editSelectionBtn', { visible: true, timeout: 5000 });
  await editBtnBt.evaluate(el => el.scrollIntoView());
  await editBtnBt.click();
  await page.waitForFunction(() => document.getElementById('configSection').style.display !== 'none', { timeout: 5000 });
  await page.evaluate(() => {
    document.querySelectorAll('.building-check').forEach(el => { el.checked = true; });
  });

  const bothUncheckedByDefault = await page.evaluate(() =>
    !document.getElementById('includeBintrackerCurrentCheck').checked && !document.getElementById('includeBintrackerImpactCheck').checked);
  check('both Bintracker comparison checkboxes default to unchecked', bothUncheckedByDefault);
  await page.evaluate(() => {
    document.getElementById('includeBintrackerCurrentCheck').checked = true;
    document.getElementById('includeBintrackerImpactCheck').checked = true;
  });

  async function generateAndGetBlocks(){
    const genBtn = await page.waitForSelector('#generateBtn', { visible: true, timeout: 5000 });
    await genBtn.evaluate(el => el.scrollIntoView());
    await genBtn.click();
    await page.waitForFunction(() => getComputedStyle(document.getElementById('reportDoc')).display !== 'none', { timeout: 10000 });
    // Bintracker findings are fetched asynchronously (Promise.all inside generateReport) but
    // generateReport() itself awaits them before flipping reportDoc visible, so no extra wait
    // should be needed - still, give the DOM a beat in case of a slow emulator round-trip.
    await new Promise(r => setTimeout(r, 300));
    const blocks = await page.$$eval('.building-block', els => els.map(el => el.textContent.replace(/\s+/g,' ')));
    return { btBlock: blocks.find(t => t.includes('Bintracker Test Tower')) || '', collinsBlock: blocks.find(t => t.includes('Collins Tower')) || '', all: blocks };
  }

  const pass1 = await generateAndGetBlocks();
  check('by-building breakdown renders one block per building (all 3 selected)', pass1.all.length === 3, pass1.all.length);

  check('Bintracker Test Tower block shows the current-state sub-block', pass1.btBlock.includes('Real-world data: current state'), pass1.btBlock.slice(0, 200));
  check('Bintracker Test Tower block shows the induction-impact sub-block', pass1.btBlock.includes('Real-world data: induction impact'), pass1.btBlock.slice(0, 200));
  check('reports the low+low agreeing tenant+stream correctly',
    pass1.btBlock.includes('Tenant Agree') && pass1.btBlock.includes('low induction result matches low real recycling') && pass1.btBlock.includes('30%') && pass1.btBlock.includes('40%'),
    pass1.btBlock.slice(0, 800));
  check('reports the disagreeing tenant+stream correctly (induction low, real high, large gap)',
    pass1.btBlock.includes('Tenant Disagree') && pass1.btBlock.includes('real recycling is notably better than the induction result suggests') && pass1.btBlock.includes('30%') && pass1.btBlock.includes('100%'),
    pass1.btBlock.slice(0, 800));
  check('current-state sub-block includes the count-not-weight honesty note',
    pass1.btBlock.includes('collection count') && pass1.btBlock.includes('not weight'), pass1.btBlock.slice(0, 400));
  check('current-state sub-block includes the representativeness + snapshot honesty notes',
    pass1.btBlock.includes('reflect only the people who completed the induction') && pass1.btBlock.includes('snapshot of current data'),
    pass1.btBlock.slice(0, 600));
  check('the below-real-rows-floor tenant (only 4 internal Bintracker rows, needs >=5) produces no finding at all',
    !pass1.btBlock.includes('Tenant BelowFloor'), pass1.btBlock.slice(0, 800));
  check('the exactly-at-floor tenant (3 submissions, 5 real rows) still produces a finding',
    pass1.btBlock.includes('Tenant AtFloor'), pass1.btBlock.slice(0, 300));
  // Note: the whole building-block's text legitimately contains "General Waste"/"E-Waste" from its
  // own "Accuracy by stream" chart (always lists all 5 streams) - the tenant name is the only
  // reliable, Bintracker-finding-specific signal to check for absence here.
  check('General Waste / E-Waste never produce a finding, even with abundant seeded data for those streams',
    !pass1.btBlock.includes('Tenant GwEw'),
    pass1.btBlock.slice(0, 300));
  check('external-only Organics rows (no internal data for that tenant) produce no Organics finding',
    !pass1.btBlock.includes('Tenant ExternalOnlyOrganics'), pass1.btBlock.slice(0, 300));
  check('induction-impact sub-block reports the improved tenant (large gap, at exactly the 5/5 floor)',
    pass1.btBlock.includes('Tenant ImpactImproved') && pass1.btBlock.includes('real recycling improved significantly after the induction') && pass1.btBlock.includes('40%') && pass1.btBlock.includes('80%'),
    pass1.btBlock.slice(0, 900));
  check('induction-impact sub-block reports the declined tenant, with its recommendation',
    pass1.btBlock.includes('Tenant ImpactDeclined') && pass1.btBlock.includes('real recycling dropped after the induction') && pass1.btBlock.includes('80%') && pass1.btBlock.includes('50%') && pass1.btBlock.includes("Worth checking whether something changed in this tenant's space"),
    pass1.btBlock.slice(0, 900));

  check('Collins Tower (no bintrackerBuildingName set) shows no Real-world data sub-block at all - graceful absence',
    !pass1.collinsBlock.includes('Real-world data'), pass1.collinsBlock.slice(0, 400));

  // --- The two checkboxes are independent: uncheck one at a time, then both ---
  const editBtnCb1 = await page.waitForSelector('#editSelectionBtn', { visible: true, timeout: 5000 });
  await editBtnCb1.evaluate(el => el.scrollIntoView());
  await editBtnCb1.click();
  await page.waitForFunction(() => document.getElementById('configSection').style.display !== 'none', { timeout: 5000 });
  await page.evaluate(() => { document.getElementById('includeBintrackerImpactCheck').checked = false; });
  const pass2 = await generateAndGetBlocks();
  check('unchecking only "induction impact" keeps current-state visible',
    pass2.btBlock.includes('Real-world data: current state'), pass2.btBlock.slice(0, 200));
  check('unchecking only "induction impact" hides the induction-impact sub-block',
    !pass2.btBlock.includes('Real-world data: induction impact') && !pass2.btBlock.includes('Tenant ImpactImproved'),
    pass2.btBlock.slice(0, 200));

  const editBtnCb2 = await page.waitForSelector('#editSelectionBtn', { visible: true, timeout: 5000 });
  await editBtnCb2.evaluate(el => el.scrollIntoView());
  await editBtnCb2.click();
  await page.waitForFunction(() => document.getElementById('configSection').style.display !== 'none', { timeout: 5000 });
  await page.evaluate(() => {
    document.getElementById('includeBintrackerImpactCheck').checked = true;
    document.getElementById('includeBintrackerCurrentCheck').checked = false;
  });
  const pass3 = await generateAndGetBlocks();
  check('unchecking only "current state" hides it but keeps induction-impact visible',
    !pass3.btBlock.includes('Real-world data: current state') && !pass3.btBlock.includes('Tenant Agree') && pass3.btBlock.includes('Real-world data: induction impact'),
    pass3.btBlock.slice(0, 200));

  const editBtnCb3 = await page.waitForSelector('#editSelectionBtn', { visible: true, timeout: 5000 });
  await editBtnCb3.evaluate(el => el.scrollIntoView());
  await editBtnCb3.click();
  await page.waitForFunction(() => document.getElementById('configSection').style.display !== 'none', { timeout: 5000 });
  await page.evaluate(() => { document.getElementById('includeBintrackerImpactCheck').checked = false; });
  const pass4 = await generateAndGetBlocks();
  check('unchecking BOTH checkboxes shows neither Real-world data sub-block',
    !pass4.btBlock.includes('Real-world data'), pass4.btBlock.slice(0, 200));

  // --- Empty-state: a narrow date range with nothing in it ---
  const editBtn2 = await page.waitForSelector('#editSelectionBtn', { visible: true, timeout: 5000 });
  await editBtn2.evaluate(el => el.scrollIntoView());
  await editBtn2.click();
  await page.waitForFunction(() => document.getElementById('configSection').style.display !== 'none', { timeout: 5000 });
  await page.evaluate(() => {
    document.getElementById('dateFrom').value = '2020-01-01';
    document.getElementById('dateTo').value = '2020-01-02';
  });
  const genBtn3 = await page.waitForSelector('#generateBtn', { visible: true, timeout: 5000 });
  await genBtn3.evaluate(el => el.scrollIntoView());
  await genBtn3.click();
  await page.waitForFunction(() => getComputedStyle(document.getElementById('reportDoc')).display !== 'none', { timeout: 10000 });
  const emptyVisible = await page.$eval('#reportEmptyNote', el => getComputedStyle(el).display !== 'none');
  check('empty date range shows the empty-state note', emptyVisible);
}

main().catch(e => { console.error(e); process.exit(1); });
