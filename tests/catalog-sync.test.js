// Guardrail: fails if any page carrying its own copy of the catalog (sorting-station-report.html,
// admin-enrolled-buildings.html) has drifted from recycling-training.html's `ALL_ITEMS` array.
// Run: npm run test:catalog
// If this fails, run `npm run sync-catalog` and commit the result.
const fs = require('fs');
const path = require('path');
const { computeAllUpdates } = require('../tools/sync-catalog');

let failed = false;

try {
  const { results, catalogCount, missing } = computeAllUpdates();
  if (missing.length){
    console.error(`FAIL — missing AUTO-GENERATED CATALOG markers in: ${missing.map(r => path.basename(r.targetPath)).join(', ')}`);
    failed = true;
  }
  for (const { targetPath, targetHtml, updated } of results){
    const name = path.basename(targetPath);
    if (updated === targetHtml){
      console.log(`PASS — ${name}'s catalog in sync (${catalogCount} items).`);
    } else {
      console.error(`FAIL — ${name}'s catalog is out of sync with recycling-training.html. Run "npm run sync-catalog" and commit the result.`);
      failed = true;
    }
  }
} catch (err) {
  console.error('FAIL — could not verify catalog sync:', err.message);
  failed = true;
}

// A second, independent constant that has to stay matched by hand across all three files —
// sync-catalog.js doesn't touch it, so nothing else catches a drift here. If the game's
// decoy-pool cap and an admin editor's save-time validation cap disagree, a config the editor
// happily accepts could leave the game engine unable to find enough decoys.
try {
  const gameHtml = fs.readFileSync(path.join(__dirname, '..', 'outputs', 'recycling-training.html'), 'utf8');
  const gameMatch = /const DECOY_CAP = (\d+);/.exec(gameHtml);
  if (!gameMatch){
    console.error('FAIL — could not find DECOY_CAP in recycling-training.html.');
    failed = true;
  } else {
    // Only admin-enrolled-buildings.html still has the item-streams editor (and its own
    // DECOY_CAP) since Workstream 2, Phase 5 moved it out of sorting-station-report.html.
    const editorPath = path.join(__dirname, '..', 'outputs', 'admin-enrolled-buildings.html');
    const editorHtml = fs.readFileSync(editorPath, 'utf8');
    const editorMatch = /const DECOY_CAP = (\d+);/.exec(editorHtml);
    if (!editorMatch){
      console.error('FAIL — could not find DECOY_CAP in admin-enrolled-buildings.html.');
      failed = true;
    } else if (gameMatch[1] !== editorMatch[1]){
      console.error(`FAIL — DECOY_CAP mismatch: recycling-training.html has ${gameMatch[1]}, admin-enrolled-buildings.html has ${editorMatch[1]}. Update both to the same value.`);
      failed = true;
    } else {
      console.log(`PASS — DECOY_CAP matches in both files (${gameMatch[1]}).`);
    }
  }
} catch (err) {
  console.error('FAIL — could not verify DECOY_CAP match:', err.message);
  failed = true;
}

process.exit(failed ? 1 : 0);
