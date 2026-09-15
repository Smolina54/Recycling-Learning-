// Runs every test suite in sequence against ONE already-running Firebase emulator instance,
// instead of each `npm run test:X` spinning its own emulator up and down (18 separate Java/
// Firestore-emulator boot cycles, the dominant cost in a full regression run). Each suite still
// runs as its own child process — same isolation as before, just without the emulator restart
// between them; clearFirestoreBeforeEachSuite() (below) gives each one back the pristine
// database it always assumed, without paying for a full restart to get it.
// Run: npm run test:all (wraps this in one `firebase emulators:exec --only firestore,auth,functions`,
// using firebase.local-test.json so the Functions emulator lands on the same non-default port
// test:functions already needs — see that script/test file for why).
const path = require('path');
const { spawnSync } = require('child_process');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');

// Every suite was always written assuming it gets a completely fresh Firestore emulator (no
// persistence between separate `firebase emulators:exec` invocations) — several make real
// assertions that depend on that ("no additional admins yet", "no inductions registered yet",
// a "most commonly missed items" ranking computed over ALL programId-matching submissions in
// the database). Sharing one emulator PROCESS across all 18 suites is what saves the restart
// overhead, but without this, suite N would see every fixture suites 1..N-1 already wrote and
// those assumptions would break — confirmed by hitting exactly that the first time this ran.
// clearFirestore() is a lightweight RPC to the already-running emulator (not a process restart,
// completes in well under a second), so this keeps each suite's original isolation guarantee
// without paying the JVM/emulator boot cost 18 times. Auth emulator state is deliberately left
// alone — nothing asserts on "zero users exist", and every suite already tolerates a persisted
// test user via the standard create-or-sign-in-if-already-exists pattern.
async function clearFirestoreBeforeEachSuite(){
  const testEnv = await initializeTestEnvironment({ projectId: 'esg-1-98f35' });
  await testEnv.clearFirestore();
  await testEnv.cleanup();
}

const SUITES = [
  { name: 'test:catalog', file: 'catalog-sync.test.js' },
  { name: 'test:game', file: 'game-regression.test.js' },
  { name: 'test:overrides', file: 'game-regression-overrides.test.js' },
  { name: 'test:preview', file: 'preview-mode.test.js' },
  { name: 'test:report', file: 'report-ui.test.js' },
  { name: 'test:admin', file: 'admin-buildings.test.js' },
  { name: 'test:admin-admins', file: 'admin-admins.test.js' },
  { name: 'test:admin-buildings-page', file: 'admin-buildings-page.test.js' },
  { name: 'test:catalog-admin', file: 'admin-catalog.test.js' },
  { name: 'test:admin-catalog-page', file: 'admin-catalog-page.test.js' },
  { name: 'test:admin-distribution-page', file: 'admin-distribution-page.test.js' },
  { name: 'test:admin-enrolled-buildings-page', file: 'admin-enrolled-buildings-page.test.js' },
  { name: 'test:organics', file: 'organics-training.test.js' },
  { name: 'test:battery', file: 'battery-training.test.js' },
  { name: 'test:links', file: 'distribution-links.test.js' },
  { name: 'test:rules', file: 'firestore-rules.test.js' },
  { name: 'test:scoped-report', file: 'scoped-report-access.test.js' },
  { name: 'test:functions', file: 'functions-sendinductionemail.test.js', env: { FUNCTIONS_EMULATOR_PORT: '5003' } },
];

async function main(){
  const results = [];
  const startedAt = Date.now();

  for (const suite of SUITES) {
    const suiteStart = Date.now();
    await clearFirestoreBeforeEachSuite();
    console.log(`\n================== RUNNING: ${suite.name} (${suite.file}) ==================`);
    const filePath = path.join(__dirname, suite.file);
    const res = spawnSync(process.execPath, [filePath], {
      stdio: 'inherit',
      env: { ...process.env, ...(suite.env || {}) },
    });
    const code = res.status === null ? 1 : res.status;
    const seconds = ((Date.now() - suiteStart) / 1000).toFixed(1);
    results.push({ name: suite.name, code, seconds });
  }

  const totalSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log('\n================== SUMMARY ==================');
  let overallOk = true;
  for (const r of results) {
    if (r.code !== 0) overallOk = false;
    console.log(`${r.code === 0 ? 'PASS' : 'FAIL'} - ${r.name} (${r.seconds}s)${r.code !== 0 ? ` [exit ${r.code}]` : ''}`);
  }
  console.log(`\nTotal: ${totalSeconds}s for ${results.length} suites`);
  process.exit(overallOk ? 0 : 1);
}

main().catch((err) => { console.error('run-all.js crashed:', err); process.exit(1); });
