// Verifies outputs/admin-distribution.html — the Distribution tab's own page since Workstream 2,
// Phase 4 of the architecture roadmap (C:\Users\smolina\.claude\plans\graceful-roaming-shell.md):
// whole-building link/QR/copy/preview, tenant-scoped/expiring link generation and revocation,
// the "Send via email" distinction for tenants with vs. without a saved email, bulk "Send to all
// tenants" distribution, the "no ?program=" fallback, and cross-page session persistence back to
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
// the "Send via email" branch and the "neither button" branch.
async function seedTestBuilding(){
  const testEnv = await initializeTestEnvironment({
    projectId: 'esg-1-98f35',
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  const buildingName = 'Test Tower Distribution ' + Date.now();
  const buildingId = 'test-tower-distribution-' + Date.now();
  const widgetcoId = 'widgetco-' + Date.now();
  const northwindId = 'northwind-' + Date.now();
  // A second, otherwise-identical building with NO saved managerEmails - the reliable way to
  // exercise the "Email flyer" button's presence/absence (Workstream 13).
  const noManagerBuildingName = 'Test Tower No Managers ' + Date.now();
  const noManagerBuildingId = 'test-tower-no-managers-' + Date.now();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'buildings', buildingId), { name: buildingName, managerEmails: ['manager1@example.com', 'manager2@example.com'] });
    await setDoc(doc(db, 'buildings', buildingId, 'tenants', widgetcoId), {
      name: 'Widgetco', levels: ['Level 3'], emails: ['widgetco-contact@example.com'],
    });
    await setDoc(doc(db, 'buildings', buildingId, 'tenants', northwindId), {
      name: 'Northwind Consulting', levels: ['Level 14'], emails: [],
    });
    await setDoc(doc(db, 'enrollments', `recycling-sorting__${buildingId}`), {
      programId: 'recycling-sorting', buildingId, itemOverrides: {}, enabledTenantIds: null,
    });
    await setDoc(doc(db, 'buildings', noManagerBuildingId), { name: noManagerBuildingName });
    // Two tenants here, isolated from the main building's Widgetco/Northwind flow (used
    // elsewhere in this test for individual link-generation/revoke assertions), so the "Send to
    // all tenants" bulk-distribution test (follow-up fix #8) can run its own clean two-run
    // scenario without interfering with those.
    await setDoc(doc(db, 'buildings', noManagerBuildingId, 'tenants', 'acme-' + Date.now()), {
      name: 'Acme Co', levels: ['Level 5'], emails: ['acme-contact@example.com'],
    });
    await setDoc(doc(db, 'buildings', noManagerBuildingId, 'tenants', 'beta-' + Date.now()), {
      name: 'Beta Corp', levels: ['Level 6'], emails: [],
    });
    await setDoc(doc(db, 'enrollments', `recycling-sorting__${noManagerBuildingId}`), {
      programId: 'recycling-sorting', buildingId: noManagerBuildingId, itemOverrides: {}, enabledTenantIds: null,
    });
  });
  return { testEnv, buildingId, buildingName, widgetcoId, northwindId, noManagerBuildingId, noManagerBuildingName };
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
    && !e.includes('sendInductionEmail') && !e.includes('sendDistributionFlyer') && !e.includes('CORS policy'));
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
  const { buildingId, buildingName, noManagerBuildingId, noManagerBuildingName } = await seedTestBuilding();

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

  // --- Embedded mode (Workstream 3, Item A): opened with &embedded=1, as sorting-station-report.html's
  // #adminIframe does, this page must suppress its own header/back-link/sign-out (the shell
  // already shows those) — locks in that contract independent of the iframe wiring itself,
  // which tests/admin-buildings.test.js/admin-catalog.test.js cover from the shell's side. ---
  await page.goto(`${distributionUrl('recycling-sorting')}&embedded=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    (name) => (document.getElementById('distributionList')?.textContent || '').includes(name),
    { timeout: 10000 },
    buildingName
  );
  check('embedded mode (&embedded=1) hides this page\'s own header',
    await page.$eval('header.top', el => getComputedStyle(el).display === 'none'));
  check('embedded mode (&embedded=1) hides this page\'s own back-link/sign-out corner',
    await page.$eval('#cornerSettings', el => getComputedStyle(el).display === 'none'));
  check('embedded mode still shows the sign-in zone if not yet signed in, or the real content once signed in (not hidden outright)',
    await page.$eval('#distributionSection', el => getComputedStyle(el).display !== 'none'));
  // Back to the plain (non-embedded) URL for the rest of this test — standalone behavior is
  // the default and every check below this point assumes it.
  await page.goto(distributionUrl('recycling-sorting'), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    (name) => (document.getElementById('distributionList')?.textContent || '').includes(name),
    { timeout: 10000 },
    buildingName
  );

  // Workstream 11 replaced window.alert()/window.confirm() with a real in-page modal
  // (#appModalOverlay) — there's no native dialog to stub anymore. Instead, auto-respond to the
  // custom modal the same way the old stub did (always "confirm"/"OK"), recording each message
  // into __confirmCalls/__alertCalls so checks further down (e.g. the "Send via email" failure
  // check) can inspect what it said. Installed here, before the FIRST click that can trigger the
  // modal (copy-link-btn's clipboard-unavailable fallback, below) — an alert left unanswered
  // leaves the overlay open and blocks every subsequent click in this flow.
  // window.__cancelNextConfirm (set right before a click that should be answered "Cancel" instead
  // of the usual "always confirm" default, e.g. the "Send to all tenants"/"Email flyer" Cancel
  // checks below) is respected HERE, in this single observer, rather than via a second competing
  // observer on the same element - two independent observers racing to click different buttons on
  // the same mutation event is exactly the kind of flake that produced a real, confirmed test
  // failure the first time this was tried with a second observer.
  await page.evaluate(() => {
    window.__confirmCalls = [];
    window.__alertCalls = [];
    window.__cancelNextConfirm = false;
    const overlay = document.getElementById('appModalOverlay');
    new MutationObserver(() => {
      if (!overlay.classList.contains('open')) return;
      const message = document.getElementById('appModalMessage').textContent;
      const buttons = [...document.getElementById('appModalActions').querySelectorAll('button')];
      if (buttons.length === 1) { window.__alertCalls.push(message); buttons[0].click(); return; }
      window.__confirmCalls.push(message);
      if (window.__cancelNextConfirm) { window.__cancelNextConfirm = false; buttons[0].click(); }
      else { buttons[buttons.length - 1].click(); }
    }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
  });

  const distributionSelector = `.distribution-building-row[data-building-id="${buildingId}"]`;
  check('the enrolled building appears in Distribution', Boolean(await page.$(distributionSelector)));

  // Each building row is collapsed by default (accordion, same pattern as Enrolled Buildings) —
  // the QR code, the plain link text, the expiry editor, the action row, and the tenant-scoped
  // link generator only render once expanded. The header row itself (Workstream 13 redesign) now
  // carries no action buttons at all — just the name and the expand toggle.
  check('the (collapsed) header row has no action buttons of its own (Workstream 13 redesign)',
    (await page.$$(`${distributionSelector} .building-header-row button`)).length === 1); // just the toggle
  await page.click(`${distributionSelector} .building-toggle-btn`);
  await page.waitForSelector(`${distributionSelector} .building-link-text`);

  check('the expanded row shows a "Whole-building link" section (Workstream 13 redesign)',
    (await page.$eval(`${distributionSelector} .whole-building-link-block .generate-link-title`, el => el.textContent)).includes('Whole-building link'));
  check('the expanded row shows a "Generate tenant link" section (renamed from "Generate a distribution link")',
    (await page.$eval(`${distributionSelector} .generate-link-block .generate-link-title`, el => el.textContent)).includes('Generate tenant link'));

  const linkText = await page.$eval(`${distributionSelector} .building-link-text`, el => el.textContent);
  check('the whole-building link contains the real buildingId and points at the training page',
    linkText.includes('recycling-training.html?b=' + buildingId), linkText);

  // The QR code is now a SIBLING of the link text inside .building-link-row (Workstream 13
  // structural fix), not a separate element stacked below it.
  const qrIsInsideLinkRow = await page.$eval(`${distributionSelector} .building-link-row .building-qr svg`, el => Boolean(el)).catch(() => false);
  check('the QR code renders INSIDE .building-link-row, beside the link text, not below it', qrIsInsideLinkRow);
  const qrSvg = await page.$eval(`${distributionSelector} .building-qr svg`, el => el.outerHTML).catch(() => null);
  check('QR code renders as a real SVG with content', Boolean(qrSvg) && qrSvg.length > 100, qrSvg ? qrSvg.length : 'none');

  // Print flyer button (physical building signage) — stub window.print rather than actually
  // triggering the native print dialog headlessly, same pattern as the Preview button's
  // window.open stub above.
  await page.evaluate(() => { window.__printCalled = false; window.print = () => { window.__printCalled = true; }; });
  await page.click(`${distributionSelector} .print-flyer-btn`);
  const flyerState = await page.evaluate(() => ({
    printCalled: window.__printCalled,
    kickerText: document.getElementById('flyerKickerText').textContent,
    footerText: document.getElementById('flyerFooterText').textContent,
    qrSvg: document.querySelector('#flyerQrContainer svg')?.outerHTML || null,
    pageStyleContent: document.getElementById('flyerPageSizeOverride')?.textContent || null,
  }));
  check('Print flyer calls window.print()', flyerState.printCalled === true);
  check('Print flyer shows the building name + programme kicker',
    flyerState.kickerText === `${buildingName} · Waste Management Program`, flyerState.kickerText);
  check('Print flyer shows the real building name in its footer',
    flyerState.footerText === buildingName, flyerState.footerText);
  check('Print flyer renders its own QR code as a real SVG with content',
    Boolean(flyerState.qrSvg) && flyerState.qrSvg.length > 100, flyerState.qrSvg ? flyerState.qrSvg.length : 'none');
  check('Print flyer injects its own A4 @page size override',
    Boolean(flyerState.pageStyleContent) && flyerState.pageStyleContent.includes('size: A4'), flyerState.pageStyleContent);

  // The injected @page override must clean itself up after printing, so it never leaks into
  // whatever print job runs next (this file's own separate whole-screen print feature included).
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await new Promise(r => setTimeout(r, 100));
  const pageStyleAfterPrint = await page.evaluate(() => document.getElementById('flyerPageSizeOverride'));
  check('The A4 @page override is removed again after printing', pageStyleAfterPrint === null);

  // --- Whole-building link expiry: view/edit-in-place with a real date picker (Workstream 13,
  // follow-up fix #2 - the view-state text is now a plain <span class="expiry-status-text">
  // living inside the shared .print-row action row, not a standalone wrapping <p>) ---
  check('the whole-building link shows "Expires: Never" by default (no expiresAt saved yet)',
    (await page.$eval(`${distributionSelector} .expiry-status-text`, el => el.textContent)).includes('Expires: Never'));
  check('the expiry field is a real <input type=date>, not the old Never/1/7/30-day preset dropdown',
    (await page.$eval(`${distributionSelector} .generate-link-block .new-link-expiry`, el => el.tagName + ':' + el.type)) === 'INPUT:date');

  await page.click(`${distributionSelector} .change-expiry-btn`);
  await page.waitForSelector(`${distributionSelector} .whole-building-expiry-input`);
  const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await page.evaluate((sel, val) => { document.querySelector(sel).value = val; },
    `${distributionSelector} .whole-building-expiry-input`, futureDate);
  await page.click(`${distributionSelector} .save-expiry-btn`);
  await page.waitForSelector(`${distributionSelector} .expiry-status-text`);
  const expiryTextAfterSave = await page.$eval(`${distributionSelector} .expiry-status-text`, el => el.textContent);
  check('saving a future expiry date shows it back (view state, not "Never")',
    !expiryTextAfterSave.includes('Never') && expiryTextAfterSave.includes('Expires:'), expiryTextAfterSave);

  // Cancel must discard an in-progress edit without touching the saved value.
  await page.click(`${distributionSelector} .change-expiry-btn`);
  await page.waitForSelector(`${distributionSelector} .whole-building-expiry-input`);
  await page.evaluate((sel) => { document.querySelector(sel).value = ''; }, `${distributionSelector} .whole-building-expiry-input`);
  await page.click(`${distributionSelector} .cancel-expiry-btn`);
  await page.waitForSelector(`${distributionSelector} .expiry-status-text`);
  const expiryTextAfterCancel = await page.$eval(`${distributionSelector} .expiry-status-text`, el => el.textContent);
  check('Cancel discards the in-progress edit — the previously saved expiry is still shown',
    !expiryTextAfterCancel.includes('Never'), expiryTextAfterCancel);

  // Clearing the date and saving removes the expiry again (back to "Never").
  await page.click(`${distributionSelector} .change-expiry-btn`);
  await page.waitForSelector(`${distributionSelector} .whole-building-expiry-input`);
  await page.evaluate((sel) => { document.querySelector(sel).value = ''; }, `${distributionSelector} .whole-building-expiry-input`);
  await page.click(`${distributionSelector} .save-expiry-btn`);
  await page.waitForSelector(`${distributionSelector} .expiry-status-text`);
  check('saving an empty date clears the expiry back to "Never"',
    (await page.$eval(`${distributionSelector} .expiry-status-text`, el => el.textContent)).includes('Expires: Never'));

  // --- "Email flyer" (Workstream 13, Part 2) - "Show addresses" is gone (follow-up fix #2);
  // the recipient list now shows up in a confirm-before-send dialog instead. ---
  check('a building WITH saved managerEmails shows the "Email flyer" action',
    Boolean(await page.$(`${distributionSelector} .email-flyer-btn`)));

  const noManagerSelector = `.distribution-building-row[data-building-id="${noManagerBuildingId}"]`;
  await page.click(`${noManagerSelector} .building-toggle-btn`);
  await page.waitForSelector(`${noManagerSelector} .building-link-text`);
  check('a building with NO saved managerEmails does not show "Email flyer" at all',
    !(await page.$(`${noManagerSelector} .email-flyer-btn`)));

  // --- "Send to all tenants" bulk-distribution (follow-up fix #8) - run against this second,
  // otherwise-unused building (Acme Co has a saved email, Beta Corp doesn't) so it doesn't
  // interfere with the main building's Widgetco/Northwind individual-link-generation tests below.
  const confirmCountBeforeBulk = await page.evaluate(() => window.__confirmCalls.length);
  await page.click(`${noManagerSelector} .send-all-tenants-btn`);
  await new Promise(r => setTimeout(r, 300));
  const bulkConfirmMessages = await page.evaluate((n) => window.__confirmCalls.slice(n), confirmCountBeforeBulk);
  check('the bulk-send confirmation names who will be sent to and who will only get a link generated',
    bulkConfirmMessages.some((m) => m.includes('Acme Co') && m.includes('send it now'))
    && bulkConfirmMessages.some((m) => m.includes('Beta Corp') && m.includes('NOT send it')),
    JSON.stringify(bulkConfirmMessages));
  // Both tenants had no existing link, so both should now show up in "Generate tenant link"'s
  // own list — no separate list/UI needed, per the user's own explicit requirement. Generous
  // wait: this involves 2 sequential Firestore writes plus one (failing, since this suite
  // doesn't start the Functions emulator) sendInductionEmail network attempt before the final
  // refreshDistributionView() call resolves.
  await new Promise(r => setTimeout(r, 2500));
  const bulkLinksListText = await page.$eval(`${noManagerSelector} .generate-link-block .tenant-list`, el => el.textContent);
  check('after "Send to all tenants", both tenants now appear in the tenant-scoped links list',
    bulkLinksListText.includes('Acme Co') && bulkLinksListText.includes('Beta Corp'), bulkLinksListText);
  const acmeLinkLi = await page.evaluateHandle((sel) => {
    return [...document.querySelectorAll(`${sel} .tenant-list li`)].find(li => li.textContent.includes('Acme Co'));
  }, noManagerSelector).then(h => h.asElement());
  check('the tenant WITH a saved email (Acme Co) shows "Send via email" in the generated list',
    Boolean(await acmeLinkLi.$('.send-email-btn')));
  const betaLinkLi = await page.evaluateHandle((sel) => {
    return [...document.querySelectorAll(`${sel} .tenant-list li`)].find(li => li.textContent.includes('Beta Corp'));
  }, noManagerSelector).then(h => h.asElement());
  check('the tenant with NO saved email (Beta Corp) shows no "Send via email" in the generated list',
    !(await betaLinkLi.$('.send-email-btn')));

  // Running it again immediately after must skip both (they now each have a valid link) and
  // short-circuit with a plain "nothing to do" alert - no confirm dialog, no new links written.
  const alertCountBeforeSecondBulk = await page.evaluate(() => window.__alertCalls.length);
  const confirmCountBeforeSecondBulk = await page.evaluate(() => window.__confirmCalls.length);
  await page.click(`${noManagerSelector} .send-all-tenants-btn`);
  await new Promise(r => setTimeout(r, 300));
  const alertsAfterSecondBulk = await page.evaluate((n) => window.__alertCalls.slice(n), alertCountBeforeSecondBulk);
  const confirmsAfterSecondBulk = await page.evaluate((n) => window.__confirmCalls.slice(n), confirmCountBeforeSecondBulk);
  check('running "Send to all tenants" again (everyone already covered) shows a plain "nothing to do" alert, no confirm dialog',
    alertsAfterSecondBulk.some((a) => a.includes('already has a valid link')) && confirmsAfterSecondBulk.length === 0,
    JSON.stringify({ alertsAfterSecondBulk, confirmsAfterSecondBulk }));

  // Clicking Cancel on the confirm dialog must write/send nothing at all.
  const emailFlyerBtn = await page.$(`${distributionSelector} .email-flyer-btn`);
  const confirmCountBeforeCancel = await page.evaluate(() => window.__confirmCalls.length);
  await page.evaluate(() => { window.__cancelNextConfirm = true; });
  await emailFlyerBtn.click();
  await new Promise(r => setTimeout(r, 300));
  const confirmMessagesForCancelCheck = await page.evaluate((n) => window.__confirmCalls.slice(n), confirmCountBeforeCancel);
  check('the confirm dialog names the real recipient addresses before sending anything',
    confirmMessagesForCancelCheck.some((m) => m.includes('manager1@example.com') && m.includes('manager2@example.com')),
    JSON.stringify(confirmMessagesForCancelCheck));
  check('clicking Cancel on the confirm dialog leaves the button in its normal state (nothing sent)',
    (await emailFlyerBtn.evaluate((el) => el.textContent)) !== 'Sending…');

  // "Email flyer" loading-state behavior (confirming this time, via the shared "always confirm"
  // observer installed earlier) — this suite doesn't start the Functions emulator (only
  // firestore,auth), so the real call to sendDistributionFlyer is expected to fail the same way
  // "Send via email" above does (a network/CORS failure, not a validation bug). The transient
  // "Sending…" state itself isn't checked here (same as "Send via email"'s own test above never
  // checks it either) - in this sandbox, the confirm-then-attempt-then-fail-then-restore cycle can
  // complete in well under 200ms (the connection fails almost instantly with no Functions emulator
  // running), making a fixed-delay check for that specific transient state inherently racy.
  const alertCountBeforeFlyerSend = await page.evaluate(() => window.__alertCalls.length);
  await emailFlyerBtn.click();
  await new Promise(r => setTimeout(r, 1500));
  const alertsAfterFlyerSend = await page.evaluate((n) => window.__alertCalls.slice(n), alertCountBeforeFlyerSend);
  check('clicking "Email flyer" before the Cloud Function is reachable fails gracefully with a clear alert',
    alertsAfterFlyerSend.some(a => a.includes('copy the link above')), JSON.stringify(alertsAfterFlyerSend));
  const emailFlyerTextAfterFailure = await emailFlyerBtn.evaluate(el => el.textContent);
  const emailFlyerDisabledAfterFailure = await emailFlyerBtn.evaluate(el => el.disabled);
  check('the "Email flyer" button resets to its original label and stays usable after a failed send',
    emailFlyerTextAfterFailure.includes('Email flyer') && !emailFlyerDisabledAfterFailure, emailFlyerTextAfterFailure);

  // Preview button (shared document-level listener) — stub window.open rather than actually
  // spawning a new tab, same pattern already established in tests/admin-buildings.test.js.
  await page.evaluate(() => { window.__openedUrls = []; window.open = (u) => { window.__openedUrls.push(u); return null; }; });
  await page.click(`${distributionSelector} .preview-link-btn`);
  const previewUrls = await page.evaluate(() => window.__openedUrls);
  // In emulator mode, the preview window also needs &emulator=1 appended so it talks to the
  // local emulator too (a real, fixed bug found in a code audit — the ephemeral preview window
  // used to silently open against production Firebase during local testing).
  check('Preview opens the link with &preview=1 (and &emulator=1, since this test runs in emulator mode) appended',
    previewUrls.length === 1 && previewUrls[0] === `${linkText}&preview=1&emulator=1`, previewUrls.join(', '));

  // The whole-building link no longer has its own "Copy link" button (Workstream 13 follow-up,
  // 2026-09-29 — the link is already shown as plain selectable text right next to its QR code,
  // so a dedicated copy button was redundant and dropped). The clipboard-copy mechanism itself
  // is still real code shared with "Generate tenant link"'s own per-link Copy link button —
  // exercised below, once a tenant-scoped link actually exists to copy.
  let clipboardGrantable = true;
  try { await page.browserContext().overridePermissions(distributionUrl('recycling-sorting'), ['clipboard-write', 'clipboard-read']); }
  catch (err) { clipboardGrantable = false; }

  // --- The tenant dropdown no longer offers a "Whole building (no tenant lock)" option
  // (Workstream 13 - that capability was removed; the permanent whole-building link above
  // covers it instead) - a tenant lock is now mandatory for every link generated here. ---
  const tenantDropdownOptionTexts = await page.$$eval(`${distributionSelector} .new-link-tenant option`, opts => opts.map(o => o.textContent));
  check('"Generate tenant link" no longer offers a "Whole building (no tenant lock)" option',
    !tenantDropdownOptionTexts.some(t => t.includes('Whole building')), tenantDropdownOptionTexts.join(', '));
  check('...its placeholder option forces an actual tenant choice (disabled, selected by default)',
    await page.$eval(`${distributionSelector} .new-link-tenant option[value=""]`, el => el.disabled && el.selected));
  const generateWithNoTenantResult = await (async () => {
    await page.click(`${distributionSelector} .generate-link-btn`);
    await new Promise(r => setTimeout(r, 300));
    const alerts = await page.evaluate(() => window.__alertCalls.slice(-1));
    return alerts[0] || '';
  })();
  check('clicking "+ Generate link" with no tenant selected is rejected with a clear alert, not a silent no-op',
    generateWithNoTenantResult.toLowerCase().includes('tenant'), generateWithNoTenantResult);

  // --- Tenant-scoped links: Widgetco (has an email) vs. Northwind Consulting (doesn't) ---
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
  check('a tenant-scoped link for a tenant WITH a saved email shows "Send via email"',
    Boolean(await widgetcoLinkLi.$('.send-email-btn')),
    await widgetcoLinkLi.evaluate(el => el.textContent));
  const widgetcoSendBtnData = await widgetcoLinkLi.$eval('.send-email-btn', el => el.dataset.emails);
  check('the "Send via email" button carries the tenant\'s actual saved email in its data-emails',
    widgetcoSendBtnData === 'widgetco-contact@example.com', widgetcoSendBtnData);

  await generateTenantLink((await page.$$eval(`${distributionSelector} .new-link-tenant option`, opts =>
    (opts.find(o => o.textContent === 'Northwind Consulting') || {}).value)));
  const northwindLinkLi = await page.evaluateHandle((sel) => {
    return [...document.querySelectorAll(`${sel} .tenant-list li`)].find(li => li.textContent.includes('Northwind Consulting'));
  }, distributionSelector).then(h => h.asElement());
  check('a tenant-scoped link for a tenant with NO saved email shows neither button',
    !(await northwindLinkLi.$('.send-email-btn')) && (await northwindLinkLi.$$('.copy-link-btn')).length === 1,
    await northwindLinkLi.evaluate(el => el.textContent));

  const northwindCopyBtn = await northwindLinkLi.$('.copy-link-btn');
  const northwindExpectedLink = await northwindCopyBtn.evaluate(el => el.dataset.link);
  await northwindCopyBtn.click();
  await new Promise(r => setTimeout(r, 300));
  const northwindClipboardText = clipboardGrantable
    ? await page.evaluate(() => navigator.clipboard.readText()).catch(() => null)
    : null;
  if (northwindClipboardText === northwindExpectedLink){
    check('copy-link button actually copied the exact tenant-scoped link to the clipboard', true, northwindClipboardText);
  } else {
    const copyBtnText = await northwindCopyBtn.evaluate(el => el.textContent);
    check('clipboard unavailable in this sandbox, but the app degraded gracefully (friendly alert, no crash) instead of copying',
      copyBtnText.includes('Copied') || copyBtnText.includes('Copy link'), copyBtnText);
  }

  const wholeBuildingRowText = await page.$eval(`${distributionSelector} .building-link-row`, el => el.textContent);
  check('the whole-building link row (no single tenant to address) never shows "Send via email"',
    !wholeBuildingRowText.includes('Send via email'), wholeBuildingRowText);

  // --- "Send via email" - confirm-before-send (follow-up fix #2), then fails gracefully
  // (Cloud Function not deployed — needs Blaze + Entra ID) ---
  const confirmCountBeforeSend = await page.evaluate(() => window.__confirmCalls.length);
  const alertCountBeforeSend = await page.evaluate(() => window.__alertCalls.length);
  const widgetcoLinkLiFresh = await page.evaluateHandle((sel) => {
    return [...document.querySelectorAll(`${sel} .tenant-list li`)].find(li => li.textContent.includes('Widgetco'));
  }, distributionSelector).then(h => h.asElement());
  const sendBtn = await widgetcoLinkLiFresh.$('.send-email-btn');
  await sendBtn.click();
  await new Promise(r => setTimeout(r, 200)); // let the confirm dialog's own microtask chain settle
  const confirmMessagesForSend = await page.evaluate((n) => window.__confirmCalls.slice(n), confirmCountBeforeSend);
  check('"Send via email" shows a confirm dialog naming the real recipient address before sending',
    confirmMessagesForSend.some((m) => m.includes('widgetco-contact@example.com')), JSON.stringify(confirmMessagesForSend));
  await new Promise(r => setTimeout(r, 1500));
  const alertsAfterSend = await page.evaluate((n) => window.__alertCalls.slice(n), alertCountBeforeSend);
  check('clicking "Send via email" before the Cloud Function is deployed fails gracefully with a clear alert',
    alertsAfterSend.some(a => a.includes('copy the link above')), JSON.stringify(alertsAfterSend));
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
  // Carries ?program= too (a real gap found and fixed while building admin-enrolled-buildings.html
  // — this link used to silently drop it) so the round trip lands back on the same induction
  // instead of a neutral "nothing selected" state.
  const backHref = await page.$eval('#backToReportsLink', el => el.getAttribute('href')).catch(() => null);
  check('"← Back to reports" points at sorting-station-report.html, preserving ?emulator=1 and carrying ?program=',
    backHref === 'sorting-station-report.html?emulator=1&program=recycling-sorting', backHref);

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
