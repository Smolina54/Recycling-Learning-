// Regenerates the `catalog` object inside sorting-station-report.html from the
// authoritative `ALL_ITEMS` array in recycling-training.html, so the two files can
// never silently drift apart. Run: npm run sync-catalog
//
// Syncs ALL catalog items (both the ones in rotation and the inactive backups) — the report's
// "Configure streams" editor lets an admin turn any of them on or off per building, so it needs
// to know about every one of them, not just the currently-active subset.
const fs = require('fs');
const path = require('path');

const GAME_PATH = path.join(__dirname, '..', 'outputs', 'recycling-training.html');
const REPORT_PATH = path.join(__dirname, '..', 'outputs', 'sorting-station-report.html');
const START_MARKER = '// AUTO-GENERATED CATALOG START';
const END_MARKER = '// AUTO-GENERATED CATALOG END';

// Captures id/name/stream, the flags segment between `stream` and `icon:` (used to detect
// `active:false`), and the icon SVG itself in one pass. `explain` is still skipped — it
// contains unescaped quotes inside its own backtick-free string — but the icon is safe to
// grab verbatim between its own backticks: no stray backtick exists inside any icon's SVG
// markup in the current catalog (every icon has exactly two backticks, open and close), so
// the non-greedy `` `([\s\S]*?)` `` reliably stops at this item's own closing backtick.
const ITEM_PATTERN = /\{\s*id:'([^']+)',\s*name:'([^']+)',\s*stream:'([^']+)'([\s\S]*?)icon:`([\s\S]*?)`/g;

function extractCatalog(gameHtml){
  const catalog = [];
  let match;
  while ((match = ITEM_PATTERN.exec(gameHtml)) !== null){
    const [, id, name, stream, flags, icon] = match;
    const active = !flags.includes('active:false');
    catalog.push({ id, name, stream, icon, active });
  }
  return catalog;
}

function buildCatalogBlock(catalog){
  const lines = catalog.map((item, i) => {
    const comma = i < catalog.length - 1 ? ',' : '';
    const activePart = item.active ? '' : ', active:false';
    return `    '${item.id}': {name:'${item.name}', stream:'${item.stream}', icon:\`${item.icon}\`${activePart}}${comma}`;
  });
  return `${START_MARKER} — do not edit by hand, run \`npm run sync-catalog\` after\n  // changing the \`ALL_ITEMS\` array in recycling-training.html (see tools/sync-catalog.js).\n  const catalog = {\n${lines.join('\n')}\n  };\n  ${END_MARKER}`;
}

function computeUpdatedReport(){
  const gameHtml = fs.readFileSync(GAME_PATH, 'utf8');
  const catalog = extractCatalog(gameHtml);
  if (catalog.length === 0){
    throw new Error('No items extracted from recycling-training.html — refusing to overwrite the report catalog with an empty one.');
  }

  const reportHtml = fs.readFileSync(REPORT_PATH, 'utf8');
  const startIdx = reportHtml.indexOf(START_MARKER);
  const endIdx = reportHtml.indexOf(END_MARKER);
  if (startIdx === -1 || endIdx === -1){
    throw new Error('Could not find the AUTO-GENERATED CATALOG markers in sorting-station-report.html.');
  }

  const before = reportHtml.slice(0, startIdx);
  const after = reportHtml.slice(endIdx + END_MARKER.length);
  return { reportHtml, updated: before + buildCatalogBlock(catalog) + after, catalogCount: catalog.length };
}

function main(){
  const { reportHtml, updated, catalogCount } = computeUpdatedReport();
  if (updated === reportHtml){
    console.log(`Already in sync — ${catalogCount} items, nothing to change.`);
    return;
  }
  fs.writeFileSync(REPORT_PATH, updated, 'utf8');
  console.log(`Synced ${catalogCount} items into sorting-station-report.html.`);
}

module.exports = { computeUpdatedReport };

if (require.main === module) main();
