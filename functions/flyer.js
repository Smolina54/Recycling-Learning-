// buildFlyerPdf — composes the printable/emailable Distribution QR flyer as a real PDF, server
// side (Workstream 13, Part 2). Deliberately NOT a headless-browser/Puppeteer render of
// admin-distribution.html's own #flyerPrintOverlay markup - this app has already, elsewhere,
// explicitly chosen to avoid Cloud Functions + a headless browser (cold start/package size/
// deploy complexity - see the client-report.html PDF-email backlog item in the plan) - a single
// static page (two logos + a few short lines + a QR) is simple enough to compose by hand instead
// with qrcode + pdf-lib + @pdf-lib/fontkit, three pure-JS packages with zero native dependencies.
//
// Copy is reused verbatim from the on-screen/print flyer already shipped in
// admin-distribution.html (Option B, user-approved 2026-09-28/29) - not re-approved here, just
// reproduced so the emailed PDF and the physically-printed poster read the same.
//
// Same "separate concern-specific module" pattern as functions/bintracker.js.
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

const BRANDING_DIR = path.join(__dirname, 'branding');

// Hand-copied from this app's own CSS tokens (--forest-dark/--ink/--ink-soft/--paper in
// admin-distribution.html's :root) - a Cloud Function has no CSS to read them from, so these are
// duplicated, not derived/shared.
const COLOR_FOREST_DARK = rgb(0x1f / 255, 0x4a / 255, 0x34 / 255);
const COLOR_INK = rgb(0x1e / 255, 0x2a / 255, 0x22 / 255);
const COLOR_INK_SOFT = rgb(0x4a / 255, 0x58 / 255, 0x50 / 255);
// Follow-up fix #4 (2026-09-29): the page previously had no background fill at all - pdf-lib
// defaults to plain white, so the emailed flyer never showed this app's characteristic cream
// (--paper) the way the on-screen/printed version's own CSS background already does.
const COLOR_PAPER = rgb(0xee / 255, 0xeb / 255, 0xe1 / 255);

const FLYER_TITLE = 'Help us sort it right.';
const FLYER_BODY = "Scan the code to complete a quick recycling induction on your phone - takes about 5 minutes, no app needed.";

// Real A4 page (210x297mm) - same physical target size as the on-screen/print flyer
// (admin-distribution.html's openFlyerPrint() injects @page{size:A4}), not pdf-lib's default.
// Follow-up fix #4 (2026-09-29): switched from A5 to A4 for practicality (A4 is the standard
// office-printer paper size in Australia, where Tradeflex and the buildings are - confirmed with
// the user directly). Every other magic number in this function is the original A5 design's own
// value multiplied by exactly √2 (≈1.4142) - A4 and A5 share the same aspect ratio (1:√2, both
// ISO 216 sizes), so this scale factor preserves the original design's proportions exactly rather
// than just adding more empty margin around the old, smaller content.
const MM_TO_PT = 72 / 25.4;
const PAGE_WIDTH = 210 * MM_TO_PT;
const PAGE_HEIGHT = 297 * MM_TO_PT;

// pdf-lib has no built-in text layout/wrapping (unlike a browser rendering real CSS) - a plain
// greedy word-wrap against the font's own measured width is all one short paragraph needs, not
// worth pulling in another dependency for.
function wrapText(text, font, size, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    const attempt = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(attempt, size) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = attempt;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function drawCentered(page, text, font, size, color, centerX, y) {
  const width = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: centerX - width / 2, y, size, font, color });
}

async function buildFlyerPdf({ buildingName, link }) {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);

  const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const centerX = PAGE_WIDTH / 2;
  const marginX = 79; // 56pt (A5 design) x √2 ≈ 28mm
  const contentWidth = PAGE_WIDTH - marginX * 2;

  // Full-page cream background - drawn FIRST so every subsequent element sits on top of it.
  page.drawRectangle({ x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT, color: COLOR_PAPER });

  // Same three Gilroy weights the on-screen flyer's own CSS actually uses (confirmed by reading
  // admin-distribution.html's .flyer-kicker/.flyer-title/.flyer-sub rules and body{}'s own
  // default font-weight:300, which .flyer-sub inherits) - Bold for the title, Medium for the
  // kicker, Light for the body copy.
  const gilroyBold = await pdfDoc.embedFont(fs.readFileSync(path.join(BRANDING_DIR, 'Gilroy-Bold.otf')));
  const gilroyMedium = await pdfDoc.embedFont(fs.readFileSync(path.join(BRANDING_DIR, 'Gilroy-Medium.otf')));
  const gilroyLight = await pdfDoc.embedFont(fs.readFileSync(path.join(BRANDING_DIR, 'Gilroy-Light.otf')));
  // The on-screen footer's font is Space Mono, a Google Font loaded only via a <link> tag in the
  // browser - never vendored as a local file anywhere in this repo, so a Cloud Function has
  // nothing to embed for it. pdf-lib's built-in Courier is the closest available monospace look
  // without pulling in a whole new font file just for one short footer line.
  const mono = await pdfDoc.embedFont(StandardFonts.Courier);

  const tradeflexLogo = await pdfDoc.embedPng(fs.readFileSync(path.join(BRANDING_DIR, 'tradeflex-logo.png')));
  const futuregreenLogo = await pdfDoc.embedPng(fs.readFileSync(path.join(BRANDING_DIR, 'futuregreen-logo.png')));

  const LOGO_HEIGHT = 42; // 30pt x √2
  const tradeflexDims = tradeflexLogo.scale(LOGO_HEIGHT / tradeflexLogo.height);
  const futuregreenDims = futuregreenLogo.scale(LOGO_HEIGHT / futuregreenLogo.height);
  const LOGO_GAP = 23; // 16pt x √2
  const logoRowWidth = tradeflexDims.width + LOGO_GAP + futuregreenDims.width;
  const logoRowX = centerX - logoRowWidth / 2;

  let y = PAGE_HEIGHT - 127; // 90pt x √2
  page.drawImage(tradeflexLogo, { x: logoRowX, y: y - LOGO_HEIGHT, width: tradeflexDims.width, height: LOGO_HEIGHT });
  page.drawImage(futuregreenLogo, {
    x: logoRowX + tradeflexDims.width + LOGO_GAP, y: y - LOGO_HEIGHT,
    width: futuregreenDims.width, height: futuregreenDims.height,
  });

  y -= LOGO_HEIGHT + 65; // 46pt x √2
  const kickerText = `${buildingName} · Waste Management Program`.toUpperCase();
  drawCentered(page, kickerText, gilroyMedium, 14, COLOR_FOREST_DARK, centerX, y); // 10pt x √2

  y -= 42; // 30pt x √2
  drawCentered(page, FLYER_TITLE, gilroyBold, 31, COLOR_INK, centerX, y); // 22pt x √2

  y -= 48; // 34pt x √2
  const bodyLines = wrapText(FLYER_BODY, gilroyLight, 17, contentWidth); // 12pt x √2
  for (const line of bodyLines) {
    drawCentered(page, line, gilroyLight, 17, COLOR_INK_SOFT, centerX, y);
    y -= 25; // 18pt x √2
  }

  // QR at ~78mm square (55mm x √2) - the original A5 design's own comfortable close-range scan
  // size, scaled up proportionally along with everything else, not left at its old absolute size
  // (which would have left the QR looking small and under-filling the larger A4 page).
  const QR_SIZE = 78 * MM_TO_PT;
  const qrPngBuffer = await QRCode.toBuffer(link, { errorCorrectionLevel: 'M', margin: 1, width: 600 });
  const qrImage = await pdfDoc.embedPng(qrPngBuffer);
  y -= 28; // 20pt x √2
  const qrY = y - QR_SIZE;
  page.drawRectangle({
    x: centerX - QR_SIZE / 2 - 11, y: qrY - 11, width: QR_SIZE + 22, height: QR_SIZE + 22, // 8pt x √2
    borderWidth: 1, borderColor: COLOR_INK_SOFT, color: rgb(1, 1, 1),
  });
  page.drawImage(qrImage, { x: centerX - QR_SIZE / 2, y: qrY, width: QR_SIZE, height: QR_SIZE });

  drawCentered(page, buildingName.toUpperCase(), mono, 13, COLOR_INK_SOFT, centerX, qrY - 45); // 9pt/32pt x √2

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

module.exports = { buildFlyerPdf };
