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

// Hand-copied from this app's own CSS tokens (--forest-dark/--ink/--ink-soft in
// admin-distribution.html's :root) - a Cloud Function has no CSS to read them from, so these are
// duplicated, not derived/shared.
const COLOR_FOREST_DARK = rgb(0x1f / 255, 0x4a / 255, 0x34 / 255);
const COLOR_INK = rgb(0x1e / 255, 0x2a / 255, 0x22 / 255);
const COLOR_INK_SOFT = rgb(0x4a / 255, 0x58 / 255, 0x50 / 255);

const FLYER_TITLE = 'Help us sort it right.';
const FLYER_BODY = "Scan the code to complete a quick recycling induction on your phone - takes about 5 minutes, no app needed.";

// Real A5 page (148x210mm) - same physical target size as the on-screen/print flyer
// (admin-distribution.html's openFlyerPrint() injects @page{size:A5}), not pdf-lib's default.
const MM_TO_PT = 72 / 25.4;
const PAGE_WIDTH = 148 * MM_TO_PT;
const PAGE_HEIGHT = 210 * MM_TO_PT;

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
  const marginX = 56; // ~20mm
  const contentWidth = PAGE_WIDTH - marginX * 2;

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

  const LOGO_HEIGHT = 30;
  const tradeflexDims = tradeflexLogo.scale(LOGO_HEIGHT / tradeflexLogo.height);
  const futuregreenDims = futuregreenLogo.scale(LOGO_HEIGHT / futuregreenLogo.height);
  const LOGO_GAP = 16;
  const logoRowWidth = tradeflexDims.width + LOGO_GAP + futuregreenDims.width;
  const logoRowX = centerX - logoRowWidth / 2;

  let y = PAGE_HEIGHT - 90;
  page.drawImage(tradeflexLogo, { x: logoRowX, y: y - LOGO_HEIGHT, width: tradeflexDims.width, height: LOGO_HEIGHT });
  page.drawImage(futuregreenLogo, {
    x: logoRowX + tradeflexDims.width + LOGO_GAP, y: y - LOGO_HEIGHT,
    width: futuregreenDims.width, height: futuregreenDims.height,
  });

  y -= LOGO_HEIGHT + 46;
  const kickerText = `${buildingName} · Waste Management Program`.toUpperCase();
  drawCentered(page, kickerText, gilroyMedium, 10, COLOR_FOREST_DARK, centerX, y);

  y -= 30;
  drawCentered(page, FLYER_TITLE, gilroyBold, 22, COLOR_INK, centerX, y);

  y -= 34;
  const bodyLines = wrapText(FLYER_BODY, gilroyLight, 12, contentWidth);
  for (const line of bodyLines) {
    drawCentered(page, line, gilroyLight, 12, COLOR_INK_SOFT, centerX, y);
    y -= 18;
  }

  // QR at ~55mm square - same comfortable close-range scan size as the physical printed flyer
  // (openFlyerPrint()'s own @media print sizing).
  const QR_SIZE = 55 * MM_TO_PT;
  const qrPngBuffer = await QRCode.toBuffer(link, { errorCorrectionLevel: 'M', margin: 1, width: 600 });
  const qrImage = await pdfDoc.embedPng(qrPngBuffer);
  y -= 20;
  const qrY = y - QR_SIZE;
  page.drawRectangle({
    x: centerX - QR_SIZE / 2 - 8, y: qrY - 8, width: QR_SIZE + 16, height: QR_SIZE + 16,
    borderWidth: 1, borderColor: COLOR_INK_SOFT, color: rgb(1, 1, 1),
  });
  page.drawImage(qrImage, { x: centerX - QR_SIZE / 2, y: qrY, width: QR_SIZE, height: QR_SIZE });

  drawCentered(page, buildingName.toUpperCase(), mono, 9, COLOR_INK_SOFT, centerX, qrY - 32);

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

module.exports = { buildFlyerPdf };
