// sendInductionEmail — relays an induction link to a tenant's saved contact emails via SMTP
// AUTH against Exchange Online (a mailbox's own username/password, no Entra ID app
// registration), so the admin panel's "Send via email" button sends for real instead of just
// opening a mailto: draft.
//
// Not deployable yet: needs the Firebase project on the Blaze plan (required for any Cloud
// Function to make outbound network calls, regardless of what it sends through), and the three
// secrets below set via `firebase functions:secrets:set`. On the Microsoft 365 side, whoever
// administers the tenant also needs to explicitly enable SMTP AUTH for the sending mailbox
// (`Set-CASMailbox -Identity <mailbox> -SmtpClientAuthenticationDisabled $false`) — it's
// disabled tenant-wide by default now, and Security Defaults/Conditional Access can block
// legacy auth entirely regardless of that per-mailbox setting, which would need a separate
// tenant-level exception. SMTP_SENDER_MAILBOX is kept as its own secret (not reused from
// SMTP_USERNAME) so the same setup also covers a licensed user with "Send As" permission on a
// shared mailbox, authenticating with their own credentials but sending as the shared address.
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const { catalog } = require('./catalog');

admin.initializeApp();

const SMTP_USERNAME = defineSecret('SMTP_USERNAME');
const SMTP_PASSWORD = defineSecret('SMTP_PASSWORD');
const SMTP_SENDER_MAILBOX = defineSecret('SMTP_SENDER_MAILBOX');

// Same OWNER_EMAIL as outputs/sorting-station-report.html — kept in sync by hand, there's no
// shared module between the static site and this function. A client-side admin check is only
// ever a UI convenience, never real security, so this is verified again here.
const OWNER_EMAIL = 'esgtradeflex@gmail.com';

const MAX_RECIPIENTS = 20;
const MAX_SUBJECT_LENGTH = 300;
const MAX_TEXT_LENGTH = 20000;

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

function validatePayload(data) {
  const { to, subject, text } = data || {};
  if (!Array.isArray(to) || to.length === 0 || to.length > MAX_RECIPIENTS) {
    throw new HttpsError('invalid-argument', `Provide 1-${MAX_RECIPIENTS} recipient addresses.`);
  }
  if (!to.every(isValidEmail)) {
    throw new HttpsError('invalid-argument', 'One or more recipient addresses are invalid.');
  }
  if (!subject || !text) {
    throw new HttpsError('invalid-argument', 'A subject and message body are required.');
  }
  if (String(subject).length > MAX_SUBJECT_LENGTH) {
    throw new HttpsError('invalid-argument', `Subject must be ${MAX_SUBJECT_LENGTH} characters or fewer.`);
  }
  if (String(text).length > MAX_TEXT_LENGTH) {
    throw new HttpsError('invalid-argument', `Message body must be ${MAX_TEXT_LENGTH} characters or fewer.`);
  }
  return { to, subject, text };
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

async function sendViaSmtp({ to, subject, text, html }) {
  const transporter = buildTransporter();
  try {
    await transporter.sendMail({ from: SMTP_SENDER_MAILBOX.value(), to, subject, text, html });
  } catch (err) {
    console.error('SMTP send failed:', err && err.message);
    throw new HttpsError('internal', 'The mail server rejected the send.');
  }
}

exports.sendInductionEmail = onCall(
  { secrets: [SMTP_USERNAME, SMTP_PASSWORD, SMTP_SENDER_MAILBOX] },
  async (request) => {
    await assertIsAdmin(request.auth);
    const payload = validatePayload(request.data);
    await checkRateLimit(request.auth.token.email);
    await sendViaSmtp(payload);
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

  const streamHtml = streamRows
    .map((s) => `<tr><td style="padding:6px 0;">${esc(s.name)}</td><td style="padding:6px 0; text-align:right;">${s.pct}%</td></tr>`)
    .join('');
  const streamText = streamRows.map((s) => `${s.name}: ${s.pct}%`).join('\n');

  const missedHtml = missed.length
    ? missed.map((it) => `<li style="margin-bottom:10px;"><strong>${esc(it.name)}</strong> — ${esc(it.explain)}</li>`).join('')
    : '<li>Nothing missed — every item was sorted correctly.</li>';
  const missedText = missed.length
    ? missed.map((it) => `- ${it.name}: ${it.explain}`).join('\n')
    : 'Nothing missed - every item was sorted correctly.';

  const buildingLine = data.buildingName ? ` at ${esc(data.buildingName)}` : '';
  const buildingLineText = data.buildingName ? ` at ${data.buildingName}` : '';

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif; color:#1E2A22; max-width:560px;">
      <p>Hi ${esc(name)},</p>
      <p>Thanks for completing the Recycling Sorting induction${buildingLine}.</p>
      <h2 style="margin:20px 0 4px;">${score}%</h2>
      <p style="margin:0 0 20px; font-weight:bold;">${esc(verdict)}</p>
      <h3 style="margin-bottom:6px;">Accuracy by stream</h3>
      <table style="width:100%; border-collapse:collapse;">${streamHtml}</table>
      <h3 style="margin:20px 0 6px;">Items to review</h3>
      <ul style="padding-left:18px; margin:0;">${missedHtml}</ul>
      <p style="margin-top:24px;">Thanks again for taking the time to complete this induction.</p>
    </div>
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
    if (!isValidEmail(confirmedEmail)) {
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
    await sendViaSmtp({ to: confirmedEmail, subject: 'Your Recycling Sorting results', text, html });
    return { ok: true };
  }
);
