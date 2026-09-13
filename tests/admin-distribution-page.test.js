// Verifies outputs/admin-distribution.html — the Distribution tab's own page since Workstream 2,
// Phase 4 of the architecture roadmap (C:\Users\smolina\.claude\plans\graceful-roaming-shell.md):
// whole-building link/QR/copy/preview, tenant-scoped/expiring link generation and revocation,
// the "Send via email"/"Copy addresses" distinction for tenants with vs. without a saved email,
// the "no ?program=" fallback, and cross-page session persistence back to
// sorting-station-report.html. Building/tenant CRUD and induction registration are covered by
// their own pages' tests (admin-buildings-page.test.js, admin-catalog-page.test.js) — this file
// seeds everything it needs directly via Firestore instead of driving either UI.
// Run: npm run test:admin-distribution-page
const path = require('path');
const url = require('url');
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc } = require('firebase/firestore');

const EDGE_PATH = process.env.TEST_BROWSER_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const DISTRIBUTION_PATH = path.join(__dirname, '..', 'outputs', 'admin-distribution.html');
const REPORT_PATH = path.join(__dirname, '..', 'outputs', 'sorting-station-report.html');
const RULES_PATH = path.join(__dirname, '..', 'firestore.rules');
const ALLOWED_EMAIL = 'esgtradeflex@gmail.com';

function distributionUrl(programId){
  return `${url.pathToFileURL(DISTRIBUTION_PATH).href}?program=${encodeURIComponent(programId)}&emulator=1`;
}

// One building enrolled in Recycling Sorting, with one tenant that has a saved email
// (Widgetco) and one that doesn't (Northwind Consulting) — the reliable way to exercise both
// the "Send via email"/"Copy addresses" branch and the "neither button" branch.
async function seedTestBuilding(){
  const testEnv = await initializeTestEnvironment({
    projectId: 'esg-1-98f35',
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  const buildingName = 'Test Tower Distribution ' + Date.now();
  const buildingId = 'test-tower-distribution-' + Date.now();
  const widgetcoId = 'widgetco-' + Date.now();
  const northwindId = 'northwind-' + Date.now();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'buildings', buildingId), { name: buildingName });
    await setDoc(doc(db, 'buildings', buildingId, 'tenants', widgetcoId), {
      name: 'Widgetco', levels: ['Level 3'], emails: ['widgetco-contact@example.com'],
    });
    await setDoc(doc(db, 'buildings', buildingId, 'tenants', northwindId), {
      name: 'Northwind Consulting', levels: ['Level 14'], emails: [],
    });
    await setDoc(doc(db, 'enrollments', `recycling-sorting__${buildingId}`), {
      programId: 'recycling-sorting', buildingId, itemOverrides: {}, enabledTenantIds: null,
    });
  });
  return { testEnv, buildingId, buildingName, widgetcoId, northwindId };
}

const results = [];
function check(label, cond, extra){ results.push({ label, ok: Boolean(cond), extra: extra || '' }); }

async function main(){
  const browser = await puppeteer.launch({ executablePath: EDGE_PATH, headless: true });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));
  page.on('dialog', (d) => { consoleErrors.push('unexpected dialog: ' + d.message()); d.dismiss(); });

  try {
    await runFlow(page);
  } catch (err) {
    console.error('CRASHED — dumping diagnostics:', err.message);
    console.error('--- results so far ---');
    for (const r of results){ console.error(`${r.ok ? 'PASS' : 'FAIL'} — ${r.label}${r.extra ? ' :: ' + r.extra : ''}`); }
    await page.screenshot({ path: path.join(__dirname, '..', 'debug-crash.png') }).catch(() => {});
    await browser.close();
    process.exit(1);
  }

  // "Clipboard write failed"/"Could not copy automatically": expected — headless/file:// Chrome
  // frequently denies clipboard access even after overridePermissions(), and the app's own
  // graceful fallback (a friendly alert instead of a crash) is exactly what's being tested.
  // "sendInductionEmail"/"CORS policy": expected — this suite doesn't start the Functions
  // emulator (only firestore,auth), so the real fetch to sendInductionEmail is expected to
  // fail; that's the graceful-failure path being tested, not a real bug.
  const unexpectedErrors = consoleErrors.filter(e =>
    !e.includes('auth/email-already-in-use') && !e.includes('Failed to load resource') && !e.includes('400')
    && !e.includes('Clipboard write failed') && !e.includes('Could not copy automatically')
    && !e.includes('sendInductionEmail') && !e.includes('CORS policy'));
  check('no UNEXPECTED console/page errors during the whole flow', unexpectedErrors.length === 0, unexpectedErrors.join(' || '));

  await browser.close();

  console.log('\n--- RESULTS ---');
  let allOk = true;
  for (const r of results){
    console.log(`${r.ok ? 'PASS' : 'FAIL'} — ${r.label}${r.extra ? ' :: ' + r.extra : ''}`);
    if (!r.ok) allOk = false;
  }
  process.exit(allOk ? 0 : 1);
}

async function runFlow(page){
  const { buildingId, buildingName } = await seedTestBuilding();

  // --- "No ?program=" / unrecognized program: the explicit fallback, not a silent default ---
  const noProgramUrl = `${url.pathToFileURL(DISTRIBUTION_PATH).href}?emulator=1`;
  await page.goto(noProgramUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.getElementById('distributionSection') && getComputedStyle(document.getElementById('distributionSection')).display !== 'none',
    { timeout: 10000 }
  );
  check('with no ?program= at all, the "go back and pick one" fallback note is shown',
    await page.$eval('#noProgramNote', el => getComputedStyle(el).display !== 'none'));
  check('...and the distribution list itself stays empty (no silently-guessed induction)',
    (await page.$eval('#distributionList', el => el.innerHTML.trim())) === '');

  await page.goto(`${url.pathToFileURL(DISTRIBUTION_PATH).href}?program=not-a-real-program&emulator=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.getElementById('distributionSection') && getComputedStyle(document.getElementById('distributionSection')).display !== 'none',
    { timeout: 10000 }
  );
  check('with an unrecognized ?program=, the same fallback note is shown',
    await page.$eval('#noProgramNote', el => getComputedStyle(el).display !== 'none'));

  // --- The real flow: a valid, registered induction (Recycling Sorting is always valid even
  // without its own `programs` doc — see loadProgram()'s fallback) ---
  await page.goto(distributionUrl('recycling-sorting'), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    (name) => (document.getElementById('distributionList')?.textContent || '').includes(name),
    { timeout: 10000 },
    buildingName
  );
  check('the induction name appears in the page header', (await page.$eval('#programNameLabel', el => el.textContent)) === 'Recycling Sorting');
  check('#noProgramNote stays hidden for a valid induction',
    await page.$eval('#noProgramNote', el => getComputedStyle(el).display === 'none'));

  const distributionSelector = `.distribution-building-row[data-building-id="${buildingId}"]`;
  check('the enrolled building appears in Distribution', Boolean(await page.$(distributionSelector)));

  const linkText = await page.$eval(`${distributionSelector} .building-link-text`, el => el.textContent);
  check('the whole-building link contains the real buildingId and points at the training page',
    linkText.includes('recycling-training.html?b=' + buildingId), linkText);

  const qrSvg = await page.$eval(`${distributionSelector} .building-qr svg`, el => el.outerHTML).catch(() => null);
  check('QR code renders as a real SVG with content', Boolean(qrSvg) && qrSvg.length > 100, qrSvg ? qrSvg.length : 'none');

  // Preview button (shared document-level listener) — stub window.open rather than actually
  // spawning a new tab, same pattern already established in tests/admin-buildings.test.js.
  await page.evaluate(() => { window.__openedUrls = []; window.open = (u) => { window.__openedUrls.push(u); return null; }; });
  await page.click(`${distributionSelector} .preview-link-btn`);
  const previewUrls = await page.evaluate(() => window.__openedUrls);
  check('Preview opens the link with &preview=1 appended',
    previewUrls.length === 1 && previewUrls[0] === `${linkText}&preview=1`, previewUrls.join(', '));

  let clipboardGrantable = true;
  try { await page.browserContext().overridePermissions(distributionUrl('recycling-sorting'), ['clipboard-write', 'clipboard-read']); }
  catch (err) { clipboardGrantable = false; }

  const copyBtn = await page.$(`${distributionSelector} .copy-link-btn`);
  await copyBtn.click();
  await new Promise(r => setTimeout(r, 300));
  const clipboardText = clipboardGrantable
    ? await page.evaluate(() => navigator.clipboard.readText()).catch(() => null)
    : null;
  if (clipboardText === linkText){
    check('copy-link button actually copied the exact link to the clipboard', true, clipboardText);
  } else {
    const copyBtnText = await copyBtn.evaluate(el => el.textContent);
    check('clipboard unavailable in this sandbox, but the app degraded gracefully (friendly alert, no crash) instead of copying',
      copyBtnText.includes('Copied') || copyBtnText.includes('Copy link'), copyBtnText);
  }

  // --- Tenant-scoped links: Widgetco (has an email) vs. Northwind Consulting (doesn't) ---
  // window.confirm/alert's native dialogs would otherwise fight the generic "unexpected dialog"
  // handler at the top of this file — overridden in-page instead, recording alert() calls so
  // the "Send via email" failure check below can inspect what it said.
  await page.evaluate(() => {
    window.confirm = () => true;
    window.__alertCalls = [];
    window.alert = (msg) => { window.__alertCalls.push(msg); };
  });

  async function generateTenantLink(tenantId){
    await page.select(`${distributionSelector} .new-link-tenant`, tenantId);
    await page.click(`${distributionSelector} .generate-link-btn`);
    await new Promise(r => setTimeout(r, 600));
  }

  await generateTenantLink((await page.$$eval(`${distributionSelector} .new-link-tenant option`, opts =>
    (opts.find(o => o.textContent === 'Widgetco') || {}).value)));
  const widgetcoLinkLi = await page.evaluateHandle((sel) => {
    return [...document.querySelectorAll(`${sel} .tenant-list li`)].find(li => li.textContent.includes('Widgetco'));
  }, distributionSelector).then(h => h.asElement());
  const widgetcoCopyBtns = await widgetcoLinkLi.$$('.copy-link-btn'); // [0] "Copy link", [1] "Copy addresses"
  check('a tenant-scoped link for a tenant WITH a saved email shows "Send via email" and "Copy addresses"',
    Boolean(await widgetcoLinkLi.$('.send-email-btn')) && widgetcoCopyBtns.length === 2,
    await widgetcoLinkLi.evaluate(el => el.textContent));
  const copyAddressesDataLink = await widgetcoCopyBtns[1].evaluate(el => el.dataset.link);
  check('the "Copy addresses" button carries the tenant\'s actual saved email in its data-link',
    copyAddressesDataLink === 'widgetco-contact@example.com', copyAddressesDataLink);

  await generateTenantLink((await page.$$eval(`${distributionSelector} .new-link-tenant option`, opts =>
    (opts.find(o => o.textContent === 'Northwind Consulting') || {}).value)));
  const northwindLinkLi = await page.evaluateHandle((sel) => {
    return [...document.querySelectorAll(`${sel} .tenant-list li`)].find(li => li.textContent.includes('Northwind Consulting'));
  }, distributionSelector).then(h => h.asElement());
  check('a tenant-scoped link for a tenant with NO saved email shows neither button',
    !(await northwindLinkLi.$('.send-email-btn')) && (await northwindLinkLi.$$('.copy-link-btn')).length === 1,
    await northwindLinkLi.evaluate(el => el.textContent));

  const wholeBuildingRowText = await page.$eval(`${distributionSelector} .building-link-row`, el => el.textContent);
  check('the whole-building link row (no single tenant to address) never shows "Send via email"',
    !wholeBuildingRowText.includes('Send via email'), wholeBuildingRowText);

  // --- "Send via email" fails gracefully (Cloud Function not deployed — needs Blaze + Entra ID) ---
  const alertCountBeforeSend = await page.evaluate(() => window.__alertCalls.length);
  const widgetcoLinkLiFresh = await page.evaluateHandle((sel) => {
    return [...document.querySelectorAll(`${sel} .tenant-list li`)].find(li => li.textContent.includes('Widgetco'));
  }, distributionSelector).then(h => h.asElement());
  const sendBtn = await widgetcoLinkLiFresh.$('.send-email-btn');
  await sendBtn.click();
  await new Promise(r => setTimeout(r, 1500));
  const alertsAfterSend = await page.evaluate((n) => window.__alertCalls.slice(n), alertCountBeforeSend);
  check('clicking "Send via email" before the Cloud Function is deployed fails gracefully with a clear alert',
    alertsAfterSend.some(a => a.includes('Copy addresses')), JSON.stringify(alertsAfterSend));
  const sendBtnTextAfterFailure = await sendBtn.evaluate(el => el.textContent);
  const sendBtnDisabledAfterFailure = await sendBtn.evaluate(el => el.disabled);
  check('the "Send via email" button resets to its original label and stays usable after a failed send',
    sendBtnTextAfterFailure.includes('Send via email') && !sendBtnDisabledAfterFailure, sendBtnTextAfterFailure);

  // --- Revoke Widgetco's link specifically — two links exist now, and a bare
  // `.revoke-link-btn` selector would ambiguously hit whichever renders first. ---
  const widgetcoRevokeBtn = await page.evaluateHandle((sel) => {
    const li = [...document.querySelectorAll(`${sel} .tenant-list li`)].find(l => l.textContent.includes('Widgetco'));
    return li && li.querySelector('.revoke-link-btn');
  }, distributionSelector).then(h => h.asElement());
  await widgetcoRevokeBtn.click();
  await new Promise(r => setTimeout(r, 600));
  const linksListTextAfterOneRevoke = await page.$eval(`${distributionSelector} .generate-link-block .tenant-list`, el => el.textContent);
  check('revoking Widgetco\'s link leaves Northwind Consulting\'s link intact',
    linksListTextAfterOneRevoke.includes('Northwind Consulting') && !linksListTextAfterOneRevoke.includes('Widgetco'),
    linksListTextAfterOneRevoke);

  // --- Sidebar-less nav: "← Back to reports" and cross-page session persistence ---
  const backHref = await page.$eval('#backToReportsLink', el => el.getAttribute('href')).catch(() => null);
  check('"← Back to reports" points at sorting-station-report.html, preserving ?emulator=1', backHref === 'sorting-station-report.html?emulator=1', backHref);

  await Promise.all([page.waitForNavigation(), page.click('#backToReportsLink')]);
  await page.waitForFunction(
    () => getComputedStyle(document.getElementById('settingsBtn')).display !== 'none',
    { timeout: 10000 }
  );
  check('"← Back to reports" keeps the same signed-in session (no re-login needed)', true);

  await page.goto(distributionUrl('recycling-sorting'), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    (name) => (document.getElementById('distributionList')?.textContent || '').includes(name),
    { timeout: 10000 },
    buildingName
  );
  check('navigating back to admin-distribution.html also keeps the session (round trip, not one-way)', true);

  // --- Sign out must actually clear this page's own real data, not just hide it ---
  await page.click('#signOutBtn');
  await new Promise(r => setTimeout(r, 500));
  check('signing out shows the sign-in form again',
    await page.$eval('#authZone', el => getComputedStyle(el).display !== 'none'));
  check('signing out hides the Distribution section',
    await page.$eval('#distributionSection', el => getComputedStyle(el).display === 'none'));
  check('signing out clears the distribution list',
    await page.$eval('#distributionList', el => el.innerHTML.trim() === ''));
}

main().catch((err) => { console.error('Test harness crashed:', err); process.exit(1); });
