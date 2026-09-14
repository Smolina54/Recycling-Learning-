// sendInductionEmail — relays an induction link to a tenant's saved contact emails via
// Microsoft Graph (application permissions, client-credentials flow), so the admin panel's
// "Send via email" button sends for real instead of just opening a mailto: draft.
//
// Not deployable yet: needs the Firebase project on the Blaze plan, and the four secrets
// below set via `firebase functions:secrets:set` (see the plan) once the Entra ID app
// registration is done. Every line here can be reviewed and locally sanity-checked before
// that — see functions/README.md.
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');

admin.initializeApp();

const GRAPH_TENANT_ID = defineSecret('GRAPH_TENANT_ID');
const GRAPH_CLIENT_ID = defineSecret('GRAPH_CLIENT_ID');
const GRAPH_CLIENT_SECRET = defineSecret('GRAPH_CLIENT_SECRET');
const GRAPH_SENDER_MAILBOX = defineSecret('GRAPH_SENDER_MAILBOX');

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

async function getGraphAccessToken() {
  const res = await fetch(
    `https://login.microsoftonline.com/${GRAPH_TENANT_ID.value()}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GRAPH_CLIENT_ID.value(),
        client_secret: GRAPH_CLIENT_SECRET.value(),
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      }),
    }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('Graph token request failed:', res.status, body);
    throw new HttpsError('internal', 'Could not authenticate with Microsoft Graph.');
  }
  const { access_token } = await res.json();
  return access_token;
}

async function sendViaGraph(accessToken, { to, subject, text }) {
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${GRAPH_SENDER_MAILBOX.value()}/sendMail`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: 'Text', content: text },
          toRecipients: to.map((address) => ({ emailAddress: { address } })),
        },
      }),
    }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('Graph sendMail failed:', res.status, body);
    throw new HttpsError('internal', 'Microsoft Graph rejected the send.');
  }
}

exports.sendInductionEmail = onCall(
  { secrets: [GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET, GRAPH_SENDER_MAILBOX] },
  async (request) => {
    await assertIsAdmin(request.auth);
    const payload = validatePayload(request.data);
    await checkRateLimit(request.auth.token.email);
    const accessToken = await getGraphAccessToken();
    await sendViaGraph(accessToken, payload);
    return { ok: true };
  }
);
