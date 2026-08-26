// Guardrail: fails if sorting-station-report.html's catalog has drifted from
// recycling-training.html's `items` array. Run: npm run test:catalog
// If this fails, run `npm run sync-catalog` and commit the result.
const { computeUpdatedReport } = require('../tools/sync-catalog');

try {
  const { reportHtml, updated, catalogCount } = computeUpdatedReport();
  if (updated === reportHtml){
    console.log(`PASS — catalog in sync (${catalogCount} items).`);
    process.exit(0);
  }
  console.error(`FAIL — sorting-station-report.html's catalog is out of sync with recycling-training.html. Run "npm run sync-catalog" and commit the result.`);
  process.exit(1);
} catch (err) {
  console.error('FAIL — could not verify catalog sync:', err.message);
  process.exit(1);
}
