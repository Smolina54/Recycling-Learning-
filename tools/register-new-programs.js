// One-time: registers Organics Focus and Battery Disposal in the production `programs`
// catalog — the piece the migration script deliberately doesn't touch (it only seeds
// recycling-sorting). Same browser-based approach as migrate-programs-enrollments.js: the
// API key is referrer-restricted, so this has to run inside a real page on the live domain,
// not a plain Node request.
//
// Usage: node tools/register-new-programs.js   (requires REVIEWER_EMAIL/REVIEWER_PASSWORD)
const readline = require('readline');
const puppeteer = require('puppeteer-core');

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const LIVE_URL = 'https://esg-1-98f35.web.app/sorting-station-report.html';

const PROGRAMS_TO_REGISTER = [
  { id: 'organics-focus', name: 'Organics Focus', description: 'A focused induction on the one category people get wrong most often: organics.', file: 'organics-training.html', kind: 'game' },
  { id: 'battery-disposal', name: 'Battery Disposal', description: 'A short quiz on why batteries need their own dedicated collection point.', file: 'battery-training.html', kind: 'quiz' },
];

async function confirm(question){
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return answer.trim().toLowerCase() === 'yes';
}

async function main(){
  const email = process.env.REVIEWER_EMAIL;
  const password = process.env.REVIEWER_PASSWORD;
  if (!email || !password){
    console.error('Set REVIEWER_EMAIL and REVIEWER_PASSWORD env vars first.');
    process.exit(1);
  }

  const ok = await confirm('This will register 2 programs in the REAL production catalog (esg-1-98f35). Type "yes" to continue: ');
  if (!ok){ console.log('Aborted — no changes made.'); return; }

  const browser = await puppeteer.launch({ executablePath: EDGE_PATH, headless: true });
  const page = await browser.newPage();
  page.on('console', (msg) => console.log('[browser]', msg.text()));

  try {
    await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded' });

    const result = await page.evaluate(async (email, password, programs) => {
      const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js');
      const { getFirestore, doc, getDoc, setDoc, serverTimestamp } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js');
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

      const log = [];
      for (const p of programs){
        const ref = doc(db, 'programs', p.id);
        const snap = await getDoc(ref);
        if (snap.exists()){
          log.push(`${p.id} already exists — left untouched.`);
          continue;
        }
        await setDoc(ref, {
          name: p.name, description: p.description, file: p.file, kind: p.kind,
          status: 'active', createdAt: serverTimestamp(),
        });
        log.push(`Created programs/${p.id}.`);
      }
      return { log, signedInAs: auth.currentUser.email };
    }, email, password, PROGRAMS_TO_REGISTER);

    result.log.forEach(line => console.log(line));
    console.log(`Signed in as ${result.signedInAs}.`);
  } finally {
    await browser.close();
  }
}

main().then(() => process.exit(0)).catch((err) => { console.error('Failed:', err); process.exit(1); });
