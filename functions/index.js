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
  return { to, subject, text };
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
    const accessToken = await getGraphAccessToken();
    await sendViaGraph(accessToken, payload);
    return { ok: true };
  }
);
