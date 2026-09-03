// One-time migration for the multi-program admin panel (see the approved plan,
// section "Data model for multiple programs"): seeds the `programs/recycling-sorting`
// catalog entry and backfills `enrollments/recycling-sorting__{buildingId}` for every
// existing building, copying its current `itemOverrides` field.
//
// Purely additive and safe to re-run: an enrollment already present for a building is
// left untouched (never overwritten), so running this twice — or running it after some
// buildings already got migrated by hand — never clobbers anything. `buildings.itemOverrides`
// itself is never modified or deleted by this script.
//
// Usage:
//   node tools/migrate-programs-enrollments.js --emulator   (against the local Firestore emulator)
//   node tools/migrate-programs-enrollments.js              (against the REAL project — asks
//                                                             for confirmation, requires
//                                                             REVIEWER_EMAIL/REVIEWER_PASSWORD,
//                                                             and drives a real Edge browser
//                                                             pointed at the live site, since
//                                                             the API key is referrer-restricted
//                                                             and a plain Node request has none)
const readline = require('readline');

const RECYCLING_PROGRAM = {
  name: 'Recycling Sorting',
  description: 'The original 5-stream drag-and-drop sorting induction.',
  file: 'recycling-training.html',
  kind: 'game',
  status: 'active',
};

async function run(db, { doc, getDoc, setDoc, collection, getDocs, serverTimestamp }){
  const programRef = doc(db, 'programs', 'recycling-sorting');
  const programSnap = await getDoc(programRef);
  if (!programSnap.exists()){
    await setDoc(programRef, { ...RECYCLING_PROGRAM, createdAt: serverTimestamp() });
    console.log('Created programs/recycling-sorting.');
  } else {
    console.log('programs/recycling-sorting already exists — left untouched.');
  }

  const buildingsSnap = await getDocs(collection(db, 'buildings'));
  let created = 0, skipped = 0;
  for (const b of buildingsSnap.docs){
    const enrollmentRef = doc(db, 'enrollments', `recycling-sorting__${b.id}`);
    const existing = await getDoc(enrollmentRef);
    if (existing.exists()){
      skipped++;
      continue;
    }
    await setDoc(enrollmentRef, {
      programId: 'recycling-sorting',
      buildingId: b.id,
      itemOverrides: b.data().itemOverrides || {},
      enabledTenantIds: null,
      createdAt: serverTimestamp(),
    });
    created++;
  }
  console.log(`Enrollments: ${created} created, ${skipped} already existed (skipped).`);
  console.log(`Buildings scanned: ${buildingsSnap.docs.length}.`);
}

async function runAgainstEmulator(){
  const fs = require('fs');
  const path = require('path');
  const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
  const { doc, getDoc, setDoc, collection, getDocs, serverTimestamp } = require('firebase/firestore');

  const testEnv = await initializeTestEnvironment({
    projectId: 'esg-1-98f35',
    firestore: { rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await run(context.firestore(), { doc, getDoc, setDoc, collection, getDocs, serverTimestamp });
  });
  await testEnv.cleanup();
}

async function confirm(question){
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return answer.trim().toLowerCase() === 'yes';
}

// The app's Firebase API key is browser-referrer-restricted (a real security setting, not a
// bug) — a plain Node process has no referrer at all, so a direct SDK call from Node gets
// rejected with auth/requests-from-referer-<empty>-are-blocked regardless of how correct the
// credentials are. Running this inside a real browser page actually loaded from the project's
// own domain gives every subsequent request a valid referrer, the same as the deployed app
// itself. This mirrors the Puppeteer pattern already used throughout tests/ (EDGE_PATH).
async function runAgainstProduction(){
  const puppeteer = require('puppeteer-core');
  const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const LIVE_URL = 'https://esg-1-98f35.web.app/sorting-station-report.html';

  const email = process.env.REVIEWER_EMAIL;
  const password = process.env.REVIEWER_PASSWORD;
  if (!email || !password){
    console.error('Set REVIEWER_EMAIL and REVIEWER_PASSWORD env vars (a signed-in reviewer account) before running against the real project.');
    process.exit(1);
  }

  const ok = await confirm('This will write to the REAL production Firestore database (esg-1-98f35). Type "yes" to continue: ');
  if (!ok){
    console.log('Aborted — no changes made.');
    return;
  }

  const browser = await puppeteer.launch({ executablePath: EDGE_PATH, headless: true });
  const page = await browser.newPage();
  page.on('console', (msg) => console.log('[browser]', msg.text()));

  try {
    await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded' });

    const result = await page.evaluate(async (email, password) => {
      const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js');
      const {
        getFirestore, doc, getDoc, setDoc, collection, getDocs, serverTimestamp
      } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js');
      const { getAuth, signInWithEmailAndPassword } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js');

      const firebaseConfig = {
        apiKey: 'AIzaSyAoWSx9FYa6UJa-6EZezgBYiDMuVVs9BBo',
        authDomain: 'esg-1-98f35.firebaseapp.com',
        projectId: 'esg-1-98f35',
        storageBucket: 'esg-1-98f35.firebasestorage.app',
        messagingSenderId: '196747023122',
        appId: '1:196747023122:web:3fbcc23c1532bed847d9cb',
      };
      const app = initializeApp(firebaseConfig);
      const db = getFirestore(app);
      const auth = getAuth(app);
      await signInWithEmailAndPassword(auth, email, password);

      const RECYCLING_PROGRAM = {
        name: 'Recycling Sorting',
        description: 'The original 5-stream drag-and-drop sorting induction.',
        file: 'recycling-training.html',
        kind: 'game',
        status: 'active',
      };

      const log = [];
      const programRef = doc(db, 'programs', 'recycling-sorting');
      const programSnap = await getDoc(programRef);
      if (!programSnap.exists()){
        await setDoc(programRef, { ...RECYCLING_PROGRAM, createdAt: serverTimestamp() });
        log.push('Created programs/recycling-sorting.');
      } else {
        log.push('programs/recycling-sorting already exists — left untouched.');
      }

      const buildingsSnap = await getDocs(collection(db, 'buildings'));
      let created = 0, skipped = 0;
      for (const b of buildingsSnap.docs){
        const enrollmentRef = doc(db, 'enrollments', `recycling-sorting__${b.id}`);
        const existing = await getDoc(enrollmentRef);
        if (existing.exists()){ skipped++; continue; }
        await setDoc(enrollmentRef, {
          programId: 'recycling-sorting',
          buildingId: b.id,
          itemOverrides: b.data().itemOverrides || {},
          enabledTenantIds: null,
          createdAt: serverTimestamp(),
        });
        created++;
      }
      log.push(`Enrollments: ${created} created, ${skipped} already existed (skipped).`);
      log.push(`Buildings scanned: ${buildingsSnap.docs.length}.`);
      return { ok: true, log, signedInAs: auth.currentUser.email };
    }, email, password);

    result.log.forEach(line => console.log(line));
    console.log(`Signed in as ${result.signedInAs}.`);
  } finally {
    await browser.close();
  }
}

const useEmulator = process.argv.includes('--emulator');
(useEmulator ? runAgainstEmulator() : runAgainstProduction())
  .then(() => process.exit(0))
  .catch((err) => { console.error('Migration failed:', err); process.exit(1); });
