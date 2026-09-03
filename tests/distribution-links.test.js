// Verifies the ?l= distribution link flow (tenant-scoped and/or time-limited — see the
// multi-program plan's Step 5): resolves to the right building, locks the tenant dropdown when
// the link carries one, blocks an expired link with a distinct message, and confirms a revoked
// link (expiresAt moved to the past) stops working exactly like a naturally-expired one — both
// the UX-level check in initIdGate() and the server-side enforcement in firestore.rules.
// Run: npm run test:links
const path = require('path');
const url = require('url');
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const { initializeTestEnvironment, assertFails } = require('@firebase/rules-unit-testing');
const { doc, setDoc, addDoc, collection, getDocs, query, where } = require('firebase/firestore');

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const GAME_PATH = path.join(__dirname, '..', 'outputs', 'recycling-training.html');
const RULES_PATH = path.join(__dirname, '..', 'firestore.rules');
const BUILDING_ID = 'test-tower-links';
const TENANT_A = 'tenant-a-links';
const TENANT_B = 'tenant-b-links';

const results = [];
function check(label, cond, extra){ results.push({label, ok: Boolean(cond), extra: extra || ''}); }

async function seed(){
  const testEnv = await initializeTestEnvironment({
    projectId: 'esg-1-98f35',
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'buildings', BUILDING_ID), { name: 'Test Tower Links' });
    await setDoc(doc(db, 'buildings', BUILDING_ID, 'tenants', TENANT_A), { name: 'Tenant A', levels: ['Level 1'] });
    await setDoc(doc(db, 'buildings', BUILDING_ID, 'tenants', TENANT_B), { name: 'Tenant B', levels: ['Level 1'] });
    await setDoc(doc(db, 'enrollments', `recycling-sorting__${BUILDING_ID}`), {
      programId: 'recycling-sorting', buildingId: BUILDING_ID, itemOverrides: {},
    });
    await setDoc(doc(db, 'links', 'link-tenant-a'), { programId: 'recycling-sorting', buildingId: BUILDING_ID, tenantId: TENANT_A });
    await setDoc(doc(db, 'links', 'link-expired'), { programId: 'recycling-sorting', buildingId: BUILDING_ID, tenantId: null, expiresAt: new Date(Date.now() - 3600000) });
    await setDoc(doc(db, 'links', 'link-to-revoke'), { programId: 'recycling-sorting', buildingId: BUILDING_ID, tenantId: null, expiresAt: new Date(Date.now() + 3600000) });
  });
  return testEnv;
}

async function main(){
  const seedEnv = await seed();
  const browser = await puppeteer.launch({ executablePath: EDGE_PATH, headless: true });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

  try {
    await runTenantLockedFlow(page, seedEnv);
    await runExpiredFlow(browser);
    await runRevokeFlow(browser, seedEnv);
  } catch (err) {
    console.error('CRASHED — dumping diagnostics:', err.message);
    await page.screenshot({ path: path.join(__dirname, '..', 'debug-crash.png') }).catch(() => {});
    await browser.close();
    process.exit(1);
  }

  const unexpectedErrors = consoleErrors.filter(e => !e.includes('Failed to load resource') && !e.includes('400'));
  check('no UNEXPECTED console/page errors across the full run', unexpectedErrors.length === 0, unexpectedErrors.join(' || '));

  await browser.close();
  await seedEnv.cleanup();

  console.log('\n--- RESULTS ---');
  let allOk = true;
  for (const r of results){
    console.log(`${r.ok ? 'PASS' : 'FAIL'} — ${r.label}${r.extra ? ' :: ' + r.extra : ''}`);
    if (!r.ok) allOk = false;
  }
  process.exit(allOk ? 0 : 1);
}

async function runTenantLockedFlow(page, seedEnv){
  const linkUrl = `${url.pathToFileURL(GAME_PATH).href}?l=link-tenant-a&emulator=1`;
  await page.goto(linkUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.querySelector('#idTenant option[value]') !== null,
    { timeout: 10000 }
  );
  check('id-gate form is shown for a valid tenant-scoped link',
    await page.$eval('#idCardForm', el => getComputedStyle(el).display !== 'none'));

  const tenantOptions = await page.$$eval('#idTenant option', opts => opts.map(o => o.value));
  check('the tenant dropdown is locked to exactly the one tenant the link specifies',
    tenantOptions.length === 1 && tenantOptions[0] === TENANT_A, tenantOptions.join('|'));
  check('the tenant select is disabled (nothing else to pick anyway)',
    await page.$eval('#idTenant', el => el.disabled));

  await page.type('#idName', 'Jane Doe');
  await page.type('#idEmail', 'jane-link-tenant@example.com');
  await new Promise(r => setTimeout(r, 200));
  await page.select('#idLevel', 'Level 1');
  await page.click('#idForm button[type=submit]');
  await new Promise(r => setTimeout(r, 300));

  // startGameBtn stays disabled (updateGameLock()) until all 5 walkthrough tabs have been
  // visited — same as every other test that reaches the real game engine.
  const tabs = await page.$$('.bin-tab');
  for (const tab of tabs){ await tab.click(); await new Promise(r => setTimeout(r, 60)); }
  await new Promise(r => setTimeout(r, 150));

  await page.click('#startGameBtn');
  await new Promise(r => setTimeout(r, 600));

  let attemptOk = false;
  await seedEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    const snap = await getDocs(query(collection(db, 'attempts'), where('email', '==', 'jane-link-tenant@example.com')));
    if (!snap.empty){
      const data = snap.docs[0].data();
      attemptOk = data.tenantId === TENANT_A && data.linkId === 'link-tenant-a';
    }
  });
  check('the attempt was recorded against the locked tenant and carries the linkId', attemptOk);
}

async function runExpiredFlow(browser){
  const page = await browser.newPage();
  const linkUrl = `${url.pathToFileURL(GAME_PATH).href}?l=link-expired&emulator=1`;
  await page.goto(linkUrl, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 1000));
  check('an already-expired link shows the invalid-link fallback',
    await page.$eval('#idCardInvalid', el => getComputedStyle(el).display !== 'none').catch(() => false));
  const headline = await page.$eval('#idCardInvalidHeadline', el => el.textContent).catch(() => '');
  check('...with a message that specifically says "expired", not the generic "not recognised" text',
    headline.toLowerCase().includes('no longer active'), headline);
  await page.close();
}

async function runRevokeFlow(browser, seedEnv){
  // Confirm the link works BEFORE revoking (isolates "was it ever valid" from "did revoking work").
  const page1 = await browser.newPage();
  await page1.goto(`${url.pathToFileURL(GAME_PATH).href}?l=link-to-revoke&emulator=1`, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 1000));
  check('the link works before being revoked',
    await page1.$eval('#idCardForm', el => getComputedStyle(el).display !== 'none').catch(() => false));
  await page1.close();

  await seedEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'links', 'link-to-revoke'), { expiresAt: new Date(Date.now() - 1000) }, { merge: true });
  });

  const page2 = await browser.newPage();
  await page2.goto(`${url.pathToFileURL(GAME_PATH).href}?l=link-to-revoke&emulator=1`, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 1000));
  check('after revoking (expiresAt moved to the past), the same link now shows expired',
    await page2.$eval('#idCardInvalid', el => getComputedStyle(el).display !== 'none').catch(() => false));
  await page2.close();

  // Belt-and-suspenders: even a direct write attempt against the revoked link must be denied
  // server-side (real rules, not a rules-disabled context), not just hidden by the client UI.
  const rulesEnv = await initializeTestEnvironment({
    projectId: 'esg-1-98f35',
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  const anon = rulesEnv.unauthenticatedContext().firestore();
  let deniedServerSide = false;
  try {
    await assertFails(addDoc(collection(anon, 'submissions'), {
      buildingId: BUILDING_ID, tenantId: TENANT_A, name: 'X', email: 'x@example.com',
      programId: 'recycling-sorting', score: 50, linkId: 'link-to-revoke',
    }));
    deniedServerSide = true;
  } catch (err){ deniedServerSide = false; }
  check('a direct write against the revoked link is rejected server-side, not just hidden by the UI', deniedServerSide);
  await rulesEnv.cleanup();
}

main().catch((err) => { console.error('Test harness crashed:', err); process.exit(1); });
