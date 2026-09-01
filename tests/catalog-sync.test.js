// Guardrail: fails if sorting-station-report.html's catalog has drifted from
// recycling-training.html's `items` array. Run: npm run test:catalog
// If this fails, run `npm run sync-catalog` and commit the result.
const fs = require('fs');
const path = require('path');
const { computeUpdatedReport } = require('../tools/sync-catalog');

let failed = false;

try {
  const { reportHtml, updated, catalogCount } = computeUpdatedReport();
  if (updated === reportHtml){
    console.log(`PASS — catalog in sync (${catalogCount} items).`);
  } else {
    console.error(`FAIL — sorting-station-report.html's catalog is out of sync with recycling-training.html. Run "npm run sync-catalog" and commit the result.`);
    failed = true;
  }
} catch (err) {
  console.error('FAIL — could not verify catalog sync:', err.message);
  failed = true;
}

// A second, independent constant that has to stay matched by hand between the two files —
// sync-catalog.js doesn't touch it, so nothing else catches a drift here. If the game's
// decoy-pool cap and the admin editor's save-time validation cap disagree, a config the
// editor happily accepts could leave the game engine unable to find enough decoys.
try {
  const gameHtml = fs.readFileSync(path.join(__dirname, '..', 'outputs', 'recycling-training.html'), 'utf8');
  const reportHtml = fs.readFileSync(path.join(__dirname, '..', 'outputs', 'sorting-station-report.html'), 'utf8');
  const gameMatch = /const DECOY_CAP = (\d+);/.exec(gameHtml);
  const reportMatch = /const DECOY_CAP = (\d+);/.exec(reportHtml);
  if (!gameMatch || !reportMatch){
    console.error('FAIL — could not find DECOY_CAP in one or both files to compare.');
    failed = true;
  } else if (gameMatch[1] !== reportMatch[1]){
    console.error(`FAIL — DECOY_CAP mismatch: recycling-training.html has ${gameMatch[1]}, sorting-station-report.html has ${reportMatch[1]}. Update both to the same value.`);
    failed = true;
  } else {
    console.log(`PASS — DECOY_CAP matches in both files (${gameMatch[1]}).`);
  }
} catch (err) {
  console.error('FAIL — could not verify DECOY_CAP match:', err.message);
  failed = true;
}

process.exit(failed ? 1 : 0);
