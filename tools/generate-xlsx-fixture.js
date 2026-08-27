// One-off generator for tests/fixtures/sample-collection-points.xlsx — a SYNTHETIC
// stand-in for the real "collection point" export format (Name / Primary Location /
// Created On columns, tenants split across multiple rows/sub-areas, some junk rows
// like "Vacant" mixed in). Uses fake names only — never commit a real client export.
// Run: node tools/generate-xlsx-fixture.js
const XLSX = require('xlsx');
const path = require('path');

const rows = [
  ['Name', 'Primary Location', 'Created On'],
  ['Base Building - Ground', 'Ground', 44889],
  ['Widgetco - Level 3', 'Level 3', 44889],
  ['Widgetco - Level 4', 'Level 4', 44889],
  ['Acme Legal - Level 8', 'Level 8', 44889],
  ['Acme Legal - Level 9', 'Level 9', 44889],
  ['Northwind Consulting - Level 14 - Office', 'Level 14', 44889],
  ['Northwind Consulting - Level 14 - Kitchen', 'Level 14', 44889],
  ['Vacant - Level 20', 'Level 20', 44889],
  ['Vacant - Level 21', 'Level 21', 44889],
  ['Retail Tenants - Ground - Sunrise Cafe', 'Ground', 44889],
  ['Go Zero (Retail)', 'Ground', 44889],
  ['External Bin/ Commercial', 'External Bin/ Commercial', 44889],
];

const sheet = XLSX.utils.aoa_to_sheet(rows);
const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');

const outPath = path.join(__dirname, '..', 'tests', 'fixtures', 'sample-collection-points.xlsx');
XLSX.writeFile(workbook, outPath);
console.log('Wrote', outPath);
