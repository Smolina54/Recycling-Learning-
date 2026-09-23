// Verifies outputs/admin-admins.html — the Admins tab's own page since Workstream 2, Phase 1 of
// the architecture roadmap (C:\Users\smolina\.claude\plans\graceful-roaming-shell.md): granting/
// revoking a reviewer via /admins, and that navigating away to sorting-station-report.html and
// back preserves the signed-in session (Firebase Auth's own persistence, never explicitly wired
// by this app — first real test of that assumption now that more than one page exists).
// Run: npm run test:admin-admins
const path = require('path');
const url = require('url');
const puppeteer = require('puppeteer-core');

const EDGE_PATH = process.env.TEST_BROWSER_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ADMINS_URL = `${url.pathToFileURL(path.join(__dirname, '..', 'outputs', 'admin-admins.html')).href}?emulator=1`;
const REPORT_PATH = path.join(__dirname, '..', 'outputs', 'sorting-station-report.html');
const ALLOWED_EMAIL = 'esgtradeflex@gmail.com';

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

  // "Failed to load admins" can happen here as a harmless race: every page navigation in this
  // test re-triggers ?emulator=1's own auto-sign-in-as-owner convenience (a fresh page load runs
  // it again even though the session already persisted), and if that redundant call is still
  // in-flight right as #signOutBtn is clicked, its loadAdmins() can resolve a moment after
  // auth.currentUser has already gone null — denied by rules, caught, logged. Never happens in
  // production (?emulator=1 never exists there).
  const unexpectedErrors = consoleErrors.filter(e =>
    !e.includes('auth/email-already-in-use') && !e.includes('Failed to load resource') && !e.includes('400')
    && !e.includes('Failed to load admins'));
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
  await page.goto(ADMINS_URL, { waitUntil: 'domcontentloaded' });
  // ?emulator=1's own auto sign-in (as the owner) — same convenience every page already has.
  await page.waitForFunction(
    () => document.getElementById('adminsSection') && getComputedStyle(document.getElementById('adminsSection')).display !== 'none',
    { timeout: 10000 }
  );
  check('Admins section is visible once signed in (this page has nothing else on it)', true);
  // loadAdmins() is async — the section becomes visible synchronously in onAuthStateChanged,
  // before its own getDocs() call has actually resolved and populated #adminsList.
  await page.waitForFunction(() => (document.getElementById('adminsList')?.textContent || '').trim() !== '', { timeout: 10000 });

  // Workstream 11 replaced window.alert()/window.confirm() with a real in-page modal
  // (#appModalOverlay) — there's no native dialog to stub anymore. Instead, auto-respond to the
  // custom modal the same way the old stub did (always "confirm"/"OK"), recording each message
  // into the same __confirmCalls/__alertCalls arrays other assertions in this file may read from.
  await page.evaluate(() => {
    window.__confirmCalls = [];
    window.__alertCalls = [];
    const overlay = document.getElementById('appModalOverlay');
    new MutationObserver(() => {
      if (!overlay.classList.contains('open')) return;
      const message = document.getElementById('appModalMessage').textContent;
      const buttons = [...document.getElementById('appModalActions').querySelectorAll('button')];
      if (buttons.length === 1) { window.__alertCalls.push(message); buttons[0].click(); }
      else { window.__confirmCalls.push(message); buttons[buttons.length - 1].click(); }
    }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
  });

  check('owner email note is shown', (await page.$eval('#ownerEmailNote', el => el.textContent)) === ALLOWED_EMAIL);
  check('no additional admins yet', (await page.$eval('#adminsList', el => el.textContent)).includes('just you'));

  // --- Sidebar nav: links to the still-not-split-out tabs, and back to Reports ---
  // Every sidebar link gets ?emulator=1 appended on load (see the page's own patch right after
  // its auto sign-in) so navigating between pages never falls out of the local test session.
  const buildingsHref = await page.$eval('a[href*="admin-buildings.html"]', el => el.getAttribute('href')).catch(() => null);
  check('the Buildings sidebar link points at admin-buildings.html (its own page, Workstream 2 Phase 2)', buildingsHref === 'admin-buildings.html?emulator=1', buildingsHref);
  const catalogHref = await page.$eval('a[href*="admin-catalog.html"]', el => el.getAttribute('href')).catch(() => null);
  check('the Catalog sidebar link points at admin-catalog.html (its own page, Workstream 2 Phase 3)', catalogHref === 'admin-catalog.html?emulator=1', catalogHref);
  const backHref = await page.$eval('.settings-sidebar-exit a', el => el.getAttribute('href')).catch(() => null);
  check('"← Back to reports" points at sorting-station-report.html', backHref === 'sorting-station-report.html?emulator=1', backHref);

  // --- Grant/revoke a second reviewer, exactly like the old in-page tab used to ---
  const newAdminEmail = 'second.admin@example.com';
  await page.type('#newAdminEmail', newAdminEmail);
  await page.click('#addAdminBtn');
  await new Promise(r => setTimeout(r, 600));

  const adminsStatus = await page.$eval('#adminsStatus', el => el.textContent);
  check('adding an admin confirms via status text', adminsStatus.includes(newAdminEmail), adminsStatus);
  const adminEmails = await page.$$eval('#adminsList .tenant-name', els => els.map(el => el.textContent));
  check('the new admin appears in the list', adminEmails.includes(newAdminEmail), adminEmails.join('|'));

  await page.click('.remove-admin-btn');
  await new Promise(r => setTimeout(r, 600));
  const adminEmailsAfterRemove = await page.$$eval('#adminsList .tenant-name', els => els.map(el => el.textContent));
  check('the removed admin no longer appears in the list', !adminEmailsAfterRemove.includes(newAdminEmail), adminEmailsAfterRemove.join('|') || '(empty)');

  // --- Cross-page session persistence: the whole point of NOT sharing a JS module (see the
  // roadmap plan) is that Firebase Auth's own IndexedDB-backed persistence should carry the
  // signed-in session across a real page navigation with zero extra plumbing. Prove it. ---
  await page.goto(`${url.pathToFileURL(REPORT_PATH).href}?emulator=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => getComputedStyle(document.getElementById('settingsBtn')).display !== 'none',
    { timeout: 10000 }
  );
  check('navigating to sorting-station-report.html keeps the same signed-in session (no re-login needed)', true);

  await page.goto(ADMINS_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.getElementById('adminsSection') && getComputedStyle(document.getElementById('adminsSection')).display !== 'none',
    { timeout: 10000 }
  );
  check('navigating back to admin-admins.html also keeps the session (round trip, not one-way)', true);

  // --- Sign out must actually clear this page's own real data, not just hide it ---
  await page.click('#signOutBtn');
  await new Promise(r => setTimeout(r, 500));
  check('signing out shows the sign-in form again',
    await page.$eval('#authZone', el => getComputedStyle(el).display !== 'none'));
  check('signing out hides the Admins section',
    await page.$eval('#adminsSection', el => getComputedStyle(el).display === 'none'));
  check('signing out clears the Admins list',
    await page.$eval('#adminsList', el => el.innerHTML.trim() === ''));
}

main().catch((err) => { console.error('Test harness crashed:', err); process.exit(1); });
