// Regenerates the `catalog` object inside every page that carries its own copy from the
// authoritative `ALL_ITEMS` array in recycling-training.html, so none of them can silently
// drift apart. Run: npm run sync-catalog
//
// Syncs ALL catalog items (both the ones in rotation and the inactive backups) — the item-
// streams editor (in admin-enrolled-buildings.html) lets an admin turn any of them on or off
// per building, so it needs to know about every one of them, not just the currently-active
// subset. sorting-station-report.html also carries its own copy (used by sample-data
// generation and the missed-items ranking) even though it no longer has the editor itself
// (Workstream 2, Phase 5 of the architecture roadmap moved Enrolled Buildings — and with it
// the editor — to its own page, but Reports still needs `catalog` for other things).
const fs = require('fs');
const path = require('path');

const GAME_PATH = path.join(__dirname, '..', 'outputs', 'recycling-training.html');
// Every page with its own AUTO-GENERATED CATALOG block — add a new path here if a future page
// ever needs its own copy too.
const TARGET_PATHS = [
  path.join(__dirname, '..', 'outputs', 'sorting-station-report.html'),
  path.join(__dirname, '..', 'outputs', 'admin-enrolled-buildings.html'),
  path.join(__dirname, '..', 'outputs', 'client-report.html'),
  path.join(__dirname, '..', 'functions', 'catalog.js'),
];
const START_MARKER = '// AUTO-GENERATED CATALOG START';
const END_MARKER = '// AUTO-GENERATED CATALOG END';

// Captures id/name/stream, the flags segment between `stream` and `icon:` (used to detect
// `active:false`), the icon SVG itself, and explain/shortWhy, in one pass. The icon is safe to
// grab verbatim between its own backticks: no stray backtick exists inside any icon's SVG
// markup in the current catalog (every icon has exactly two backticks, open and close), so
// the non-greedy `` `([\s\S]*?)` `` reliably stops at this item's own closing backtick.
// explain/shortWhy are plain double-quoted strings with no embedded `"` anywhere in the current
// catalog (verified directly against the source, 2026-09-18 — previously assumed unsafe to
// extract and skipped entirely, which turned out to be over-cautious) — `[^"]*` reliably stops
// at each field's own closing quote.
const ITEM_PATTERN = /\{\s*id:'([^']+)',\s*name:'([^']+)',\s*stream:'([^']+)'([\s\S]*?)icon:`([\s\S]*?)`[\s\S]*?explain:"([^"]*)",\s*shortWhy:"([^"]*)"/g;

function extractCatalog(gameHtml){
  const catalog = [];
  let match;
  while ((match = ITEM_PATTERN.exec(gameHtml)) !== null){
    const [, id, name, stream, flags, icon, explain, shortWhy] = match;
    const active = !flags.includes('active:false');
    catalog.push({ id, name, stream, icon, active, explain, shortWhy });
  }
  return catalog;
}

function buildCatalogBlock(catalog){
  const lines = catalog.map((item, i) => {
    const comma = i < catalog.length - 1 ? ',' : '';
    const activePart = item.active ? '' : ', active:false';
    // JSON.stringify (not hand-rolled quoting) for explain/shortWhy - safe if either ever grows
    // an embedded quote or backslash later, unlike the fixed-format id/name/stream/icon fields.
    return `    '${item.id}': {name:'${item.name}', stream:'${item.stream}', icon:\`${item.icon}\`${activePart}, explain:${JSON.stringify(item.explain)}, shortWhy:${JSON.stringify(item.shortWhy)}}${comma}`;
  });
  return `${START_MARKER} — do not edit by hand, run \`npm run sync-catalog\` after\n  // changing the \`ALL_ITEMS\` array in recycling-training.html (see tools/sync-catalog.js).\n  const catalog = {\n${lines.join('\n')}\n  };\n  ${END_MARKER}`;
}

// Computes the updated content for one target file. Returns null if that file has no
// AUTO-GENERATED CATALOG markers at all (not every page needs one).
function computeUpdatedFile(targetPath, catalog){
  if (!fs.existsSync(targetPath)) return null;
  const targetHtml = fs.readFileSync(targetPath, 'utf8');
  const startIdx = targetHtml.indexOf(START_MARKER);
  const endIdx = targetHtml.indexOf(END_MARKER);
  if (startIdx === -1 || endIdx === -1) return null;

  const before = targetHtml.slice(0, startIdx);
  const after = targetHtml.slice(endIdx + END_MARKER.length);
  // The file is CRLF on disk (Windows); buildCatalogBlock() writes plain LF. Left as-is, the
  // very next edit to this file (any editor/tool that normalizes line endings) turns the
  // freshly-written block's LF into CRLF — which then looks "out of sync" again the next time
  // this runs, even though not a single byte of catalog data actually changed. Match whatever
  // convention already surrounds the markers instead of assuming LF.
  // Real bug fixed here: recycling-training.html (the source of each item's `icon` SVG text) is
  // itself CRLF on disk, so the icon strings captured by ITEM_PATTERN already carry embedded
  // \r\n internally — a blind `.replace(/\n/g, '\r\n')` then doubled every one of those into
  // \r\r\n (only the icon-internal newlines; a plain \n between items converted correctly).
  // Collapsing to \n first, unconditionally, makes the CRLF conversion below idempotent
  // regardless of which line-ending convention recycling-training.html happens to use.
  const rawBlock = buildCatalogBlock(catalog).replace(/\r\n/g, '\n');
  const usesCRLF = before.includes('\r\n');
  const catalogBlock = usesCRLF ? rawBlock.replace(/\n/g, '\r\n') : rawBlock;
  return { targetHtml, updated: before + catalogBlock + after };
}

// Computes updates for every target file that has its own catalog block. Used by
// tests/catalog-sync.test.js to verify all of them stay in sync, and by main() to write them.
function computeAllUpdates(){
  const gameHtml = fs.readFileSync(GAME_PATH, 'utf8');
  const catalog = extractCatalog(gameHtml);
  if (catalog.length === 0){
    throw new Error('No items extracted from recycling-training.html — refusing to overwrite any catalog with an empty one.');
  }
  const results = TARGET_PATHS.map((targetPath) => {
    const result = computeUpdatedFile(targetPath, catalog);
    return result ? { targetPath, ...result } : { targetPath, missing: true };
  });
  const missing = results.filter(r => r.missing);
  return { results: results.filter(r => !r.missing), catalogCount: catalog.length, missing };
}

function main(){
  const { results, catalogCount, missing } = computeAllUpdates();
  if (missing.length){
    throw new Error(`Could not find the AUTO-GENERATED CATALOG markers in: ${missing.map(r => r.targetPath).join(', ')}`);
  }
  let anyChanged = false;
  for (const { targetPath, targetHtml, updated } of results){
    if (updated === targetHtml){
      console.log(`Already in sync — ${catalogCount} items, nothing to change in ${path.basename(targetPath)}.`);
      continue;
    }
    fs.writeFileSync(targetPath, updated, 'utf8');
    console.log(`Synced ${catalogCount} items into ${path.basename(targetPath)}.`);
    anyChanged = true;
  }
  if (!anyChanged) console.log('Every target file was already in sync.');
}

module.exports = { computeAllUpdates, TARGET_PATHS };

if (require.main === module) main();
