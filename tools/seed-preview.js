// One-off: seeds a demo building/tenant into the already-running local emulator
// so Sergio can open the game in a real browser and click through it himself.
// Not part of the automated test suite — run manually when needed.
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc } = require('firebase/firestore');

async function main(){
  const testEnv = await initializeTestEnvironment({
    projectId: 'esg-1-98f35',
    firestore: { rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'buildings', 'demo-building'), { name: '123 Example Tower' });
    await setDoc(doc(db, 'buildings', 'demo-building', 'tenants', 'demo-tenant'), { name: 'Acme Legal', levels: ['Level 8', 'Level 9'] });
  });
  console.log('Seeded demo-building / demo-tenant into the local emulator.');
}
main().catch(err => { console.error(err); process.exit(1); });
