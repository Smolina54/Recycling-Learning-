// Regenerates the `catalog` object inside sorting-station-report.html from the
// authoritative `items` array in recycling-training.html, so the two files can
// never silently drift apart. Run: npm run sync-catalog
const fs = require('fs');
const path = require('path');

const GAME_PATH = path.join(__dirname, '..', 'outputs', 'recycling-training.html');
const REPORT_PATH = path.join(__dirname, '..', 'outputs', 'sorting-station-report.html');
const START_MARKER = '// AUTO-GENERATED CATALOG START';
const END_MARKER = '// AUTO-GENERATED CATALOG END';

// Only id/name/stream are extracted — icon/explain contain unescaped quotes inside
// backtick template strings, so a full object-literal parse isn't attempted.
const ITEM_PATTERN = /\{\s*id:'([^']+)',\s*name:'([^']+)',\s*stream:'([^']+)'/g;

function extractCatalog(gameHtml){
  const catalog = [];
  let match;
  while ((match = ITEM_PATTERN.exec(gameHtml)) !== null){
    const [, id, name, stream] = match;
    catalog.push({ id, name, stream });
  }
  return catalog;
}

function buildCatalogBlock(catalog){
  const lines = catalog.map((item, i) => {
    const comma = i < catalog.length - 1 ? ',' : '';
    return `    '${item.id}': {name:'${item.name}', stream:'${item.stream}'}${comma}`;
  });
  return `${START_MARKER} — do not edit by hand, run \`npm run sync-catalog\` after\n  // changing the \`items\` array in recycling-training.html (see tools/sync-catalog.js).\n  const catalog = {\n${lines.join('\n')}\n  };\n  ${END_MARKER}`;
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
