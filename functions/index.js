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
const { FieldValue } = require('firebase-admin/firestore');
const nodemailer = require('nodemailer');
const path = require('path');
const crypto = require('crypto');
const { catalog } = require('./catalog');
const {
  fetchBintrackerCollections, mapWasteTypeToStream, computeRecyclingLevelPct,
  diffDiscoveredBuildingNames, diffBintrackerTenants, normalizeForMatching,
} = require('./bintracker');
const { buildFlyerPdf } = require('./flyer');

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
const BINTRACKER_APP_ID = defineSecret('BINTRACKER_APP_ID');
const BINTRACKER_APP_KEY = defineSecret('BINTRACKER_APP_KEY');

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

// Same 15-minute window as email, but a much lower cap — these 3 functions each hit Bintracker's
// real third-party API per call (refreshBintrackerData/syncBintrackerTenants scoped to one
// building; discoverBintrackerBuildings unscoped, pulling up to 25,000 rows per call per
// functions/bintracker.js's own paging cap), so nothing before this audit stopped a compromised
// or careless admin session (or a buggy client-side retry loop) from hammering that shared
// account in a tight loop. 30/15min comfortably covers a real admin working through a session of
// several buildings while still tripping fast on genuine abuse.
const BINTRACKER_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const BINTRACKER_RATE_LIMIT_MAX_CALLS = 30;

// Permanent-delete functions are individually gated by a type-the-exact-name confirmation, but
// that only stops accidental misuse — a scripted/compromised admin credential already knows the
// real names from a prior read and could loop through every archived building/tenant with no
// artificial delay. A higher cap than Bintracker's (a legitimate end-of-quarter cleanup session
// could plausibly delete a couple dozen stale records) but still a real, bounded budget.
const DELETE_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const DELETE_RATE_LIMIT_MAX_CALLS = 50;

// provisionUserAccount (Workstream 15, Part 3, 2026-10-06) - creating accounts and sending invite
// emails is a rarer admin action than the others above (onboarding, not routine cleanup), so a
// tighter budget than deletes is still generous enough for a real bulk-onboarding session.
const PROVISION_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const PROVISION_RATE_LIMIT_MAX_CALLS = 30;

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
// Generalized (a pre-production audit found the Bintracker-calling functions and both permanent-
// delete functions had NO rate limit at all, unlike every email function) so each action category
// gets its own independent bucket in its own collection — a burst of one kind of action (e.g.
// deletes) never eats into another kind's (e.g. Bintracker syncs) budget.
async function checkRateLimitGeneric(collectionName, key, windowMs, maxCount, actionLabel) {
  const ref = admin.firestore().doc(`${collectionName}/${key}`);
  await admin.firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : null;
    const now = Date.now();
    if (!data || now - data.windowStart > windowMs) {
      tx.set(ref, { windowStart: now, count: 1 });
      return;
    }
    if (data.count >= maxCount) {
      throw new HttpsError(
        'resource-exhausted',
        `Too many ${actionLabel} recently - wait a few minutes and try again ` +
          `(limit: ${maxCount} per ${windowMs / 60000} minutes).`
      );
    }
    tx.update(ref, { count: data.count + 1 });
  });
}

async function checkRateLimit(email) {
  return checkRateLimitGeneric('emailRateLimits', email, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_SENDS, 'induction emails sent');
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
//
// Font is 'Helvetica Neue'/Arial, not Gilroy (the app's own brand typeface), deliberately - email
// clients have very inconsistent @font-face support (many strip it outright, and Outlook desktop
// renders HTML email through Word's engine, not a real browser), and most also block loading an
// external font file by default the same way they block images until the recipient allows them.
// Rather than risk Gilroy rendering correctly in some inboxes and falling back unpredictably in
// others, this uses a "web-safe" font guaranteed to already be installed and look the same
// everywhere - a deliberate trade of exact brand typography for guaranteed consistency, the same
// reasoning that drove the VML "bulletproof button" and table-based layout elsewhere in this file.
function buildInductionEmailContent({ buildingName, programName, link }) {
  const subject = `Complete your ${programName} induction - ${buildingName}`;
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
              <p style="margin:0 0 16px; font-size:20px; font-weight:bold; color:#1E2A22;">${esc(buildingName)} invites you to complete this induction</p>
              <p style="margin:0 0 24px; font-size:15px; color:#1E2A22; line-height:1.5;">This is an important part of ${esc(buildingName)}'s waste management program.</p>
              <!--[if mso]>
              <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="padding-bottom:20px;">
              <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${esc(link)}" style="height:44px;v-text-anchor:middle;width:220px;" arcsize="14%" strokecolor="#2F6F4E" fillcolor="#2F6F4E">
                <w:anchorlock/>
                <center style="color:#FFFFFF;font-family:'Helvetica Neue',Arial,sans-serif;font-size:14px;font-weight:bold;">Start the induction &rarr;</center>
              </v:roundrect>
              </td></tr></table>
              <![endif]-->
              <!--[if !mso]><!-->
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
                <tr><td bgcolor="#2F6F4E" style="background:#2F6F4E; border-radius:6px; padding:0;">
                  <a href="${esc(link)}" style="display:inline-block; padding:12px 24px; font-size:14px; font-weight:bold; color:#FFFFFF; text-decoration:none;">Start the induction &rarr;</a>
                </td></tr>
              </table>
              <!--<![endif]-->
              <p style="margin:0 0 24px; font-size:12px; color:#4A5850; word-break:break-all;">Or copy this link: ${esc(link)}</p>
              <p style="margin:0; font-size:15px; color:#1E2A22; line-height:1.5;">Thanks for helping keep ${esc(buildingName)} sorting waste correctly.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 32px; border-top:1px solid #DEDACB;">
              <p style="margin:0; font-size:11px; color:#4A5850;">Tradeflex &middot; Integrated Facilities Services</p>
            </td>
          </tr>
        </table>
      </td></tr>
    </table>
  `;
  const text = `${buildingName} invites you to complete this induction.\n\nThis is an important part of ${buildingName}'s waste management program.\n\nStart here: ${link}\n\nThanks for helping keep ${buildingName} sorting waste correctly.`;
  return { subject, html, text };
}

// maxInstances/concurrency: buildTransporter() opens a fresh SMTP connection per call with no
// shared pool or global limiter - left uncapped, this could scale to 20 instances x 80 concurrent
// requests each (Cloud Functions v2's own defaults), opening far more parallel SMTP connections
// than a single mailbox's SMTP AUTH throttling on Microsoft 365 can take, surfacing as generic
// send failures with no specific handling. Capped low enough that a real burst (e.g. a company-
// wide rollout finishing around the same time) gets naturally queued/serialized instead - real
// scale here is dozens-to-low-hundreds of sends per rollout, not thousands, so this costs nothing
// in practice while bounding the worst case.
exports.sendInductionEmail = onCall(
  { secrets: [SMTP_USERNAME, SMTP_PASSWORD, SMTP_SENDER_MAILBOX], maxInstances: 3, concurrency: 5 },
  async (request) => {
    await assertIsAdmin(request.auth);
    const payload = validatePayload(request.data);
    await checkRateLimit(request.auth.token.email);
    const { subject, html, text } = buildInductionEmailContent(payload);
    await sendViaSmtp({ to: payload.to, subject, html, text, attachments: EMAIL_LOGO_ATTACHMENTS });
    return { ok: true };
  }
);

// sendDistributionFlyer — Workstream 13, Part 2: a "distribution kit" for the building manager,
// not a bare flyer-only email. Sent to the building's own managerEmails and reuses the exact
// same branded induction-invitation body already built/Outlook-tested for sendInductionEmail
// above (buildInductionEmailContent) - no new body copy to write or approve. The only two things
// unique to this send: the subject line, and the printable A5 flyer PDF (buildFlyerPdf,
// functions/flyer.js) attached on top. Same onCall+assertIsAdmin+checkRateLimit template as
// sendInductionEmail, and shares its rate-limit bucket (one shared per-admin budget for
// induction-related sends, not a separate one per feature).
//
// Payload trust level matches sendInductionEmail's own validatePayload (format-checked only, no
// server-side program lookup - buildingId/programFile/programName are all values this app itself
// generated, e.g. currentProgram.file/name from the programs catalog and a real building id) -
// consistent with the existing function, not a stricter one-off. What DOES get freshly re-read
// from Firestore here, never trusted from the client, is the building's real name and
// managerEmails - same "never trust client-supplied name/emails" principle
// deleteBuildingPermanently applies to its own confirmName check further down.
function validateFlyerPayload(data) {
  const { buildingId, programFile, programName } = data || {};
  // BUILDING_ID_PATTERN is declared further down (shared with deleteBuildingPermanently/
  // refreshBintrackerData) - a plain module-scope const, already initialized by the time any
  // exported onCall handler actually runs, since the whole module finishes loading first.
  if (typeof buildingId !== 'string' || !BUILDING_ID_PATTERN.test(buildingId)) {
    throw new HttpsError('invalid-argument', 'A valid building id is required.');
  }
  if (typeof programFile !== 'string' || !programFile || programFile.length > MAX_NAME_LENGTH) {
    throw new HttpsError('invalid-argument', 'A program file is required.');
  }
  if (typeof programName !== 'string' || !programName || programName.length > MAX_NAME_LENGTH) {
    throw new HttpsError('invalid-argument', 'A program name is required.');
  }
  return { buildingId, programFile, programName };
}

// The platform's default Hosting URL for this project - the same one every page in this app
// links back to (see outputs/*.html's own "esg-1-98f35.web.app/.firebaseapp.com" comments). Not
// its own secret/config value since there's only ever been one deployment target.
const PUBLIC_BASE_URL = 'https://esg-1-98f35.web.app/';

exports.sendDistributionFlyer = onCall(
  { secrets: [SMTP_USERNAME, SMTP_PASSWORD, SMTP_SENDER_MAILBOX], maxInstances: 3, concurrency: 5 },
  async (request) => {
    await assertIsAdmin(request.auth);
    const { buildingId, programFile, programName } = validateFlyerPayload(request.data);
    await checkRateLimit(request.auth.token.email);

    const buildingSnap = await admin.firestore().doc(`buildings/${buildingId}`).get();
    if (!buildingSnap.exists) {
      throw new HttpsError('not-found', 'No building found for that id.');
    }
    const building = buildingSnap.data();
    const buildingName = building.name || '(untitled)';
    // Unlike sendInductionEmail's `to` (checked by validatePayload before this function ever
    // sees it), managerEmails comes straight off a Firestore doc with no format/size gate of its
    // own — buildings writes are admin-only, but nothing stops a malformed value (a stray typo,
    // a paste error, or a future buggy code path) from being saved. Filter to well-formed
    // addresses and cap the count the same way validatePayload does for every other email send,
    // so a bad/oversized value here can't reach nodemailer's address-parsing path unfiltered.
    const managerEmails = (building.managerEmails || [])
      .filter(isValidEmail)
      .slice(0, MAX_RECIPIENTS);
    // Graceful absence, same as every other email feature in this app - no manager contacts
    // saved yet means there's genuinely nobody to send this to.
    if (managerEmails.length === 0) {
      throw new HttpsError('failed-precondition', 'This building has no manager contact emails saved yet.');
    }

    // The exact same whole-building link shown in the panel (pageBaseUrl() + currentProgram.file
    // + '?b=' + buildingId, admin-distribution.html), built server-side from the platform's own
    // Hosting URL instead of trusting a client-supplied link string.
    const link = `${PUBLIC_BASE_URL}${programFile}?b=${buildingId}`;
    const { html, text } = buildInductionEmailContent({ buildingName, programName, link });
    const subject = `Recycling induction & distribution flyer - ${buildingName}`;
    const flyerPdf = await buildFlyerPdf({ buildingName, link });

    await sendViaSmtp({
      to: managerEmails,
      subject,
      html,
      text,
      attachments: [
        ...EMAIL_LOGO_ATTACHMENTS,
        { filename: `${buildingName} - distribution flyer.pdf`, content: flyerPdf, contentType: 'application/pdf' },
      ],
    });
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
// Follow-up fix #6 (2026-09-29): hand-copied from this app's own CSS tokens
// (--gw/--mr/--pc/--og/--ew in recycling-training.html's :root) - a Cloud Function has no CSS to
// read them from, so these are duplicated, not derived/shared (same pattern as functions/flyer.js
// hand-copying its own color constants).
const STREAM_COLORS = { gw: '#8C2F39', mr: '#C98E12', pc: '#2B5C8A', og: '#5C7A29', ew: '#5B4B8A' };
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
    ? "Passed - solid grasp of what doesn't belong."
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

  // No card background — just a colored rule on the left of each item, sitting directly on the
  // cream card behind it (a solid white box per item read as too stark). Each item is its own
  // row in ONE outer table, with the gap between items as padding-bottom on the wrapping <td>
  // rather than margin-bottom on each item's own inner table — Outlook ignores margin on tables
  // (confirmed via a real send, 2026-09-23: items rendered with no gap and one continuous left
  // border instead of one per item), but padding on a <td> is well supported. Follow-up fix #6
  // (2026-09-29): the rule color now matches each item's own waste stream (STREAM_COLORS) instead
  // of being hardcoded green for every item, regardless of stream - a fallback to the old green
  // covers the never-expected case of a missing/unrecognized stream code.
  const missedHtml = missed.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${
        missed.map((it, i) => `
          <tr><td style="border-left:3px solid ${STREAM_COLORS[it.stream] || '#2F6F4E'}; padding-left:16px;">
            <p style="margin:0 0 4px; font-size:14px; font-weight:bold; color:#1E2A22;">${esc(it.name)}</p>
            <p style="margin:0; font-size:13px; color:#4A5850; line-height:1.4;">${esc(it.explain)}</p>
          </td></tr>
          ${i < missed.length - 1 ? '<tr><td style="height:14px; line-height:14px; font-size:0;">&nbsp;</td></tr>' : ''}
        `).join('')
      }</table>`
    : '<p style="margin:0; font-size:14px; color:#4A5850;">Nothing missed - every item was sorted correctly.</p>';
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
              <p style="margin:0; font-size:11px; color:#4A5850;">Tradeflex &middot; Integrated Facilities Services</p>
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

// Same concurrency cap and reasoning as sendInductionEmail above - this one has no admin-side
// rate limit to fall back on (its cap is per-submission instead), so bounding total concurrent
// SMTP connections here matters just as much.
exports.sendMyResultEmail = onCall(
  { secrets: [SMTP_USERNAME, SMTP_PASSWORD, SMTP_SENDER_MAILBOX], maxInstances: 3, concurrency: 5 },
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
      // cap. Wrapped in a real try/catch (not just a Promise .catch()) — a .catch() only attaches
      // to a promise that already exists, so if constructing the update payload itself threw
      // synchronously, that throw would escape uncaught and silently replace the real send error
      // the caller is supposed to see.
      try {
        await ref.update({ sendCount: FieldValue.increment(-1) });
      } catch (giveBackErr) {
        console.error('Failed to give back sendCount after a failed send:', giveBackErr && giveBackErr.message);
      }
      throw err;
    }
    return { ok: true };
  }
);

// deleteBuildingPermanently — the real, irreversible delete behind admin-buildings.html's
// "Delete permanently" button (Workstream 10). Admin-only, and only ever wipes a building that's
// already been archived (active:false) first — the client UI only ever shows this button on an
// archived row, and this function enforces the same rule server-side, so even a direct callable
// invocation can't skip the archive-first safety gate.
//
// links and attempts both have `allow delete: if false` in firestore.rules, denied to every
// client including admins, by deliberate design — that rule is NOT being loosened. Only the
// Admin SDK (used here) bypasses Firestore rules, so this is the one narrow, admin-authenticated,
// name-confirmed path that can actually remove them. Every other collection below (submissions,
// enrollments, buildingAccess, tenants) IS technically client-deletable today too, but the whole
// cascade is kept here in one function anyway, for one atomic-in-spirit, fully audit-logged job
// instead of a split client/server delete path.
const BUILDING_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

// Loops a `where(buildingId==X).limit(400)` query to chunked batch deletes until the collection
// is empty. 400 (not Firestore's 500-per-commit cap) leaves headroom so one .get() maps 1:1 to
// one .batch().commit(). Looping-to-empty (not computing a total up front) makes this naturally
// retriable if the function times out mid-collection — a retry just re-queries and keeps finding/
// deleting whatever's left, since already-deleted docs never come back in a later page.
async function deleteAllMatchingBuildingId(collectionName, buildingId) {
  const db = admin.firestore();
  let deleted = 0;
  for (;;) {
    const snap = await db.collection(collectionName).where('buildingId', '==', buildingId).limit(400).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    deleted += snap.docs.length;
  }
  return deleted;
}

exports.deleteBuildingPermanently = onCall({ timeoutSeconds: 300, maxInstances: 3, concurrency: 5 }, async (request) => {
  await assertIsAdmin(request.auth);
  await checkRateLimitGeneric('deleteRateLimits', request.auth.token.email, DELETE_RATE_LIMIT_WINDOW_MS, DELETE_RATE_LIMIT_MAX_CALLS, 'permanent deletes');

  const { buildingId, confirmName } = request.data || {};
  if (typeof buildingId !== 'string' || !BUILDING_ID_PATTERN.test(buildingId)) {
    throw new HttpsError('invalid-argument', 'A valid building id is required.');
  }

  const buildingRef = admin.firestore().doc(`buildings/${buildingId}`);
  const buildingSnap = await buildingRef.get();
  if (!buildingSnap.exists) {
    throw new HttpsError('not-found', 'No building found for that id.');
  }
  const building = buildingSnap.data();

  if (building.active !== false) {
    throw new HttpsError('failed-precondition', 'Archive this building first, then delete it permanently from the Archived buildings tab.');
  }

  const realName = String(building.name || '').trim();
  if (String(confirmName || '').trim() !== realName) {
    throw new HttpsError('failed-precondition', 'Typed name does not match. Nothing was deleted.');
  }

  // Children before the parent building doc — if this crashes partway through, the building doc
  // (and whatever's already deleted) is a safely retriable state: nothing is left orphaned under
  // a vanished building, since the building itself is only removed once every child is gone.
  const deletedCounts = {
    submissions: await deleteAllMatchingBuildingId('submissions', buildingId),
    attempts: await deleteAllMatchingBuildingId('attempts', buildingId),
    links: await deleteAllMatchingBuildingId('links', buildingId),
    enrollments: await deleteAllMatchingBuildingId('enrollments', buildingId),
    buildingAccess: await deleteAllMatchingBuildingId('buildingAccess', buildingId),
    bintrackerRows: await deleteAllMatchingBuildingId('bintrackerRows', buildingId),
    bintrackerTenantMatches: await deleteAllMatchingBuildingId('bintrackerTenantMatches', buildingId),
  };

  const tenantsSnap = await buildingRef.collection('tenants').get();
  deletedCounts.tenants = tenantsSnap.size;
  await admin.firestore().recursiveDelete(buildingRef);

  return { ok: true, buildingName: realName, deletedCounts };
});

// refreshBintrackerData — Workstream 7, Point 1 in the plan: pulls real waste-collection data
// from Bintracker's Data Sharing API for one building, over an admin-picked date range (the SAME
// range the calling report is already showing, so the induction-quiz side and the real-data side
// never silently desync), maps each row's wasteType to our 5 core streams (anything unmapped is
// silently dropped, never forced into an "other" bucket), and stores it for the comparison
// feature (Phase C) to read. This is on-demand (an admin clicks "Refresh"), not scheduled -
// firebase-functions/v2/scheduler is a new pattern this codebase doesn't use anywhere yet, and
// proving the on-demand path first is the deliberate, lower-risk choice (see the plan).
function bintrackerRowDocId(buildingId, collectDate, tenantRaw, locationRaw, wasteTypeRaw) {
  const key = [buildingId, collectDate, tenantRaw, locationRaw, wasteTypeRaw].join('__');
  return crypto.createHash('sha256').update(key).digest('hex');
}

// Recycling-level aggregate (Workstream 7 Point 5 sub-idea, 2026-09-24; population split revised
// 2026-10-05): a single cached percentage the trainee-facing id-gate reads directly off the
// building/tenant doc it already fetches - never a live call from the trainee's own page load.
// Computed from the building's FULL current bintrackerRows set (not just one refresh call's
// fromDate/toDate slice) - a refresh of one range shouldn't silently narrow what the id-gate shows
// about the building/tenant overall. Factored out of refreshBintrackerData itself (which also does
// the real network fetch, untestable without hitting Bintracker's live API) so this half - pure
// Firestore read/write against already-seeded bintrackerRows/bintrackerTenantMatches - can be
// exercised directly by tests/functions-refreshbintrackerdata.test.js against the Firestore
// emulator, exported below.
//
// Building-level uses EXTERNAL rows (externalOnly:true) - the official, contractor-weighed export.
// Tenant-level uses INTERNAL rows (externalOnly:false) for that tenant - confirmed directly with
// the user 2026-10-05 that Bintracker has no per-tenant external weighing at all (a real check
// against Tower 2 - Collins Square's production data found literally zero of its 13 real tenants
// had any externalOnly:true rows - only a single building-wide waste-consolidation entry did), so
// internal/per-floor data is the only population a tenant-level figure can ever be computed from.
//
// Bounded to the trailing 365 days (added 2026-10-06): NABERS' own definition says the recycling
// rate is "based on 12 months of waste data" - without this bound, the figure would slowly dilute
// with ever-older history instead of reflecting recent performance. Computed fresh on every call
// (never a stored/cached cutoff), so it always means "the last 365 days from right now."
async function writeRecyclingLevelAggregates(db, buildingId) {
  const buildingRef = db.collection('buildings').doc(buildingId);
  const buildingSnap = await buildingRef.get();
  if (!buildingSnap.exists) return; // nothing to compute for a building that doesn't exist

  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setDate(twelveMonthsAgo.getDate() - 365);
  const twelveMonthsAgoStr = twelveMonthsAgo.toISOString().slice(0, 10);
  const allRowsSnap = await db.collection('bintrackerRows')
    .where('buildingId', '==', buildingId)
    .where('collectDate', '>=', twelveMonthsAgoStr)
    .get();
  const allRows = allRowsSnap.docs.map((d) => d.data());
  const buildingPct = computeRecyclingLevelPct(allRows.filter((r) => r.externalOnly === true));
  // FieldValue.delete() when the current data no longer qualifies (e.g. a stale number from an
  // earlier, richer date range) - graceful absence beats a stale/misleading number left behind.
  await buildingRef.update({
    recyclingLevelPct: buildingPct === null ? FieldValue.delete() : buildingPct,
  });

  const confirmedMatchesSnap = await db.collection('bintrackerTenantMatches')
    .where('buildingId', '==', buildingId)
    .where('status', '==', 'confirmed')
    .get();
  for (const matchDoc of confirmedMatchesSnap.docs) {
    const match = matchDoc.data();
    // Case-sensitive exact match against the admin-confirmed raw string - this is the only link
    // between a real Bintracker tenant string and one of this app's own tenant docs. Internal rows
    // only (externalOnly:false) - see the function-level comment above for why.
    const tenantRows = allRows.filter((r) => r.bintrackerTenantRaw === match.bintrackerTenantRaw && r.externalOnly === false);
    const tenantPct = computeRecyclingLevelPct(tenantRows);
    const tenantRef = db.collection('buildings').doc(buildingId).collection('tenants').doc(match.tenantId);
    const tenantSnap = await tenantRef.get();
    if (!tenantSnap.exists) continue; // stale match pointing at a since-deleted tenant doc
    await tenantRef.update({
      recyclingLevelPct: tenantPct === null ? FieldValue.delete() : tenantPct,
    });
  }
}

// Same "delete existing docs matching a query, then write fresh ones" idiom as
// deleteAllMatchingBuildingId above, scoped by buildingId + a collectDate range instead of just
// buildingId - keeps a re-run of "Refresh" for the same building/range provably current instead
// of trying to merge/dedupe against whatever a previous pull happened to store.
async function deleteBintrackerRowsInRange(buildingId, fromDate, toDate) {
  const db = admin.firestore();
  for (;;) {
    const snap = await db.collection('bintrackerRows')
      .where('buildingId', '==', buildingId)
      .where('collectDate', '>=', fromDate)
      .where('collectDate', '<=', toDate)
      .limit(400)
      .get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
}

exports.refreshBintrackerData = onCall(
  { secrets: [BINTRACKER_APP_ID, BINTRACKER_APP_KEY], timeoutSeconds: 300, maxInstances: 3, concurrency: 5 },
  async (request) => {
    await assertIsAdmin(request.auth);
    await checkRateLimitGeneric('bintrackerRateLimits', request.auth.token.email, BINTRACKER_RATE_LIMIT_WINDOW_MS, BINTRACKER_RATE_LIMIT_MAX_CALLS, 'Bintracker calls made');

    const { buildingId, fromDate, toDate } = request.data || {};
    if (typeof buildingId !== 'string' || !BUILDING_ID_PATTERN.test(buildingId)) {
      throw new HttpsError('invalid-argument', 'A valid building id is required.');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fromDate)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(toDate))) {
      throw new HttpsError('invalid-argument', 'fromDate and toDate must be YYYY-MM-DD.');
    }

    const buildingSnap = await admin.firestore().doc(`buildings/${buildingId}`).get();
    if (!buildingSnap.exists) throw new HttpsError('not-found', 'No building found for that id.');
    const bintrackerBuildingName = buildingSnap.data().bintrackerBuildingName;
    if (!bintrackerBuildingName) {
      throw new HttpsError('failed-precondition', 'No Bintracker mapping set for this building yet.');
    }

    const rawRows = await fetchBintrackerCollections({
      building: bintrackerBuildingName,
      collectDateFrom: fromDate,
      collectDateTo: toDate,
      appId: BINTRACKER_APP_ID.value(),
      appKey: BINTRACKER_APP_KEY.value(),
    });

    await deleteBintrackerRowsInRange(buildingId, fromDate, toDate);

    const db = admin.firestore();
    let rowsMapped = 0;
    let rowsSkipped = 0;
    const fetchedAt = FieldValue.serverTimestamp();
    for (let i = 0; i < rawRows.length; i += 400) {
      const chunk = rawRows.slice(i, i + 400);
      const batch = db.batch();
      for (const row of chunk) {
        const ourStream = mapWasteTypeToStream(row.wasteType);
        if (!ourStream) { rowsSkipped++; continue; }
        const collectDate = String(row.collectDate || '').slice(0, 10);
        const tenantRaw = row.tenant || '';
        const locationRaw = row.primaryLocation || '';
        const docId = bintrackerRowDocId(buildingId, collectDate, tenantRaw, locationRaw, row.wasteType);
        batch.set(db.collection('bintrackerRows').doc(docId), {
          buildingId,
          bintrackerTenantRaw: tenantRaw,
          bintrackerLocationRaw: locationRaw,
          ourStream,
          wasteTypeRaw: row.wasteType,
          contaminated: Boolean(row.contaminated),
          externalOnly: Boolean(row.externalOnly),
          wasteOutcome: typeof row.wasteOutcome === 'string' ? row.wasteOutcome : null,
          collectDate,
          weight: typeof row.weight === 'number' ? row.weight : (typeof row.actualWeight === 'number' ? row.actualWeight : null),
          fetchedAt,
        });
        rowsMapped++;
      }
      await batch.commit();
    }

    await writeRecyclingLevelAggregates(db, buildingId);

    return {
      ok: true,
      buildingName: bintrackerBuildingName,
      rowsFetched: rawRows.length,
      rowsMapped,
      rowsSkipped,
      dateRange: { fromDate, toDate },
    };
  }
);

// ---- Workstream 12: building/tenant catalog sync ----
// Keeps the app's OWN buildings/tenants catalog current using real Bintracker data as a
// suggestion source an admin reviews - never a silent overwrite. No new Firestore collection: all
// 3 functions below either do a pure read/diff (nothing persisted) or a single, explicit,
// admin-confirmed delete - there's nothing here that needs history the way the induction-vs-real-
// data comparison feature's bintrackerRows/bintrackerTenantMatches do.
// `syncBintrackerTenants`/`refreshBintrackerData` are scoped to ONE building (via
// request.building), so their per-call data volume stays small regardless of window length - they
// keep the full 30 days for better sample size. `discoverBintrackerBuildings` is different: it
// omits `building` entirely to pull EVERY building's rows in one unscoped call, and real
// production data (confirmed 2026-10-01) made that genuinely huge - 30 days x ~22 buildings
// weighed Monday-Friday was enough data that pagination couldn't finish inside the function's own
// timeout. It only needs to see each active building's name at least once, not build any
// statistic, so a much shorter window is correct here, not just a workaround - 10 calendar days
// always covers at least one full Mon-Fri business week even around a long weekend/public holiday.
function recentDayRange(days) {
  const toDate = new Date();
  const fromDate = new Date(toDate);
  fromDate.setDate(fromDate.getDate() - days);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { fromDate: fmt(fromDate), toDate: fmt(toDate) };
}

// discoverBintrackerBuildings — calls the Collections API with `request.building` omitted (see
// fetchBintrackerCollections's own comment), so it queries across every building the credentials
// can see, then surfaces any distinct `building` value not yet mapped to one of this app's own
// buildings via bintrackerBuildingName. Pure read - no Firestore writes.
//
// Found against real production data (2026-10-01): Bintracker's prod environment ignores
// request.pageSize entirely and always returns 1000 real, DISTINCT rows per page (confirmed via
// logging - no two pages were ever identical), so this can't rely on "stop when a page comes back
// short" or on detecting a repeated page - the data genuinely never runs out within any reasonable
// time. But this function only needs to see each real building's name once, not read every row -
// with ~22 total buildings, every name has almost certainly already shown up within the first
// couple of pages. The onPage callback below tracks the running count of distinct building names
// seen and stops once 5 consecutive pages add zero new ones, instead of fetching for minutes.
// Also filters to wasteType "General waste" (confirmed from a real row's exact casing) - virtually
// every commercial building generates some general waste, so this is very unlikely to miss a real
// building, while cutting out the Mixed Recycling/Organics/E-Waste rows that don't help this
// function at all and were making each page far bigger than it needed to be.
exports.discoverBintrackerBuildings = onCall(
  { secrets: [BINTRACKER_APP_ID, BINTRACKER_APP_KEY], timeoutSeconds: 300, maxInstances: 3, concurrency: 5 },
  async (request) => {
    await assertIsAdmin(request.auth);
    await checkRateLimitGeneric('bintrackerRateLimits', request.auth.token.email, BINTRACKER_RATE_LIMIT_WINDOW_MS, BINTRACKER_RATE_LIMIT_MAX_CALLS, 'Bintracker calls made');

    const { fromDate, toDate } = recentDayRange(10);
    const seenBuildingNames = new Set();
    let staleStreak = 0;
    const rawRows = await fetchBintrackerCollections({
      // `building` deliberately omitted - queries every building the credentials can see.
      wasteType: 'General waste',
      collectDateFrom: fromDate,
      collectDateTo: toDate,
      appId: BINTRACKER_APP_ID.value(),
      appKey: BINTRACKER_APP_KEY.value(),
      onPage: (pageRows) => {
        const before = seenBuildingNames.size;
        for (const row of pageRows) {
          const norm = row && row.building && normalizeForMatching(row.building);
          if (norm) seenBuildingNames.add(norm);
        }
        staleStreak = seenBuildingNames.size === before ? staleStreak + 1 : 0;
        // Started at 2 consecutive stale pages - too impatient in practice (2026-10-02): 4 real
        // buildings with lower-frequency collections didn't show up until later pages, so this
        // was stopping before they'd ever had a chance to appear. Bumped to 5 for more headroom.
        return staleStreak >= 5;
      },
    });

    const buildingsSnap = await admin.firestore().collection('buildings').get();
    const existingBintrackerBuildingNames = buildingsSnap.docs
      .map((d) => d.data().bintrackerBuildingName)
      .filter(Boolean);

    const discoveredBuildingNames = diffDiscoveredBuildingNames(rawRows, existingBintrackerBuildingNames);

    // Follow-up fix (2026-09-30): also return each discovered building's own tenants, reusing the
    // exact same rawRows already fetched above (nothing new to call Bintracker for) and the same
    // diffBintrackerTenants() helper syncBintrackerTenants already uses - passing an EMPTY
    // existingTenants list means every (tenant, location) pair found is classified as "new",
    // which is exactly right here (this building doesn't exist in our system yet, so nothing can
    // already be missing or mismatched). This lets the admin pick which tenants to bring in
    // at the same moment they add the building, instead of a separate later "Synchronize" trip.
    const discoveredBuildings = discoveredBuildingNames.map((name) => {
      const normName = normalizeForMatching(name);
      const rowsForBuilding = rawRows.filter((row) => normalizeForMatching(row && row.building) === normName);
      const { newTenants } = diffBintrackerTenants(rowsForBuilding, []);
      return { name, tenants: newTenants };
    });
    return { discoveredBuildings };
  }
);

// syncBintrackerTenants — fetches the last 30 days of Collections for one building's mapped
// name, and diffs the distinct (tenant, primaryLocation) pairs seen against that building's REAL,
// active tenants subcollection using the shared fuzzy-matching helper (diffBintrackerTenants,
// functions/bintracker.js). Pure read/diff - no Firestore writes at all. Every admin action on the
// result (import a new tenant, delete a missing one, update a level) is a separate, explicit
// follow-up: import/update are plain client-side Firestore writes the admin's own browser already
// has permission to make (see firestore.rules' buildings/{id}/tenants write rule); only the
// delete needs its own Cloud Function (deleteTenantPermanently, below), since submissions/attempts
// both have `allow delete: if false` for every client, admins included.
exports.syncBintrackerTenants = onCall(
  { secrets: [BINTRACKER_APP_ID, BINTRACKER_APP_KEY], timeoutSeconds: 300, maxInstances: 3, concurrency: 5 },
  async (request) => {
    await assertIsAdmin(request.auth);
    await checkRateLimitGeneric('bintrackerRateLimits', request.auth.token.email, BINTRACKER_RATE_LIMIT_WINDOW_MS, BINTRACKER_RATE_LIMIT_MAX_CALLS, 'Bintracker calls made');

    const { buildingId } = request.data || {};
    if (typeof buildingId !== 'string' || !BUILDING_ID_PATTERN.test(buildingId)) {
      throw new HttpsError('invalid-argument', 'A valid building id is required.');
    }

    const buildingRef = admin.firestore().doc(`buildings/${buildingId}`);
    const buildingSnap = await buildingRef.get();
    if (!buildingSnap.exists) throw new HttpsError('not-found', 'No building found for that id.');
    const bintrackerBuildingName = buildingSnap.data().bintrackerBuildingName;
    if (!bintrackerBuildingName) {
      throw new HttpsError('failed-precondition', 'No Bintracker mapping set for this building yet.');
    }

    const { fromDate, toDate } = recentDayRange(30);
    const rawRows = await fetchBintrackerCollections({
      building: bintrackerBuildingName,
      collectDateFrom: fromDate,
      collectDateTo: toDate,
      appId: BINTRACKER_APP_ID.value(),
      appKey: BINTRACKER_APP_KEY.value(),
    });

    const tenantsSnap = await buildingRef.collection('tenants').get();
    const existingTenants = tenantsSnap.docs
      .filter((d) => d.data().active !== false)
      .map((d) => ({ id: d.id, name: d.data().name || '', levels: d.data().levels || [] }));

    const { newTenants, missingTenants, levelMismatches } = diffBintrackerTenants(rawRows, existingTenants);
    return { newTenants, missingTenants, levelMismatches, dateRange: { fromDate, toDate } };
  }
);

// Same chunked delete-in-batches idiom as deleteAllMatchingBuildingId above, scoped by tenantId
// instead of buildingId. tenantIds are always crypto.randomUUID() values (see
// admin-buildings.html's add-tenant/import-from-Excel handlers), so a single-field equality query
// is unambiguous across the whole submissions/attempts collections without also filtering by
// buildingId.
async function deleteAllMatchingTenantId(collectionName, tenantId) {
  const db = admin.firestore();
  let deleted = 0;
  for (;;) {
    const snap = await db.collection(collectionName).where('tenantId', '==', tenantId).limit(400).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    deleted += snap.docs.length;
  }
  return deleted;
}

// deleteTenantPermanently — the real, irreversible delete behind the Bintracker Sync tab's
// "Delete" action on a tenant Bintracker hasn't seen in 30 days. Admin-only, name-confirmed
// server-side exactly like deleteBuildingPermanently above - but deliberately does NOT require
// the tenant to be inactive first (unlike that function's archive-first gate on a building): this
// is invoked from a dedicated, already-deliberate sync/audit action that already has its own
// name-confirmation step, so an extra archive-first gate would add friction without adding real
// safety here (2026-09-28 design decision, confirmed with the user - not an oversight).
exports.deleteTenantPermanently = onCall({ timeoutSeconds: 300, maxInstances: 3, concurrency: 5 }, async (request) => {
  await assertIsAdmin(request.auth);
  await checkRateLimitGeneric('deleteRateLimits', request.auth.token.email, DELETE_RATE_LIMIT_WINDOW_MS, DELETE_RATE_LIMIT_MAX_CALLS, 'permanent deletes');

  const { buildingId, tenantId, confirmName } = request.data || {};
  if (typeof buildingId !== 'string' || !BUILDING_ID_PATTERN.test(buildingId)) {
    throw new HttpsError('invalid-argument', 'A valid building id is required.');
  }
  if (typeof tenantId !== 'string' || tenantId.length === 0 || tenantId.length > 200) {
    throw new HttpsError('invalid-argument', 'A valid tenant id is required.');
  }

  const tenantRef = admin.firestore().doc(`buildings/${buildingId}/tenants/${tenantId}`);
  const tenantSnap = await tenantRef.get();
  if (!tenantSnap.exists) {
    throw new HttpsError('not-found', 'No tenant found for that id.');
  }
  const tenant = tenantSnap.data();

  const realName = String(tenant.name || '').trim();
  if (String(confirmName || '').trim() !== realName) {
    throw new HttpsError('failed-precondition', 'Typed name does not match. Nothing was deleted.');
  }

  // Children before the parent tenant doc - same retriable-on-crash reasoning as
  // deleteBuildingPermanently's own ordering. links and bintrackerTenantMatches both carry their
  // own tenantId field (links: {programId, buildingId, tenantId, createdAt, expiresAt?} - see
  // admin-distribution.html's link-generation writes; bintrackerTenantMatches: written by
  // admin-buildings.html's match-review UI) - added after a real gap found in a pre-production
  // audit: without these, a tenant-scoped distribution link outlives the tenant it was scoped to
  // (still publicly readable and resolvable at ?l=<linkId>, since firestore.rules only checks
  // tenantId is a well-formed string, never that the tenant still exists), and a stale
  // bintrackerTenantMatches doc lingers as a permanent, invisible record of a tenant that's gone.
  const deletedCounts = {
    submissions: await deleteAllMatchingTenantId('submissions', tenantId),
    attempts: await deleteAllMatchingTenantId('attempts', tenantId),
    links: await deleteAllMatchingTenantId('links', tenantId),
    bintrackerTenantMatches: await deleteAllMatchingTenantId('bintrackerTenantMatches', tenantId),
  };
  await tenantRef.delete();

  return { ok: true, tenantName: realName, deletedCounts };
});

// Builds the branded "set your password" invite email, sent whenever a Super Admin/Admin adds a
// new person via the Roles screen (Workstream 15, Part 3). Shares the exact same scaffold as
// buildInductionEmailContent above (same logos/VML bulletproof button/footer, same reasoning for
// the web-safe font over the app's own Gilroy). `role` is 'administrator' or 'user' - deliberately
// NOT 'standard user' in this copy (the user felt "standard user" read a little cold/technical for
// an email addressed to a real person, confirmed 2026-10-06 - "Standard User" stays as the label
// inside the Roles screen itself, just not in this message).
function buildAccountInviteContent({ role, link }) {
  const subject = 'Your Recycling Training account is ready';
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
              <p style="margin:0 0 8px; font-size:15px; letter-spacing:0.4px; text-transform:uppercase; color:#2F6F4E; font-weight:bold;">RECYCLING TRAINING</p>
              <p style="margin:0 0 16px; font-size:20px; font-weight:bold; color:#1E2A22;">Your account is ready - just set a password</p>
              <p style="margin:0 0 24px; font-size:15px; color:#1E2A22; line-height:1.5;">You've been given ${esc(role)} access to Recycling Training, Tradeflex's waste-sorting induction and reporting tool. Choose a password below to finish setting up your account and sign in.</p>
              <!--[if mso]>
              <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="padding-bottom:20px;">
              <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${esc(link)}" style="height:44px;v-text-anchor:middle;width:220px;" arcsize="14%" strokecolor="#2F6F4E" fillcolor="#2F6F4E">
                <w:anchorlock/>
                <center style="color:#FFFFFF;font-family:'Helvetica Neue',Arial,sans-serif;font-size:14px;font-weight:bold;">Set your password</center>
              </v:roundrect>
              </td></tr></table>
              <![endif]-->
              <!--[if !mso]><!-->
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
                <tr><td bgcolor="#2F6F4E" style="background:#2F6F4E; border-radius:6px; padding:0;">
                  <a href="${esc(link)}" style="display:inline-block; padding:12px 24px; font-size:14px; font-weight:bold; color:#FFFFFF; text-decoration:none;">Set your password</a>
                </td></tr>
              </table>
              <!--<![endif]-->
              <p style="margin:0 0 24px; font-size:12px; color:#4A5850; word-break:break-all;">Or copy this link: ${esc(link)}</p>
              <p style="margin:0; font-size:15px; color:#1E2A22; line-height:1.5;">If you weren't expecting this, you can safely ignore this email.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 32px; border-top:1px solid #DEDACB;">
              <p style="margin:0; font-size:11px; color:#4A5850;">Tradeflex &middot; Integrated Facilities Services</p>
            </td>
          </tr>
        </table>
      </td></tr>
    </table>
  `;
  const text = `Your account is ready - just set a password.\n\nYou've been given ${role} access to Recycling Training, Tradeflex's waste-sorting induction and reporting tool. Set your password here: ${link}\n\nIf you weren't expecting this, you can safely ignore this email.`;
  return { subject, html, text };
}

// Creates a Firebase Authentication account for a newly-added Admin/Standard user (if one doesn't
// already exist) and emails them a link to set their own password - the one piece that used to
// require a manual trip to the Firebase Console (Workstream 15, Part 3: centralize account
// creation in the app, no more Console step for anyone). Deliberately narrow: this function ONLY
// creates the Auth account and sends the invite - it never touches /admins, /superAdmins, or
// /buildingAccess itself. Those writes happen client-side from the Roles screen immediately after
// this call succeeds, gated by firestore.rules (isSuperAdmin() for /admins and /superAdmins,
// isAllowedReviewer() for /buildingAccess) rather than re-implemented here - same "function does
// the risky Admin-SDK-only part, client does the data part under rules" split already used
// elsewhere in this file (e.g. deleteTenantPermanently vs. its caller).
exports.provisionUserAccount = onCall(
  { secrets: [SMTP_USERNAME, SMTP_PASSWORD, SMTP_SENDER_MAILBOX], timeoutSeconds: 60, maxInstances: 3, concurrency: 5 },
  async (request) => {
    await assertIsAdmin(request.auth);
    await checkRateLimitGeneric('provisionRateLimits', request.auth.token.email, PROVISION_RATE_LIMIT_WINDOW_MS, PROVISION_RATE_LIMIT_MAX_CALLS, 'accounts provisioned');

    const { email, role } = request.data || {};
    if (!isValidEmail(email)) {
      throw new HttpsError('invalid-argument', 'A valid email address is required.');
    }
    if (role !== 'administrator' && role !== 'user') {
      throw new HttpsError('invalid-argument', "role must be 'administrator' or 'user'.");
    }

    let alreadyExisted = true;
    try {
      await admin.auth().getUserByEmail(email);
    } catch (err) {
      if (err.code !== 'auth/user-not-found') throw err;
      alreadyExisted = false;
      await admin.auth().createUser({ email });
    }

    // The account itself (the part that used to require a manual Firebase Console trip) is the
    // real, hard-to-reverse-later side effect worth protecting - a flaky SMTP send must not throw
    // the account creation away with it. sendViaSmtp() is deliberately NOT awaited inside this
    // function's own try/catch the way every other email function in this file does it (those all
    // treat the send as the function's one purpose, so a failed send IS a failed call) - here the
    // send is a courtesy on top of the real job, so its failure becomes a soft `emailSent:false`
    // in the response instead of an HttpsError, and the caller still proceeds to grant the role.
    const link = await admin.auth().generatePasswordResetLink(email);
    const { subject, html, text } = buildAccountInviteContent({ role, link });
    let emailSent = true;
    try {
      await sendViaSmtp({ to: email, subject, html, text, attachments: EMAIL_LOGO_ATTACHMENTS });
    } catch (err) {
      console.error('provisionUserAccount: account created but invite email failed to send:', err && err.message);
      emailSent = false;
    }

    return { ok: true, alreadyExisted, emailSent };
  }
);

// Exported purely for tests/functions-refreshbintrackerdata.test.js to call directly against the
// Firestore emulator (seeded bintrackerRows/bintrackerTenantMatches, no real Bintracker network
// call) - neither is a Cloud Functions trigger itself, so `firebase deploy --only functions`
// skips both (they aren't shaped like one - no onCall/onRequest wrapper), same as any other plain
// named export would be. `_getAdminFirestoreForTests` (a plain function, not the raw `admin`
// module object) is exported so the test can get a Firestore handle without needing
// firebase-admin installed in its own node_modules (only functions/node_modules has it - resolved
// here via this file's own require) - exporting the raw `admin` object itself was tried first and
// broke the Functions emulator's own codebase loader (`RangeError: Maximum call stack size
// exceeded` in firebase-functions' export-analysis step, tripping over admin SDK's internal
// circular references) - a plain function has nothing for that analysis to recurse into.
exports._writeRecyclingLevelAggregates = writeRecyclingLevelAggregates;
exports._getAdminFirestoreForTests = () => admin.firestore();
exports._getAdminAuthForTests = () => admin.auth();
