// sendInductionEmail — relays an induction link to a tenant's saved contact emails via SMTP
// AUTH against Exchange Online (a mailbox's own username/password, no Entra ID app
// registration), so the admin panel's "Send via email" button sends for real instead of just
// opening a mailto: draft.
//
// Deployed (2026-09-23): Blaze plan active, SMTP AUTH enabled on wastewise@tradeflex.com.au on
// the Microsoft 365 side, and the three secrets below are set in Secret Manager via
// `firebase functions:secrets:set`. SMTP_SENDER_MAILBOX is kept as its own secret (not reused
// from SMTP_USERNAME) so the same setup also covers a licensed user with "Send As" permission on
// a shared mailbox, authenticating with their own credentials but sending as the shared address —
// not needed today (both are the same mailbox) but costs nothing to keep separate.
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const path = require('path');
const { catalog } = require('./catalog');

// Co-located with Firestore, which already lives in australia-southeast2 (Melbourne) — moved
// here from the platform's us-central1 default on 2026-09-23 for data residency (Tradeflex is
// an Australian company) and to avoid every Firestore call in these functions hopping across
// the Pacific. Every getFunctions(firebaseApp, ...) call site in outputs/*.html must pass this
// same region string or client calls will try to reach the old (deleted) us-central1 endpoint.
setGlobalOptions({ region: 'australia-southeast2' });

// Logos shared by both branded emails (the induction link and the trainee result), embedded as
// CID attachments (not a remote <img src=...>) so they don't depend on an external server being
// reachable and render without the "click to download images" prompt in most clients. Copied
// from outputs/branding/ — that folder isn't part of the Cloud Functions deployment package, so
// these need their own copy here, same reasoning as catalog.js being a synced copy rather than a
// shared import.
const TRADEFLEX_LOGO_CID = 'tradeflex-logo';
const FUTUREGREEN_LOGO_CID = 'futuregreen-logo';
const EMAIL_LOGO_ATTACHMENTS = [
  {
    filename: 'tradeflex-logo.png',
    path: path.join(__dirname, 'branding', 'tradeflex-logo-white.png'),
    cid: TRADEFLEX_LOGO_CID,
    contentDisposition: 'inline',
  },
  {
    filename: 'futuregreen-logo.png',
    path: path.join(__dirname, 'branding', 'futuregreen-logo-white.png'),
    cid: FUTUREGREEN_LOGO_CID,
    contentDisposition: 'inline',
  },
];

admin.initializeApp();

const SMTP_USERNAME = defineSecret('SMTP_USERNAME');
const SMTP_PASSWORD = defineSecret('SMTP_PASSWORD');
const SMTP_SENDER_MAILBOX = defineSecret('SMTP_SENDER_MAILBOX');

// Same OWNER_EMAIL as outputs/sorting-station-report.html — kept in sync by hand, there's no
// shared module between the static site and this function. A client-side admin check is only
// ever a UI convenience, never real security, so this is verified again here.
const OWNER_EMAIL = 'esgtradeflex@gmail.com';

const MAX_RECIPIENTS = 20;
const MAX_NAME_LENGTH = 300;
const MAX_LINK_LENGTH = 500;

// Per-admin rate limit: the auth check above stops an anonymous caller, but not a compromised/
// careless admin account or a runaway client-side retry loop from blasting real emails through
// the real mailbox. Counts CALLS (not recipients) in a fixed window per admin email. Sized
// generously — confirmed with the admin panel's own code that "Send via email" has no bulk
// option, only one call per tenant, so a building with 100+ tenants means 100+ real calls in
// one working session; 200/15min comfortably covers that without interrupting a legitimate
// bulk send, while still tripping well before a genuine abuse/loop scenario got anywhere close.
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_SENDS = 200;

function isValidEmail(str) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(str || '').trim());
}

async function assertIsAdmin(auth) {
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const callerEmail = auth.token.email;
  if (callerEmail === OWNER_EMAIL) return;
  const adminDoc = await admin.firestore().doc(`admins/${callerEmail}`).get();
  if (!adminDoc.exists) throw new HttpsError('permission-denied', 'Not an admin.');
}

// The client used to pre-render its own subject/text and just hand them over — now it sends the
// raw building/program name and link instead, and the server builds the actual branded email
// content (buildInductionEmailContent below), same reasoning as sendMyResultEmail building its
// own content server-side: one place owns the design instead of duplicating a template in
// client-side JS. buildingName/programName/link are all values this app itself generated
// (a building name typed once into admin-buildings.html, a program name from the programs
// catalog, an internally-built ?l=/?b= URL) — not arbitrary free text from an anonymous caller —
// but still bounded defensively, same as everywhere else in this file.
function validatePayload(data) {
  const { to, buildingName, programName, link } = data || {};
  if (!Array.isArray(to) || to.length === 0 || to.length > MAX_RECIPIENTS) {
    throw new HttpsError('invalid-argument', `Provide 1-${MAX_RECIPIENTS} recipient addresses.`);
  }
  if (!to.every(isValidEmail)) {
    throw new HttpsError('invalid-argument', 'One or more recipient addresses are invalid.');
  }
  if (!buildingName || !programName || !link) {
    throw new HttpsError('invalid-argument', 'A building name, program name, and link are required.');
  }
  if (String(buildingName).length > MAX_NAME_LENGTH || String(programName).length > MAX_NAME_LENGTH) {
    throw new HttpsError('invalid-argument', `Building/program name must be ${MAX_NAME_LENGTH} characters or fewer.`);
  }
  if (String(link).length > MAX_LINK_LENGTH) {
    throw new HttpsError('invalid-argument', `Link must be ${MAX_LINK_LENGTH} characters or fewer.`);
  }
  return { to, buildingName, programName, link };
}

// Fixed-window counter, one doc per admin email — a Firestore transaction so two
// near-simultaneous calls from the same admin can't both read a stale count and both slip
// through. A missing doc or an expired window both take the same "start a fresh window" path.
async function checkRateLimit(email) {
  const ref = admin.firestore().doc(`emailRateLimits/${email}`);
  await admin.firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : null;
    const now = Date.now();
    if (!data || now - data.windowStart > RATE_LIMIT_WINDOW_MS) {
      tx.set(ref, { windowStart: now, count: 1 });
      return;
    }
    if (data.count >= RATE_LIMIT_MAX_SENDS) {
      throw new HttpsError(
        'resource-exhausted',
        `Too many induction emails sent recently — wait a few minutes and try again ` +
          `(limit: ${RATE_LIMIT_MAX_SENDS} per ${RATE_LIMIT_WINDOW_MS / 60000} minutes).`
      );
    }
    tx.update(ref, { count: data.count + 1 });
  });
}

// Built fresh per call rather than cached at module scope — defineSecret().value() only
// resolves once the function is actually invoked with secrets bound, and a fresh transporter
// per call is cheap (a plain SMTP connection, no OAuth token to reuse/refresh).
function buildTransporter() {
  return nodemailer.createTransport({
    host: 'smtp.office365.com',
    port: 587,
    secure: false, // STARTTLS upgrade on port 587, not implicit TLS
    auth: { user: SMTP_USERNAME.value(), pass: SMTP_PASSWORD.value() },
    // nodemailer's own defaults (2 minutes each) would let a single hung/unreachable attempt
    // run past this callable's own execution limit before nodemailer ever gives up — fail fast
    // instead, both so a genuine outage surfaces quickly and so local/test runs against
    // throwaway credentials don't hang.
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
  });
}

async function sendViaSmtp({ to, subject, text, html, attachments }) {
  const transporter = buildTransporter();
  try {
    await transporter.sendMail({ from: SMTP_SENDER_MAILBOX.value(), to, subject, text, html, attachments });
  } catch (err) {
    console.error('SMTP send failed:', err && err.message);
    throw new HttpsError('internal', 'The mail server rejected the send.');
  }
}

// Builds the branded induction-link email. Reframed from a bare link relay ("Here's the
// induction link for X") into a formal notice explaining WHY the recipient is getting this at
// all — confirmed with the user via a real mockup before implementing, iterated a few times:
// the building name belongs in the black headline, not the green eyebrow line (which is just the
// program name); no QR code (a QR code bridges a PHYSICAL medium to a digital one — inside an
// email already open on a screen, the recipient already has a directly clickable link, so a QR
// code here would only add clutter, not help — the separate printable-flyer backlog item is the
// right place for one). Shares the exact same branded scaffold (and every Outlook-compatibility
// lesson learned building buildResultEmailContent) as the trainee result email below.
function buildInductionEmailContent({ buildingName, programName, link }) {
  const subject = `Complete your ${programName} induction — ${buildingName}`;
  const html = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#F7F5EE" style="background:#F7F5EE; font-family:'Helvetica Neue',Arial,sans-serif;">
      <tr><td align="center" style="padding:24px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#EEEBE1" style="max-width:560px; background:#EEEBE1; border-collapse:collapse;">
          <tr>
            <td bgcolor="#1F4A34" style="background:#1F4A34; padding:26px 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0"><tr>
                <td style="padding-right:20px;"><img src="cid:${TRADEFLEX_LOGO_CID}" width="122" height="40" alt="Tradeflex" style="display:block; border:0;"></td>
                <td><img src="cid:${FUTUREGREEN_LOGO_CID}" width="134" height="40" alt="FutureGreen - Tradeflex Sustainability Program" style="display:block; border:0;"></td>
              </tr></table>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <p style="margin:0 0 8px; font-size:15px; letter-spacing:0.4px; text-transform:uppercase; color:#2F6F4E; font-weight:bold;">${esc(programName)}</p>
              <p style="margin:0 0 16px; font-size:20px; font-weight:bold; color:#1E2A22;">${esc(buildingName)} requires you to complete this induction</p>
              <p style="margin:0 0 24px; font-size:15px; color:#1E2A22; line-height:1.5;">This is a required part of ${esc(buildingName)}'s waste management program.</p>
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
                <tr><td bgcolor="#2F6F4E" style="background:#2F6F4E; border-radius:6px; padding:0;">
                  <a href="${esc(link)}" style="display:inline-block; padding:12px 24px; font-size:14px; font-weight:bold; color:#FFFFFF; text-decoration:none;">Start the induction &rarr;</a>
                </td></tr>
              </table>
              <p style="margin:0 0 24px; font-size:12px; color:#4A5850; word-break:break-all;">Or copy this link: ${esc(link)}</p>
              <p style="margin:0; font-size:15px; color:#1E2A22; line-height:1.5;">Thanks for helping keep ${esc(buildingName)} sorting waste correctly.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 32px; border-top:1px solid #DEDACB;">
              <p style="margin:0; font-size:11px; color:#4A5850;">Tradeflex &middot; Integrated facilities services</p>
            </td>
          </tr>
        </table>
      </td></tr>
    </table>
  `;
  const text = `${buildingName} requires you to complete this induction.\n\nThis is a required part of ${buildingName}'s waste management program.\n\nStart here: ${link}\n\nThanks for helping keep ${buildingName} sorting waste correctly.`;
  return { subject, html, text };
}

exports.sendInductionEmail = onCall(
  { secrets: [SMTP_USERNAME, SMTP_PASSWORD, SMTP_SENDER_MAILBOX] },
  async (request) => {
    await assertIsAdmin(request.auth);
    const payload = validatePayload(request.data);
    await checkRateLimit(request.auth.token.email);
    const { subject, html, text } = buildInductionEmailContent(payload);
    await sendViaSmtp({ to: payload.to, subject, html, text, attachments: EMAIL_LOGO_ATTACHMENTS });
    return { ok: true };
  }
);

// sendMyResultEmail — lets a trainee (never signed in, just the id-gate form) email themselves
// the result of an induction they already completed. Deliberately NOT protected by App Check:
// that was tried on this exact game once already and disabled (see outputs/recycling-
// training.html's own RECAPTCHA_SITE_KEY comment, 2026-08-28) after it broke a real submission
// in Safari Private Browsing — the token fetch itself fails there and takes the write down with
// it, even with enforcement left off. Abuse is bounded instead by: the submission id has to
// reference a real, already-saved, randomly-generated document (nothing free-text is trusted
// from the client), and a hard per-submission cap below.
const RESULT_EMAIL_MAX_SENDS = 5;
const STREAM_ORDER = ['gw', 'mr', 'pc', 'og', 'ew'];
const STREAM_NAMES = { gw: 'General Waste', mr: 'Mixed Recycling', pc: 'Paper & Cardboard', og: 'Organics', ew: 'E-Waste' };
const PASS_MARK = 75;

function esc(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Same wording as the results screen itself (outputs/recycling-training.html) — reused verbatim
// so the email reads as a continuation of what the trainee already saw, not a different voice.
function verdictText(score) {
  return score >= PASS_MARK
    ? "Passed — solid grasp of what doesn't belong."
    : 'Not quite at the pass mark yet.';
}

// Builds both an HTML and a plain-text version from a real, already-saved submissions doc —
// the client only ever supplies WHICH submission and WHICH address, never any of this content.
function buildResultEmailContent(data) {
  const name = data.name || 'there';
  const score = data.score || 0;
  const verdict = verdictText(score);
  const streamRows = STREAM_ORDER
    .map((s) => {
      const b = data.breakdown && data.breakdown[s];
      if (!b || !b.total) return null;
      return { name: STREAM_NAMES[s], pct: Math.round((b.avoided / b.total) * 100) };
    })
    .filter(Boolean);
  const missed = Object.entries(data.items || {})
    .filter(([, avoided]) => !avoided)
    .map(([id]) => catalog[id])
    .filter(Boolean);

  // border-top on each row after the first — same technique as the footer's divider above
  // "Tradeflex · Integrated facilities services" below, which rendered correctly as a thin line
  // in a real send (2026-09-23). A separate 1px-tall spacer <tr> was tried instead and rendered
  // as a tall solid block in the recipient's real client — border-top is the one that actually
  // works here, so this sticks with it rather than the fancier-looking alternative.
  //
  // Every bit of text sitting bare inside a <td> (no enclosing <p>) gets auto-wrapped by
  // Outlook desktop's own Word rendering engine into a <p class=MsoNormal> carrying WORD'S
  // default paragraph spacing (a real ~21pt/28px bottom margin nobody asked for) — confirmed by
  // reading the actual .htm Outlook saved after a real send (2026-09-23). The "Items to review"
  // cards below never had this problem because they already wrap their text in an explicit
  // <p style="margin:...">; every <td> here now does the same, with margin explicitly zeroed.
  const streamHtml = streamRows
    .map((s, i) => `
      <tr>
        <td style="padding:10px 0; font-size:14px; color:#1E2A22;${i > 0 ? ' border-top:1px solid #DEDACB;' : ''}"><p style="margin:0;">${esc(s.name)}</p></td>
        <td style="padding:10px 0; font-size:14px; font-weight:bold; color:#2F6F4E; text-align:right;${i > 0 ? ' border-top:1px solid #DEDACB;' : ''}"><p style="margin:0;">${s.pct}%</p></td>
      </tr>
    `).join('');
  const streamText = streamRows.map((s) => `${s.name}: ${s.pct}%`).join('\n');

  // No card background — just a green rule on the left of each item, sitting directly on the
  // cream card behind it (a solid white box per item read as too stark). Each item is its own
  // row in ONE outer table, with the gap between items as padding-bottom on the wrapping <td>
  // rather than margin-bottom on each item's own inner table — Outlook ignores margin on tables
  // (confirmed via a real send, 2026-09-23: items rendered with no gap and one continuous left
  // border instead of one per item), but padding on a <td> is well supported.
  const missedHtml = missed.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${
        missed.map((it, i) => `
          <tr><td style="border-left:3px solid #2F6F4E; padding-left:16px;">
            <p style="margin:0 0 4px; font-size:14px; font-weight:bold; color:#1E2A22;">${esc(it.name)}</p>
            <p style="margin:0; font-size:13px; color:#4A5850; line-height:1.4;">${esc(it.explain)}</p>
          </td></tr>
          ${i < missed.length - 1 ? '<tr><td style="height:14px; line-height:14px; font-size:0;">&nbsp;</td></tr>' : ''}
        `).join('')
      }</table>`
    : '<p style="margin:0; font-size:14px; color:#4A5850;">Nothing missed — every item was sorted correctly.</p>';
  const missedText = missed.length
    ? missed.map((it) => `- ${it.name}: ${it.explain}`).join('\n')
    : 'Nothing missed - every item was sorted correctly.';

  const buildingLine = data.buildingName ? ` at ${esc(data.buildingName)}` : '';
  const buildingLineText = data.buildingName ? ` at ${data.buildingName}` : '';

  // Table-based layout with inline styles AND matching bgcolor attributes throughout (no
  // flexbox/grid, no outer <div> background) — Outlook's Word-based renderer ignores a plain
  // <div style="background:...">, and (confirmed via a real send, 2026-09-23) doesn't reliably
  // size an empty width:1px <td> either, so both the page background and the logo divider need
  // the more old-fashioned, more compatible approach below. The two logos are referenced via
  // cid: (see EMAIL_LOGO_ATTACHMENTS) rather than a remote <img src>, so they don't
  // depend on an external server being reachable when the recipient opens this. Colors/type
  // scale reuse this app's own tokens (recycling-training.html :root) rather than inventing new
  // ones — the card itself uses --paper (cream), not white, to match the rest of the app never
  // using pure white as a primary surface.
  const html = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#F7F5EE" style="background:#F7F5EE; font-family:'Helvetica Neue',Arial,sans-serif;">
      <tr><td align="center" style="padding:24px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#EEEBE1" style="max-width:560px; background:#EEEBE1; border-collapse:collapse;">
          <tr>
            <td bgcolor="#1F4A34" style="background:#1F4A34; padding:26px 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0"><tr>
                <td style="padding-right:20px;"><img src="cid:${TRADEFLEX_LOGO_CID}" width="122" height="40" alt="Tradeflex" style="display:block; border:0;"></td>
                <td><img src="cid:${FUTUREGREEN_LOGO_CID}" width="134" height="40" alt="FutureGreen - Tradeflex Sustainability Program" style="display:block; border:0;"></td>
              </tr></table>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <p style="margin:0 0 8px; font-size:15px; letter-spacing:0.4px; text-transform:uppercase; color:#2F6F4E; font-weight:bold;">Recycling Training &middot; Your Results</p>
              <p style="margin:0 0 20px; font-size:15px; color:#1E2A22;">Hi ${esc(name)},</p>
              <p style="margin:0 0 26px; font-size:15px; color:#1E2A22; line-height:1.5;">Thanks for completing the Recycling Sorting induction${buildingLine}.</p>
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
                <tr><td style="font-size:44px; font-weight:bold; color:#2F6F4E; line-height:1;"><p style="margin:0;">${score}%</p></td></tr>
                <tr><td style="font-size:14px; font-weight:bold; color:#1E2A22; padding-top:6px;"><p style="margin:0;">${esc(verdict)}</p></td></tr>
              </table>
              <p style="margin:0 0 10px; font-size:13px; font-weight:bold; text-transform:uppercase; letter-spacing:0.6px; color:#1E2A22;">Accuracy by stream</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px; border-collapse:collapse;">${streamHtml}</table>
              <p style="margin:0 0 12px; font-size:13px; font-weight:bold; text-transform:uppercase; letter-spacing:0.6px; color:#1E2A22;">Items to review</p>
              ${missedHtml}
              <p style="margin:26px 0 0; font-size:14px; color:#4A5850; line-height:1.5;">Thanks again for taking the time to complete this induction.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 32px; border-top:1px solid #DEDACB;">
              <p style="margin:0; font-size:11px; color:#4A5850;">Tradeflex &middot; Integrated facilities services</p>
            </td>
          </tr>
        </table>
      </td></tr>
    </table>
  `;
  const text = [
    `Hi ${name},`,
    `Thanks for completing the Recycling Sorting induction${buildingLineText}.`,
    ``,
    `${score}% - ${verdict}`,
    ``,
    `Accuracy by stream:`,
    streamText,
    ``,
    `Items to review:`,
    missedText,
    ``,
    `Thanks again for taking the time to complete this induction.`,
  ].join('\n');

  return { html, text };
}

exports.sendMyResultEmail = onCall(
  { secrets: [SMTP_USERNAME, SMTP_PASSWORD, SMTP_SENDER_MAILBOX] },
  async (request) => {
    const { submissionId, confirmedEmail } = request.data || {};
    if (!submissionId || typeof submissionId !== 'string') {
      throw new HttpsError('invalid-argument', 'A submission id is required.');
    }
    // isValidEmail only checks shape, not length — this gets persisted permanently onto the
    // submission doc below (an Admin SDK write, which bypasses firestore.rules' own 320-char
    // bound entirely), so bound it here explicitly before it becomes a permanent record a
    // reviewer trusts.
    if (!isValidEmail(confirmedEmail) || confirmedEmail.length > 320) {
      throw new HttpsError('invalid-argument', 'A valid email address is required.');
    }

    const ref = admin.firestore().doc(`submissions/${submissionId}`);
    // Per-submission rate limit lives ON the submission doc itself (sendCount), not a shared
    // collection keyed by admin email like emailRateLimits above — this cap is about how many
    // times ONE trainee's OWN result gets emailed, completely independent of how many other
    // trainees are doing the same thing at the same time (deliberately, so a busy induction day
    // for 1000 people never throttles any individual trainee's own send).
    const data = await admin.firestore().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        throw new HttpsError('not-found', 'No submission found for that id.');
      }
      const doc = snap.data();
      const sendCount = doc.sendCount || 0;
      if (sendCount >= RESULT_EMAIL_MAX_SENDS) {
        throw new HttpsError(
          'resource-exhausted',
          `You've already emailed yourself this result the maximum number of times (${RESULT_EMAIL_MAX_SENDS}).`
        );
      }
      // The trainee's corrected address is saved back permanently (visible in the admin's
      // Reports view from then on), not just used once for this one send.
      tx.update(ref, { sendCount: sendCount + 1, email: confirmedEmail });
      return doc;
    });

    const { html, text } = buildResultEmailContent(data);
    try {
      await sendViaSmtp({
        to: confirmedEmail,
        subject: 'Your Recycling Sorting results',
        text,
        html,
        attachments: EMAIL_LOGO_ATTACHMENTS,
      });
    } catch (err) {
      // The increment above commits before the SMTP call is even attempted, so a transient
      // failure (a mail-server blip, not the trainee's fault) would otherwise permanently burn
      // one of their 5 sends with no way back — submissions.update is reviewer-only in
      // firestore.rules, so nothing client-side could ever undo it. Give the attempt back before
      // letting the original error propagate, so only a SUCCESSFUL send ever counts against the
      // cap.
      await ref.update({ sendCount: admin.firestore.FieldValue.increment(-1) }).catch((giveBackErr) => {
        console.error('Failed to give back sendCount after a failed send:', giveBackErr && giveBackErr.message);
      });
      throw err;
    }
    return { ok: true };
  }
);
