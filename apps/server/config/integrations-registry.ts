// Static catalog of first-party integrations (Supabase-style Integrations tab).
// Each integration is powered by existing platform primitives: API keys stored
// as edge-function secrets (`env.NAME` in the sandbox) plus prebuilt
// edge-function templates (readers, senders, webhook receivers). Connecting an
// integration = saving its secrets, plus installing the functions the operator
// picked (all of them by default).
//
// Two template shapes coexist, on purpose:
//   - expression templates (`(async (context) => …)(context)`) for plain API
//     calls: they return a value, which `functions.invoke()` reads directly.
//   - module templates (`export default async (req) => Response`) for webhook
//     receivers: only those get the Fetch surface (Request, crypto.subtle) and
//     own their HTTP status, which is what a sender reads to decide whether to
//     retry. A receiver that cannot answer 400 cannot reject a forged delivery.

interface IntegrationSecret {
  name: string;
  label: string;
  placeholder: string;
  /** Optional secrets are not required for the integration to count as connected. */
  optional?: boolean;
}

interface IntegrationFunction {
  /** Edge function name (unique). */
  name: string;
  /** Edge function route (unique). */
  route: string;
  description: string;
  /** Optional cron expression: installed as the function's schedule. */
  schedule?: string;
  /**
   * `example` marks a template that is NOT safe to expose as-is (no signature
   * verification, no auth). Nothing in the catalogue ships as `example` today;
   * the field stays because a future template might have to.
   */
  readiness?: 'production' | 'example';
  /** Webhook receivers need their URL registered with the provider. */
  kind?: 'action' | 'webhook';
  code: string;
}

export interface Integration {
  key: string;
  name: string;
  description: string;
  category: 'payments' | 'scheduling' | 'data' | 'messaging' | 'email' | 'ai' | 'devtools';
  docsUrl: string;
  secrets: IntegrationSecret[];
  functions: IntegrationFunction[];
}

/**
 * Prelude shared by every webhook receiver. The runtime has `crypto.subtle`,
 * so these are the real primitives, not a stand-in: `safeEqual` compares in
 * constant time, because an early return on
 * the first mismatching character leaks the signature prefix one request at a
 * time.
 */
const WEBHOOK_PRELUDE = `const __enc = new TextEncoder();

/** HMAC over \`payload\`, returned as raw bytes. */
async function hmacBytes(secret, payload, hash) {
  const key = await crypto.subtle.importKey(
    'raw', __enc.encode(secret), { name: 'HMAC', hash: hash || 'SHA-256' }, false, ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, __enc.encode(payload)));
}

const hmacHex = async (secret, payload, hash) =>
  Array.from(await hmacBytes(secret, payload, hash), b => b.toString(16).padStart(2, '0')).join('');

/**
 * Base64 of the raw digest bytes. Not btoa(String.fromCharCode(...)): btoa here
 * UTF-8 encodes its input, so every byte above 0x7f would become two and the
 * signature would never match.
 */
const __b64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
async function hmacBase64(secret, payload, hash) {
  const bytes = await hmacBytes(secret, payload, hash);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
    out += __b64[b0 >> 2];
    out += __b64[((b0 & 3) << 4) | ((b1 === undefined ? 0 : b1) >> 4)];
    out += b1 === undefined ? '=' : __b64[((b1 & 15) << 2) | ((b2 === undefined ? 0 : b2) >> 6)];
    out += b2 === undefined ? '=' : __b64[b2 & 63];
  }
  return out;
}

/** Constant-time string compare: an early return would leak the prefix. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const reject = (reason, status) =>
  new Response(JSON.stringify({ error: reason }), { status: status || 400, headers: { 'content-type': 'application/json' } });
`;

export const INTEGRATIONS: Integration[] = [
  {
    key: 'stripe',
    name: 'Stripe',
    description: 'Customers, checkout sessions, subscriptions, refunds and a signature-verified webhook receiver.',
    category: 'payments',
    docsUrl: 'https://docs.stripe.com/api',
    secrets: [
      { name: 'STRIPE_SECRET_KEY', label: 'Secret key', placeholder: 'sk_live_…' },
      {
        name: 'STRIPE_WEBHOOK_SECRET',
        label: 'Webhook signing secret',
        placeholder: 'whsec_…',
        optional: true,
      },
    ],
    functions: [
      {
        name: 'stripe-customers',
        route: 'stripe-customers',
        description: 'List recent Stripe customers. Invoke with { "limit": 10, "email": "a@b.c" }.',
        code: `// Lists recent Stripe customers, optionally filtered by email.
(async (context) => {
  const limit = Math.min(Number(context.limit ?? 10), 100);
  const query = 'limit=' + limit + (context.email ? '&email=' + encodeURIComponent(String(context.email)) : '');
  const res = await fetch('https://api.stripe.com/v1/customers?' + query, {
    headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? 'Stripe error ' + res.status);
  return body.data.map(c => ({ id: c.id, email: c.email, name: c.name, created: c.created }));
})(context)`,
      },
      {
        name: 'stripe-create-customer',
        route: 'stripe-create-customer',
        description: 'Create a customer. Invoke with { "email": "a@b.c", "name": "Ada", "metadata": { "userId": "1" } }.',
        code: `// Creates one Stripe customer. Metadata is how you tie it back to your own user row.
(async (context) => {
  if (!context.email) throw new Error('email is required');
  let form = 'email=' + encodeURIComponent(String(context.email));
  if (context.name) form += '&name=' + encodeURIComponent(String(context.name));
  for (const [key, value] of Object.entries(context.metadata ?? {})) {
    form += '&metadata[' + encodeURIComponent(key) + ']=' + encodeURIComponent(String(value));
  }
  const res = await fetch('https://api.stripe.com/v1/customers', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY,
      'Content-Type': 'application/x-www-form-urlencoded',
      // Same customer created twice on a retry is a duplicate bill later.
      'Idempotency-Key': String(context.idempotencyKey ?? ('customer-' + context.email)),
    },
    body: form,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? 'Stripe error ' + res.status);
  return { id: body.id, email: body.email };
})(context)`,
      },
      {
        name: 'stripe-checkout-session',
        route: 'stripe-checkout-session',
        description:
          'Create a Checkout session. Invoke with { "priceId": "price_…", "quantity": 1, "successUrl": "…", "cancelUrl": "…" }.',
        code: `// Creates a Stripe Checkout session and returns the URL to redirect the buyer to.
(async (context) => {
  if (!context.priceId) throw new Error('priceId is required');
  if (!context.successUrl || !context.cancelUrl) throw new Error('successUrl and cancelUrl are required');
  const quantity = Math.max(Number(context.quantity ?? 1), 1);
  let form = 'mode=' + encodeURIComponent(String(context.mode ?? 'payment'))
    + '&line_items[0][price]=' + encodeURIComponent(String(context.priceId))
    + '&line_items[0][quantity]=' + quantity
    + '&success_url=' + encodeURIComponent(String(context.successUrl))
    + '&cancel_url=' + encodeURIComponent(String(context.cancelUrl));
  if (context.customerId) form += '&customer=' + encodeURIComponent(String(context.customerId));
  if (context.customerEmail) form += '&customer_email=' + encodeURIComponent(String(context.customerEmail));
  for (const [key, value] of Object.entries(context.metadata ?? {})) {
    form += '&metadata[' + encodeURIComponent(key) + ']=' + encodeURIComponent(String(value));
  }
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': String(context.idempotencyKey ?? ('checkout-' + Date.now())),
    },
    body: form,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? 'Stripe error ' + res.status);
  return { id: body.id, url: body.url, expiresAt: body.expires_at };
})(context)`,
      },
      {
        name: 'stripe-subscriptions',
        route: 'stripe-subscriptions',
        description: 'List subscriptions. Invoke with { "customerId": "cus_…", "status": "active" }.',
        code: `// Lists Stripe subscriptions, optionally for a single customer.
(async (context) => {
  const limit = Math.min(Number(context.limit ?? 25), 100);
  let query = 'limit=' + limit + '&status=' + encodeURIComponent(String(context.status ?? 'all'));
  if (context.customerId) query += '&customer=' + encodeURIComponent(String(context.customerId));
  const res = await fetch('https://api.stripe.com/v1/subscriptions?' + query, {
    headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? 'Stripe error ' + res.status);
  return body.data.map(s => ({
    id: s.id,
    customer: s.customer,
    status: s.status,
    currentPeriodEnd: s.current_period_end,
    cancelAtPeriodEnd: s.cancel_at_period_end,
    priceId: s.items?.data?.[0]?.price?.id ?? null,
  }));
})(context)`,
      },
      {
        name: 'stripe-refund',
        route: 'stripe-refund',
        description: 'Refund a payment. Invoke with { "paymentIntentId": "pi_…", "amount": 500 }.',
        code: `// Refunds a payment intent, fully or partially (amount is in the smallest currency unit).
(async (context) => {
  if (!context.paymentIntentId) throw new Error('paymentIntentId is required');
  let form = 'payment_intent=' + encodeURIComponent(String(context.paymentIntentId));
  if (context.amount !== undefined) form += '&amount=' + Math.max(Number(context.amount), 0);
  if (context.reason) form += '&reason=' + encodeURIComponent(String(context.reason));
  const res = await fetch('https://api.stripe.com/v1/refunds', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY,
      'Content-Type': 'application/x-www-form-urlencoded',
      // Money moves here: a retry without this key refunds twice.
      'Idempotency-Key': String(context.idempotencyKey ?? ('refund-' + context.paymentIntentId)),
    },
    body: form,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? 'Stripe error ' + res.status);
  return { id: body.id, status: body.status, amount: body.amount, currency: body.currency };
})(context)`,
      },
      {
        name: 'stripe-webhook',
        route: 'stripe-webhook',
        kind: 'webhook',
        description:
          'Signature-verified Stripe webhook receiver. Point the Stripe dashboard endpoint at this route, paste its whsec_… into STRIPE_WEBHOOK_SECRET, then fill in handleEvent().',
        code: `${WEBHOOK_PRELUDE}
// Stripe webhook receiver.
//
// Verified here: the v1 HMAC-SHA256 over "<timestamp>.<raw body>", compared in
// constant time, plus a five-minute replay window. An unverified receiver is a
// public endpoint that anyone can post "payment succeeded" to.
//
// Not verified here, because only your application can: idempotence. Stripe
// retries a delivery it did not get a 2xx for, so handleEvent() sees the same
// event.id more than once. Key your writes on event.id.
const TOLERANCE_SECONDS = 300;

export default async (req) => {
  if (req.method !== 'POST') return reject('method not allowed', 405);

  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return reject('STRIPE_WEBHOOK_SECRET is not set', 500);

  const raw = await req.text();
  const header = req.headers.get('stripe-signature') || '';

  let timestamp = 0;
  const signatures = [];
  for (const piece of header.split(',')) {
    const eq = piece.indexOf('=');
    if (eq === -1) continue;
    const key = piece.slice(0, eq).trim();
    const value = piece.slice(eq + 1).trim();
    if (key === 't') timestamp = Number(value);
    else if (key === 'v1') signatures.push(value);
  }
  if (!timestamp || signatures.length === 0) return reject('malformed stripe-signature header');

  const age = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (age > TOLERANCE_SECONDS) return reject('timestamp outside the replay window');

  const expected = await hmacHex(secret, timestamp + '.' + raw);
  if (!signatures.some(candidate => safeEqual(candidate, expected))) return reject('invalid signature');

  let event;
  try {
    event = JSON.parse(raw);
  } catch (e) {
    return reject('body is not JSON');
  }

  try {
    await handleEvent(event);
  } catch (e) {
    // A 500 makes Stripe retry, which is what you want for a transient failure.
    console.error('stripe handler failed', event.type, e && e.message);
    return reject('handler failed', 500);
  }

  return Response.json({ received: true, id: event.id });
};

async function handleEvent(event) {
  switch (event.type) {
    case 'checkout.session.completed':
      // event.data.object.id, .customer, .metadata: grant access, keyed on event.id.
      console.log('checkout completed', event.data.object.id);
      break;
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      console.log('subscription', event.type, event.data.object.id, event.data.object.status);
      break;
    case 'invoice.payment_failed':
      console.log('payment failed', event.data.object.id);
      break;
    default:
      console.log('unhandled stripe event', event.type);
  }
}`,
      },
    ],
  },
  {
    key: 'calendly',
    name: 'Calendly',
    description: 'Scheduled events, invitees, cancellation and a signature-verified booking webhook.',
    category: 'scheduling',
    docsUrl: 'https://developer.calendly.com',
    secrets: [
      { name: 'CALENDLY_TOKEN', label: 'Personal access token', placeholder: 'eyJra…' },
      {
        name: 'CALENDLY_WEBHOOK_SIGNING_KEY',
        label: 'Webhook signing key',
        placeholder: 'returned when you create the subscription',
        optional: true,
      },
    ],
    functions: [
      {
        name: 'calendly-events',
        route: 'calendly-events',
        description: 'List upcoming scheduled events for the token owner.',
        code: `// Lists upcoming Calendly events for the authenticated user.
(async (context) => {
  const me = await (await fetch('https://api.calendly.com/users/me', {
    headers: { Authorization: 'Bearer ' + env.CALENDLY_TOKEN },
  })).json();
  const uri = me?.resource?.uri;
  if (!uri) throw new Error('Calendly auth failed');
  const res = await fetch('https://api.calendly.com/scheduled_events?user=' + encodeURIComponent(uri) + '&status=' + encodeURIComponent(String(context.status ?? 'active')) + '&sort=start_time:asc', {
    headers: { Authorization: 'Bearer ' + env.CALENDLY_TOKEN },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.message ?? 'Calendly error ' + res.status);
  return body.collection.map(e => ({ uri: e.uri, name: e.name, start: e.start_time, end: e.end_time, status: e.status }));
})(context)`,
      },
      {
        name: 'calendly-invitees',
        route: 'calendly-invitees',
        description: 'List the invitees of one event. Invoke with { "eventUri": "https://api.calendly.com/scheduled_events/…" }.',
        code: `// Lists the invitees (name, email, answers) booked onto one Calendly event.
(async (context) => {
  if (!context.eventUri) throw new Error('eventUri is required');
  if (!String(context.eventUri).startsWith('https://api.calendly.com/')) throw new Error('eventUri must be a Calendly API URL');
  const res = await fetch(String(context.eventUri) + '/invitees', {
    headers: { Authorization: 'Bearer ' + env.CALENDLY_TOKEN },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.message ?? 'Calendly error ' + res.status);
  return body.collection.map(i => ({
    uri: i.uri,
    name: i.name,
    email: i.email,
    status: i.status,
    questions: i.questions_and_answers,
  }));
})(context)`,
      },
      {
        name: 'calendly-cancel',
        route: 'calendly-cancel',
        description: 'Cancel an event. Invoke with { "eventUri": "…", "reason": "…" }.',
        code: `// Cancels one Calendly scheduled event.
(async (context) => {
  if (!context.eventUri) throw new Error('eventUri is required');
  if (!String(context.eventUri).startsWith('https://api.calendly.com/')) throw new Error('eventUri must be a Calendly API URL');
  const res = await fetch(String(context.eventUri) + '/cancellation', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.CALENDLY_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: String(context.reason ?? 'Cancelled by the organizer') }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.message ?? 'Calendly error ' + res.status);
  return { canceledAt: body.resource?.created_at, reason: body.resource?.reason };
})(context)`,
      },
      {
        name: 'calendly-webhook',
        route: 'calendly-webhook',
        kind: 'webhook',
        description:
          'Signature-verified Calendly webhook receiver (invitee.created / invitee.canceled). Create the subscription with this route, store the returned signing key in CALENDLY_WEBHOOK_SIGNING_KEY.',
        code: `${WEBHOOK_PRELUDE}
// Calendly webhook receiver.
//
// Calendly signs with the same scheme Stripe uses: "t=<unix>,v1=<hex hmac>"
// over "<t>.<raw body>", in the Calendly-Webhook-Signature header.
const TOLERANCE_SECONDS = 300;

export default async (req) => {
  if (req.method !== 'POST') return reject('method not allowed', 405);

  const secret = env.CALENDLY_WEBHOOK_SIGNING_KEY;
  if (!secret) return reject('CALENDLY_WEBHOOK_SIGNING_KEY is not set', 500);

  const raw = await req.text();
  const header = req.headers.get('calendly-webhook-signature') || '';

  let timestamp = 0;
  const signatures = [];
  for (const piece of header.split(',')) {
    const eq = piece.indexOf('=');
    if (eq === -1) continue;
    const key = piece.slice(0, eq).trim();
    const value = piece.slice(eq + 1).trim();
    if (key === 't') timestamp = Number(value);
    else if (key === 'v1') signatures.push(value);
  }
  if (!timestamp || signatures.length === 0) return reject('malformed Calendly-Webhook-Signature header');

  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > TOLERANCE_SECONDS) {
    return reject('timestamp outside the replay window');
  }

  const expected = await hmacHex(secret, timestamp + '.' + raw);
  if (!signatures.some(candidate => safeEqual(candidate, expected))) return reject('invalid signature');

  const payload = JSON.parse(raw);
  // Calendly retries until it gets a 2xx, so key your writes on
  // payload.payload.uri (the invitee URI) rather than inserting blindly.
  switch (payload.event) {
    case 'invitee.created':
      console.log('booked', payload.payload?.email, payload.payload?.scheduled_event?.start_time);
      break;
    case 'invitee.canceled':
      console.log('cancelled', payload.payload?.email);
      break;
    default:
      console.log('unhandled calendly event', payload.event);
  }

  return Response.json({ received: true });
};`,
      },
    ],
  },
  {
    key: 'airtable',
    name: 'Airtable',
    description: 'Read, create and update records in an Airtable base.',
    category: 'data',
    docsUrl: 'https://airtable.com/developers/web/api/introduction',
    secrets: [
      { name: 'AIRTABLE_TOKEN', label: 'Personal access token', placeholder: 'pat…' },
      { name: 'AIRTABLE_BASE_ID', label: 'Base ID', placeholder: 'app…' },
      { name: 'AIRTABLE_TABLE', label: 'Table name', placeholder: 'Table 1' },
    ],
    functions: [
      {
        name: 'airtable-records',
        route: 'airtable-records',
        description: 'List records. Invoke with { "maxRecords": 25, "filterByFormula": "{Status}=\'Open\'" }.',
        code: `// Lists records from the configured Airtable base + table.
(async (context) => {
  const max = Math.min(Number(context.maxRecords ?? 25), 100);
  let url = 'https://api.airtable.com/v0/' + env.AIRTABLE_BASE_ID + '/' + encodeURIComponent(env.AIRTABLE_TABLE) + '?maxRecords=' + max;
  if (context.filterByFormula) url += '&filterByFormula=' + encodeURIComponent(String(context.filterByFormula));
  if (context.view) url += '&view=' + encodeURIComponent(String(context.view));
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + env.AIRTABLE_TOKEN } });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? 'Airtable error ' + res.status);
  return body.records.map(r => ({ id: r.id, ...r.fields }));
})(context)`,
      },
      {
        name: 'airtable-create-record',
        route: 'airtable-create-record',
        description: 'Create records. Invoke with { "fields": { "Name": "Ada" } } or { "records": [{ "fields": {…} }] }.',
        code: `// Creates one or many Airtable records (max 10 per call, an Airtable limit).
(async (context) => {
  const records = Array.isArray(context.records)
    ? context.records
    : [{ fields: context.fields ?? {} }];
  if (records.length === 0) throw new Error('No records given');
  if (records.length > 10) throw new Error('Airtable accepts at most 10 records per request');
  const res = await fetch('https://api.airtable.com/v0/' + env.AIRTABLE_BASE_ID + '/' + encodeURIComponent(env.AIRTABLE_TABLE), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.AIRTABLE_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ records, typecast: context.typecast === true }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? 'Airtable error ' + res.status);
  return body.records.map(r => ({ id: r.id, ...r.fields }));
})(context)`,
      },
      {
        name: 'airtable-update-record',
        route: 'airtable-update-record',
        description: 'Patch one record. Invoke with { "id": "rec…", "fields": { "Status": "Done" } }.',
        code: `// Patches one Airtable record, leaving the fields you did not send alone.
(async (context) => {
  if (!context.id) throw new Error('id is required');
  const res = await fetch('https://api.airtable.com/v0/' + env.AIRTABLE_BASE_ID + '/' + encodeURIComponent(env.AIRTABLE_TABLE) + '/' + encodeURIComponent(String(context.id)), {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + env.AIRTABLE_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: context.fields ?? {}, typecast: context.typecast === true }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? 'Airtable error ' + res.status);
  return { id: body.id, ...body.fields };
})(context)`,
      },
    ],
  },
  {
    key: 'slack',
    name: 'Slack',
    description: 'Incoming-webhook notifications, Web API messages and a signed Events receiver.',
    category: 'messaging',
    docsUrl: 'https://api.slack.com/messaging/webhooks',
    secrets: [
      { name: 'SLACK_WEBHOOK_URL', label: 'Incoming webhook URL', placeholder: 'https://hooks.slack.com/services/…' },
      { name: 'SLACK_BOT_TOKEN', label: 'Bot token (Web API)', placeholder: 'xoxb-…', optional: true },
      { name: 'SLACK_SIGNING_SECRET', label: 'Signing secret (Events API)', placeholder: '32-char secret', optional: true },
    ],
    functions: [
      {
        name: 'slack-notify',
        route: 'slack-notify',
        description: 'Post a message to the incoming webhook. Invoke with { "text": "hello", "blocks": [] }.',
        code: `// Posts a message to the configured Slack incoming webhook.
(async (context) => {
  const payload = { text: String(context.text ?? 'Ping from Motherbase') };
  if (Array.isArray(context.blocks)) payload.blocks = context.blocks;
  const res = await fetch(env.SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('Slack error ' + res.status);
  return { sent: true };
})(context)`,
      },
      {
        name: 'slack-post-message',
        route: 'slack-post-message',
        description: 'chat.postMessage with the bot token. Invoke with { "channel": "#ops", "text": "…", "threadTs": "…" }.',
        code: `// Posts through the Slack Web API, which (unlike an incoming webhook) can
// choose the channel at call time and reply in a thread.
(async (context) => {
  if (!env.SLACK_BOT_TOKEN) throw new Error('SLACK_BOT_TOKEN is not set');
  if (!context.channel) throw new Error('channel is required');
  const payload = {
    channel: String(context.channel),
    text: String(context.text ?? ''),
  };
  if (Array.isArray(context.blocks)) payload.blocks = context.blocks;
  if (context.threadTs) payload.thread_ts = String(context.threadTs);
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.SLACK_BOT_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  // Slack answers 200 with { ok: false } on failure, so res.ok proves nothing.
  if (!body.ok) throw new Error(body.error ?? 'Slack error ' + res.status);
  return { ts: body.ts, channel: body.channel };
})(context)`,
      },
      {
        name: 'slack-events',
        route: 'slack-events',
        kind: 'webhook',
        description:
          'Signed Slack Events API receiver (handles the url_verification challenge). Set SLACK_SIGNING_SECRET and point the app Event Subscriptions URL at this route.',
        code: `${WEBHOOK_PRELUDE}
// Slack Events API receiver.
//
// Slack signs "v0:<timestamp>:<raw body>" with HMAC-SHA256 and sends the hex
// digest as "v0=<hex>" in X-Slack-Signature. Slack's own guidance is a five
// minute window, to bound replay.
const TOLERANCE_SECONDS = 300;

export default async (req) => {
  if (req.method !== 'POST') return reject('method not allowed', 405);

  const secret = env.SLACK_SIGNING_SECRET;
  if (!secret) return reject('SLACK_SIGNING_SECRET is not set', 500);

  const raw = await req.text();
  const timestamp = Number(req.headers.get('x-slack-request-timestamp') || 0);
  const given = req.headers.get('x-slack-signature') || '';
  if (!timestamp || !given) return reject('missing Slack signature headers');
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > TOLERANCE_SECONDS) {
    return reject('timestamp outside the replay window');
  }

  const expected = 'v0=' + (await hmacHex(secret, 'v0:' + timestamp + ':' + raw));
  if (!safeEqual(given, expected)) return reject('invalid signature');

  const payload = JSON.parse(raw);

  // One-time handshake when you save the Request URL in the Slack app config.
  if (payload.type === 'url_verification') {
    return new Response(payload.challenge, { status: 200, headers: { 'content-type': 'text/plain' } });
  }

  // Slack retries anything it does not get a 2xx for within 3 seconds, and
  // resends with X-Slack-Retry-Num. Keep the work here short.
  console.log('slack event', payload.event?.type, payload.event?.channel);
  return Response.json({ ok: true });
};`,
      },
    ],
  },
  {
    key: 'discord',
    name: 'Discord',
    description: 'Post plain messages and rich embeds to a channel webhook.',
    category: 'messaging',
    docsUrl: 'https://discord.com/developers/docs/resources/webhook',
    secrets: [
      { name: 'DISCORD_WEBHOOK_URL', label: 'Webhook URL', placeholder: 'https://discord.com/api/webhooks/…' },
    ],
    functions: [
      {
        name: 'discord-notify',
        route: 'discord-notify',
        description: 'Post a message to Discord. Invoke with { "content": "hello" }.',
        code: `// Posts a message to the configured Discord webhook.
(async (context) => {
  const content = String(context.content ?? 'Ping from Motherbase');
  const res = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, username: context.username, avatar_url: context.avatarUrl }),
  });
  if (!res.ok && res.status !== 204) throw new Error('Discord error ' + res.status);
  return { sent: true };
})(context)`,
      },
      {
        name: 'discord-embed',
        route: 'discord-embed',
        description: 'Post a rich embed. Invoke with { "title": "Deploy", "description": "…", "color": 3066993, "fields": [] }.',
        code: `// Posts one rich embed (the readable shape for alerts) to the Discord webhook.
(async (context) => {
  const embed = {
    title: String(context.title ?? 'Motherbase'),
    description: context.description ? String(context.description) : undefined,
    url: context.url,
    color: context.color === undefined ? 5814783 : Number(context.color),
    fields: Array.isArray(context.fields) ? context.fields.slice(0, 25) : undefined,
    timestamp: new Date().toISOString(),
  };
  const res = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: context.content, embeds: [embed] }),
  });
  if (!res.ok && res.status !== 204) throw new Error('Discord error ' + res.status + ' ' + (await res.text()));
  return { sent: true };
})(context)`,
      },
    ],
  },
  {
    key: 'resend',
    name: 'Resend',
    description: 'Send one email, a batch, or from a saved audience through Resend.',
    category: 'email',
    docsUrl: 'https://resend.com/docs/api-reference',
    secrets: [
      { name: 'RESEND_API_KEY', label: 'API key', placeholder: 're_…' },
      { name: 'RESEND_FROM', label: 'From address', placeholder: 'Acme <onboarding@resend.dev>' },
    ],
    functions: [
      {
        name: 'resend-email',
        route: 'resend-email',
        description: 'Send an email. Invoke with { "to": "a@b.c", "subject": "...", "html": "..." }.',
        code: `// Sends an email via Resend.
(async (context) => {
  if (!context.to) throw new Error('to is required');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.RESEND_FROM,
      to: context.to,
      cc: context.cc,
      bcc: context.bcc,
      reply_to: context.replyTo,
      subject: context.subject ?? '(no subject)',
      html: context.html ?? undefined,
      text: context.text ?? undefined,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.message ?? 'Resend error ' + res.status);
  return { id: body.id };
})(context)`,
      },
      {
        name: 'resend-batch',
        route: 'resend-batch',
        description: 'Send up to 100 emails in one call. Invoke with { "emails": [{ "to": "…", "subject": "…", "html": "…" }] }.',
        code: `// Sends a batch through Resend. One request instead of N keeps you inside the
// per-second rate limit that a loop of single sends walks straight into.
(async (context) => {
  const emails = Array.isArray(context.emails) ? context.emails : [];
  if (emails.length === 0) throw new Error('emails is required');
  if (emails.length > 100) throw new Error('Resend accepts at most 100 emails per batch');
  const res = await fetch('https://api.resend.com/emails/batch', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(emails.map(email => ({
      from: email.from ?? env.RESEND_FROM,
      to: email.to,
      subject: email.subject ?? '(no subject)',
      html: email.html ?? undefined,
      text: email.text ?? undefined,
    }))),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.message ?? 'Resend error ' + res.status);
  return { ids: (body.data ?? []).map(d => d.id), count: (body.data ?? []).length };
})(context)`,
      },
    ],
  },
  {
    key: 'openai',
    name: 'OpenAI',
    description: 'Chat completions, embeddings and moderation from an edge function.',
    category: 'ai',
    docsUrl: 'https://platform.openai.com/docs/api-reference',
    secrets: [
      { name: 'OPENAI_API_KEY', label: 'API key', placeholder: 'sk-…' },
    ],
    functions: [
      {
        name: 'openai-complete',
        route: 'openai-complete',
        description: 'Chat completion. Invoke with { "prompt": "...", "system": "...", "json": true }.',
        code: `// Calls OpenAI chat completions. Pass json:true to force a JSON object back.
(async (context) => {
  const messages = [];
  if (context.system) messages.push({ role: 'system', content: String(context.system) });
  messages.push({ role: 'user', content: String(context.prompt ?? 'Say hello') });
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: context.model ?? 'gpt-4o-mini',
      messages,
      temperature: context.temperature,
      max_tokens: context.maxTokens,
      response_format: context.json ? { type: 'json_object' } : undefined,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? 'OpenAI error ' + res.status);
  return { answer: body.choices?.[0]?.message?.content ?? null, usage: body.usage };
})(context)`,
      },
      {
        name: 'openai-embedding',
        route: 'openai-embedding',
        description: 'Embed text for vector search. Invoke with { "input": "text" } or { "input": ["a", "b"] }.',
        code: `// Returns embeddings, the vectors you store in pgvector for similarity search.
(async (context) => {
  if (context.input === undefined) throw new Error('input is required');
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: context.model ?? 'text-embedding-3-small', input: context.input }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? 'OpenAI error ' + res.status);
  return { vectors: body.data.map(d => d.embedding), model: body.model, usage: body.usage };
})(context)`,
      },
      {
        name: 'openai-moderate',
        route: 'openai-moderate',
        description: 'Moderate user content before you store or show it. Invoke with { "input": "text" }.',
        code: `// Flags user-submitted content. Cheap enough to run on every write path.
(async (context) => {
  if (context.input === undefined) throw new Error('input is required');
  const res = await fetch('https://api.openai.com/v1/moderations', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: context.model ?? 'omni-moderation-latest', input: context.input }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? 'OpenAI error ' + res.status);
  const first = body.results?.[0] ?? {};
  return {
    flagged: first.flagged === true,
    categories: Object.keys(first.categories ?? {}).filter(key => first.categories[key]),
  };
})(context)`,
      },
    ],
  },
  {
    key: 'twilio',
    name: 'Twilio',
    description: 'Send SMS, read delivery status, and receive signed inbound messages.',
    category: 'messaging',
    docsUrl: 'https://www.twilio.com/docs/sms/api',
    secrets: [
      { name: 'TWILIO_ACCOUNT_SID', label: 'Account SID', placeholder: 'AC…' },
      { name: 'TWILIO_AUTH_TOKEN', label: 'Auth token', placeholder: '…' },
      { name: 'TWILIO_FROM', label: 'From number', placeholder: '+15550001111' },
    ],
    functions: [
      {
        name: 'twilio-sms',
        route: 'twilio-sms',
        description: 'Send an SMS. Invoke with { "to": "+336…", "body": "hello" }.',
        code: `// Sends an SMS via the Twilio REST API.
// The expression sandbox has no btoa, so base64 is inlined here.
(async (context) => {
  const b64 = (s) => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let out = '';
    for (let i = 0; i < s.length; i += 3) {
      const c1 = s.charCodeAt(i), c2 = s.charCodeAt(i + 1), c3 = s.charCodeAt(i + 2);
      out += chars[c1 >> 2] + chars[((c1 & 3) << 4) | (isNaN(c2) ? 0 : c2 >> 4)]
        + (isNaN(c2) ? '=' : chars[((c2 & 15) << 2) | (isNaN(c3) ? 0 : c3 >> 6)])
        + (isNaN(c3) ? '=' : chars[c3 & 63]);
    }
    return out;
  };
  const sid = env.TWILIO_ACCOUNT_SID;
  let form = 'To=' + encodeURIComponent(String(context.to ?? ''))
    + '&From=' + encodeURIComponent(env.TWILIO_FROM)
    + '&Body=' + encodeURIComponent(String(context.body ?? ''));
  if (context.statusCallback) form += '&StatusCallback=' + encodeURIComponent(String(context.statusCallback));
  const res = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Messages.json', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + b64(sid + ':' + env.TWILIO_AUTH_TOKEN),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.message ?? 'Twilio error ' + res.status);
  return { sid: body.sid, status: body.status };
})(context)`,
      },
      {
        name: 'twilio-message-status',
        route: 'twilio-message-status',
        description: 'Read one message. Invoke with { "messageSid": "SM…" }.',
        code: `// Reads delivery status for a message you sent (queued, sent, delivered, failed).
(async (context) => {
  if (!context.messageSid) throw new Error('messageSid is required');
  const b64 = (s) => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let out = '';
    for (let i = 0; i < s.length; i += 3) {
      const c1 = s.charCodeAt(i), c2 = s.charCodeAt(i + 1), c3 = s.charCodeAt(i + 2);
      out += chars[c1 >> 2] + chars[((c1 & 3) << 4) | (isNaN(c2) ? 0 : c2 >> 4)]
        + (isNaN(c2) ? '=' : chars[((c2 & 15) << 2) | (isNaN(c3) ? 0 : c3 >> 6)])
        + (isNaN(c3) ? '=' : chars[c3 & 63]);
    }
    return out;
  };
  const sid = env.TWILIO_ACCOUNT_SID;
  const res = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Messages/' + encodeURIComponent(String(context.messageSid)) + '.json', {
    headers: { Authorization: 'Basic ' + b64(sid + ':' + env.TWILIO_AUTH_TOKEN) },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.message ?? 'Twilio error ' + res.status);
  return { sid: body.sid, status: body.status, error: body.error_message, to: body.to, sentAt: body.date_sent };
})(context)`,
      },
      {
        name: 'twilio-inbound',
        route: 'twilio-inbound',
        kind: 'webhook',
        description:
          'Signature-verified inbound SMS receiver, answers TwiML. Set this route as the messaging webhook on your Twilio number.',
        code: `${WEBHOOK_PRELUDE}
// Twilio inbound message receiver.
//
// Twilio signs the full request URL with the form fields appended in sorted key
// order, HMAC-SHA1, base64, in X-Twilio-Signature. The auth token is the key,
// so there is no separate webhook secret to store.
export default async (req) => {
  if (req.method !== 'POST') return reject('method not allowed', 405);

  const token = env.TWILIO_AUTH_TOKEN;
  if (!token) return reject('TWILIO_AUTH_TOKEN is not set', 500);

  const raw = await req.text();
  const given = req.headers.get('x-twilio-signature') || '';
  if (!given) return reject('missing X-Twilio-Signature');

  const params = new URLSearchParams(raw);
  const keys = Array.from(params.keys()).sort();
  let signedPayload = req.url;
  for (const key of keys) signedPayload += key + params.get(key);

  const expected = await hmacBase64(token, signedPayload, 'SHA-1');
  if (!safeEqual(given, expected)) return reject('invalid signature');

  const from = params.get('From');
  const body = params.get('Body');
  console.log('inbound sms', from, body);

  // TwiML is what Twilio expects back; an empty <Response/> replies nothing.
  const reply = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
  return new Response(reply, { status: 200, headers: { 'content-type': 'text/xml' } });
};`,
      },
    ],
  },
  {
    key: 'github',
    name: 'GitHub',
    description: 'Read issues, open them, trigger workflows and receive signed repo webhooks.',
    category: 'devtools',
    docsUrl: 'https://docs.github.com/rest',
    secrets: [
      { name: 'GITHUB_TOKEN', label: 'Personal access token', placeholder: 'ghp_…' },
      { name: 'GITHUB_REPO', label: 'Repository', placeholder: 'owner/repo' },
      { name: 'GITHUB_WEBHOOK_SECRET', label: 'Webhook secret', placeholder: 'the secret you typed in the repo settings', optional: true },
    ],
    functions: [
      {
        name: 'github-issues',
        route: 'github-issues',
        description: 'List issues on the configured repo. Invoke with { "state": "open", "labels": "bug" }.',
        code: `// Lists issues for the configured repository.
(async (context) => {
  let url = 'https://api.github.com/repos/' + env.GITHUB_REPO + '/issues?state=' + encodeURIComponent(String(context.state ?? 'open'));
  if (context.labels) url += '&labels=' + encodeURIComponent(String(context.labels));
  const res = await fetch(url, {
    headers: { Authorization: 'Bearer ' + env.GITHUB_TOKEN, 'User-Agent': 'motherbase-edge', Accept: 'application/vnd.github+json' },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.message ?? 'GitHub error ' + res.status);
  return body.map(i => ({ number: i.number, title: i.title, state: i.state, url: i.html_url }));
})(context)`,
      },
      {
        name: 'github-create-issue',
        route: 'github-create-issue',
        description: 'Open an issue. Invoke with { "title": "…", "body": "…", "labels": ["bug"] }.',
        code: `// Opens one issue on the configured repository.
(async (context) => {
  if (!context.title) throw new Error('title is required');
  const res = await fetch('https://api.github.com/repos/' + env.GITHUB_REPO + '/issues', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.GITHUB_TOKEN,
      'User-Agent': 'motherbase-edge',
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: String(context.title),
      body: context.body,
      labels: Array.isArray(context.labels) ? context.labels : undefined,
      assignees: Array.isArray(context.assignees) ? context.assignees : undefined,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.message ?? 'GitHub error ' + res.status);
  return { number: body.number, url: body.html_url };
})(context)`,
      },
      {
        name: 'github-dispatch-workflow',
        route: 'github-dispatch-workflow',
        description: 'Run a workflow. Invoke with { "workflow": "ci.yml", "ref": "master", "inputs": {} }.',
        code: `// Triggers a workflow_dispatch run. The workflow must declare
// "on: workflow_dispatch" or GitHub answers 422.
(async (context) => {
  if (!context.workflow) throw new Error('workflow is required');
  const res = await fetch('https://api.github.com/repos/' + env.GITHUB_REPO + '/actions/workflows/' + encodeURIComponent(String(context.workflow)) + '/dispatches', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.GITHUB_TOKEN,
      'User-Agent': 'motherbase-edge',
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: String(context.ref ?? 'main'), inputs: context.inputs ?? {} }),
  });
  // A dispatch answers 204 with no body.
  if (res.status !== 204) {
    const body = await res.text();
    throw new Error('GitHub error ' + res.status + ' ' + body);
  }
  return { dispatched: true, workflow: context.workflow };
})(context)`,
      },
      {
        name: 'github-webhook',
        route: 'github-webhook',
        kind: 'webhook',
        description:
          'Signature-verified GitHub webhook receiver. Add a repo webhook pointing at this route with the same secret in GITHUB_WEBHOOK_SECRET.',
        code: `${WEBHOOK_PRELUDE}
// GitHub webhook receiver.
//
// GitHub signs the raw body with HMAC-SHA256 and sends "sha256=<hex>" in
// X-Hub-Signature-256. The older X-Hub-Signature (SHA-1) is deliberately
// ignored: accepting it would let a sender downgrade the check.
export default async (req) => {
  if (req.method !== 'POST') return reject('method not allowed', 405);

  const secret = env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return reject('GITHUB_WEBHOOK_SECRET is not set', 500);

  const raw = await req.text();
  const given = req.headers.get('x-hub-signature-256') || '';
  if (!given) return reject('missing X-Hub-Signature-256');

  const expected = 'sha256=' + (await hmacHex(secret, raw));
  if (!safeEqual(given, expected)) return reject('invalid signature');

  const event = req.headers.get('x-github-event') || 'unknown';
  const delivery = req.headers.get('x-github-delivery') || '';
  const payload = JSON.parse(raw);

  // X-GitHub-Delivery is stable across redeliveries: key your writes on it.
  switch (event) {
    case 'ping':
      return Response.json({ pong: true });
    case 'push':
      console.log('push', payload.ref, payload.commits?.length ?? 0, 'commits');
      break;
    case 'pull_request':
      console.log('pull_request', payload.action, payload.number);
      break;
    default:
      console.log('unhandled github event', event);
  }

  return Response.json({ received: true, event, delivery });
};`,
      },
    ],
  },
  {
    key: 'notion',
    name: 'Notion',
    description: 'Query a database, create pages and append blocks.',
    category: 'data',
    docsUrl: 'https://developers.notion.com',
    secrets: [
      { name: 'NOTION_TOKEN', label: 'Integration token', placeholder: 'ntn_…' },
      { name: 'NOTION_DATABASE_ID', label: 'Database ID', placeholder: '32-char id' },
    ],
    functions: [
      {
        name: 'notion-query',
        route: 'notion-query',
        description: 'Query the configured database. Invoke with { "pageSize": 25, "filter": {}, "sorts": [] }.',
        code: `// Queries the configured Notion database.
(async (context) => {
  const res = await fetch('https://api.notion.com/v1/databases/' + env.NOTION_DATABASE_ID + '/query', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.NOTION_TOKEN,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      page_size: Math.min(Number(context.pageSize ?? 25), 100),
      filter: context.filter,
      sorts: context.sorts,
      start_cursor: context.cursor,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.message ?? 'Notion error ' + res.status);
  return { results: body.results.map(p => ({ id: p.id, url: p.url, properties: p.properties })), nextCursor: body.next_cursor };
})(context)`,
      },
      {
        name: 'notion-create-page',
        route: 'notion-create-page',
        description: 'Add a row to the database. Invoke with { "title": "…", "properties": {} }.',
        code: `// Creates a page (a row) in the configured Notion database. "title" is a
// shortcut for the Name title property; anything else goes in "properties".
(async (context) => {
  const properties = { ...(context.properties ?? {}) };
  if (context.title) {
    properties[String(context.titleProperty ?? 'Name')] = {
      title: [{ text: { content: String(context.title) } }],
    };
  }
  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.NOTION_TOKEN,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ parent: { database_id: env.NOTION_DATABASE_ID }, properties }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.message ?? 'Notion error ' + res.status);
  return { id: body.id, url: body.url };
})(context)`,
      },
      {
        name: 'notion-append-text',
        route: 'notion-append-text',
        description: 'Append paragraphs to a page. Invoke with { "pageId": "…", "paragraphs": ["line one"] }.',
        code: `// Appends paragraph blocks to an existing Notion page (an append-only log).
(async (context) => {
  if (!context.pageId) throw new Error('pageId is required');
  const paragraphs = Array.isArray(context.paragraphs)
    ? context.paragraphs
    : [String(context.text ?? '')];
  const children = paragraphs.filter(Boolean).map(line => ({
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content: String(line).slice(0, 2000) } }] },
  }));
  if (children.length === 0) throw new Error('Nothing to append');
  const res = await fetch('https://api.notion.com/v1/blocks/' + encodeURIComponent(String(context.pageId)) + '/children', {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer ' + env.NOTION_TOKEN,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ children }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.message ?? 'Notion error ' + res.status);
  return { appended: children.length };
})(context)`,
      },
    ],
  },
  {
    key: 'anthropic',
    name: 'Anthropic',
    description: 'Call Claude, and price a prompt before you send it.',
    category: 'ai',
    docsUrl: 'https://docs.claude.com/en/api/messages',
    secrets: [
      { name: 'ANTHROPIC_API_KEY', label: 'API key', placeholder: 'sk-ant-…' },
    ],
    functions: [
      {
        name: 'anthropic-message',
        route: 'anthropic-message',
        description: 'Send a prompt to Claude. Invoke with { "prompt": "...", "system": "...", "model": "claude-sonnet-5" }.',
        code: `// Sends one prompt to the Claude Messages API.
(async (context) => {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: context.model ?? 'claude-sonnet-5',
      max_tokens: Math.min(Number(context.maxTokens ?? 1024), 8192),
      system: context.system,
      temperature: context.temperature,
      messages: Array.isArray(context.messages)
        ? context.messages
        : [{ role: 'user', content: String(context.prompt ?? '') }],
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? 'Anthropic error ' + res.status);
  return { text: body.content?.map(part => part.text ?? '').join(''), usage: body.usage, stopReason: body.stop_reason };
})(context)`,
      },
      {
        name: 'anthropic-count-tokens',
        route: 'anthropic-count-tokens',
        description: 'Count the tokens a prompt would cost before sending it. Invoke with { "prompt": "..." }.',
        code: `// Prices a prompt before you pay for it: same body as a message, no generation.
(async (context) => {
  const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: context.model ?? 'claude-sonnet-5',
      system: context.system,
      messages: Array.isArray(context.messages)
        ? context.messages
        : [{ role: 'user', content: String(context.prompt ?? '') }],
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? 'Anthropic error ' + res.status);
  return { inputTokens: body.input_tokens };
})(context)`,
      },
    ],
  },
  {
    key: 'sendgrid',
    name: 'SendGrid',
    description: 'Send transactional email, plain or from a dynamic template.',
    category: 'email',
    docsUrl: 'https://www.twilio.com/docs/sendgrid/api-reference',
    secrets: [
      { name: 'SENDGRID_API_KEY', label: 'API key', placeholder: 'SG.…' },
      { name: 'SENDGRID_FROM', label: 'From address', placeholder: 'noreply@example.com' },
    ],
    functions: [
      {
        name: 'sendgrid-email',
        route: 'sendgrid-email',
        description: 'Send an email. Invoke with { "to": "a@b.c", "subject": "...", "html": "..." }.',
        code: `// Sends an email via SendGrid v3. A successful send answers 202 with no body.
(async (context) => {
  if (!context.to) throw new Error('to is required');
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.SENDGRID_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: context.to }] }],
      from: { email: env.SENDGRID_FROM },
      subject: context.subject ?? '(no subject)',
      content: [{ type: context.html ? 'text/html' : 'text/plain', value: context.html ?? context.text ?? '' }],
    }),
  });
  if (!res.ok) throw new Error('SendGrid error ' + res.status + ' ' + (await res.text()));
  return { sent: true, messageId: res.headers['x-message-id'] };
})(context)`,
      },
      {
        name: 'sendgrid-template',
        route: 'sendgrid-template',
        description: 'Send a dynamic template. Invoke with { "to": "a@b.c", "templateId": "d-…", "data": { "name": "Ada" } }.',
        code: `// Sends a SendGrid dynamic template, so the copy lives in SendGrid rather
// than in this function.
(async (context) => {
  if (!context.to) throw new Error('to is required');
  if (!context.templateId) throw new Error('templateId is required');
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.SENDGRID_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: context.to }], dynamic_template_data: context.data ?? {} }],
      from: { email: env.SENDGRID_FROM },
      template_id: String(context.templateId),
    }),
  });
  if (!res.ok) throw new Error('SendGrid error ' + res.status + ' ' + (await res.text()));
  return { sent: true, messageId: res.headers['x-message-id'] };
})(context)`,
      },
    ],
  },
  {
    key: 'postmark',
    name: 'Postmark',
    description: 'Send transactional email, plain or templated, through Postmark.',
    category: 'email',
    docsUrl: 'https://postmarkapp.com/developer/api/email-api',
    secrets: [
      { name: 'POSTMARK_SERVER_TOKEN', label: 'Server token', placeholder: '00000000-0000-…' },
      { name: 'POSTMARK_FROM', label: 'From address', placeholder: 'noreply@example.com' },
    ],
    functions: [
      {
        name: 'postmark-email',
        route: 'postmark-email',
        description: 'Send an email. Invoke with { "to": "a@b.c", "subject": "...", "html": "..." }.',
        code: `// Sends an email via Postmark.
(async (context) => {
  if (!context.to) throw new Error('to is required');
  const res = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'X-Postmark-Server-Token': env.POSTMARK_SERVER_TOKEN,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      From: env.POSTMARK_FROM,
      To: context.to,
      Cc: context.cc,
      Bcc: context.bcc,
      ReplyTo: context.replyTo,
      Subject: context.subject ?? '(no subject)',
      HtmlBody: context.html,
      TextBody: context.text,
      MessageStream: context.stream ?? 'outbound',
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.Message ?? 'Postmark error ' + res.status);
  return { id: body.MessageID, submittedAt: body.SubmittedAt };
})(context)`,
      },
      {
        name: 'postmark-template',
        route: 'postmark-template',
        description: 'Send a template. Invoke with { "to": "a@b.c", "templateAlias": "welcome", "model": { "name": "Ada" } }.',
        code: `// Sends a Postmark template by alias (or by TemplateId if you pass templateId).
(async (context) => {
  if (!context.to) throw new Error('to is required');
  if (!context.templateAlias && !context.templateId) throw new Error('templateAlias or templateId is required');
  const res = await fetch('https://api.postmarkapp.com/email/withTemplate', {
    method: 'POST',
    headers: {
      'X-Postmark-Server-Token': env.POSTMARK_SERVER_TOKEN,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      From: env.POSTMARK_FROM,
      To: context.to,
      TemplateAlias: context.templateAlias,
      TemplateId: context.templateId,
      TemplateModel: context.model ?? {},
      MessageStream: context.stream ?? 'outbound',
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.Message ?? 'Postmark error ' + res.status);
  return { id: body.MessageID, submittedAt: body.SubmittedAt };
})(context)`,
      },
    ],
  },
  {
    key: 'telegram',
    name: 'Telegram',
    description: 'Send bot messages, register the webhook, and receive verified updates.',
    category: 'messaging',
    docsUrl: 'https://core.telegram.org/bots/api',
    secrets: [
      { name: 'TELEGRAM_BOT_TOKEN', label: 'Bot token', placeholder: '123456:ABC-DEF…' },
      { name: 'TELEGRAM_CHAT_ID', label: 'Default chat ID', placeholder: '-1001234567890', optional: true },
      {
        name: 'TELEGRAM_WEBHOOK_SECRET',
        label: 'Webhook secret token',
        placeholder: 'any string you choose',
        optional: true,
      },
    ],
    functions: [
      {
        name: 'telegram-send',
        route: 'telegram-send',
        description: 'Send a message. Invoke with { "text": "...", "chatId": "..." }.',
        code: `// Sends one message through the Telegram Bot API.
(async (context) => {
  const chatId = context.chatId ?? env.TELEGRAM_CHAT_ID;
  if (!chatId) throw new Error('No chatId given and TELEGRAM_CHAT_ID is not set');
  const res = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: String(context.text ?? ''),
      parse_mode: context.parseMode,
      disable_notification: context.silent === true,
      reply_to_message_id: context.replyTo,
    }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(body?.description ?? 'Telegram error ' + res.status);
  return { messageId: body.result.message_id };
})(context)`,
      },
      {
        name: 'telegram-set-webhook',
        route: 'telegram-set-webhook',
        description: 'Register the receiver with Telegram. Invoke with { "url": "https://your-host/functions/v1/telegram-webhook" }.',
        code: `// Registers a webhook URL with Telegram and attaches the secret token, so
// telegram-webhook can prove a delivery came from Telegram.
(async (context) => {
  if (!context.url) throw new Error('url is required (the public URL of telegram-webhook)');
  const res = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/setWebhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: String(context.url),
      secret_token: env.TELEGRAM_WEBHOOK_SECRET || undefined,
      drop_pending_updates: context.dropPending === true,
    }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(body?.description ?? 'Telegram error ' + res.status);
  return { registered: true, url: context.url, withSecret: Boolean(env.TELEGRAM_WEBHOOK_SECRET) };
})(context)`,
      },
      {
        name: 'telegram-webhook',
        route: 'telegram-webhook',
        kind: 'webhook',
        description:
          'Verified Telegram update receiver. Set TELEGRAM_WEBHOOK_SECRET, then run telegram-set-webhook with this route URL.',
        code: `${WEBHOOK_PRELUDE}
// Telegram update receiver.
//
// Telegram has no body signature: it echoes the secret_token you registered in
// X-Telegram-Bot-Api-Secret-Token. That is the whole check, so it has to be
// present and compared in constant time.
export default async (req) => {
  if (req.method !== 'POST') return reject('method not allowed', 405);

  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return reject('TELEGRAM_WEBHOOK_SECRET is not set', 500);

  const given = req.headers.get('x-telegram-bot-api-secret-token') || '';
  if (!safeEqual(given, secret)) return reject('invalid secret token', 401);

  const update = JSON.parse(await req.text());
  const message = update.message ?? update.edited_message ?? update.channel_post;
  const text = message?.text ?? '';

  // Telegram retries an update it did not get a 2xx for: update_id is the
  // stable key to deduplicate on.
  if (text.startsWith('/start')) {
    await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: message.chat.id, text: 'Hello from Motherbase.' }),
    });
  } else {
    console.log('telegram update', update.update_id, text);
  }

  return Response.json({ ok: true });
};`,
      },
    ],
  },
  {
    key: 'linear',
    name: 'Linear',
    description: 'Read issues, create and comment on them, and receive signed Linear webhooks.',
    category: 'devtools',
    docsUrl: 'https://developers.linear.app/docs/graphql/working-with-the-graphql-api',
    secrets: [
      { name: 'LINEAR_API_KEY', label: 'API key', placeholder: 'lin_api_…' },
      { name: 'LINEAR_TEAM_ID', label: 'Team ID', placeholder: 'uuid of the team', optional: true },
      { name: 'LINEAR_WEBHOOK_SECRET', label: 'Webhook signing secret', placeholder: 'shown when you create the webhook', optional: true },
    ],
    functions: [
      {
        name: 'linear-issues',
        route: 'linear-issues',
        description: 'List recently updated issues.',
        code: `// Lists recent Linear issues through the GraphQL API.
(async (context) => {
  const first = Math.min(Number(context.limit ?? 25), 100);
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { Authorization: env.LINEAR_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: 'query($first:Int!){issues(first:$first,orderBy:updatedAt){nodes{id identifier title state{name} url updatedAt}}}',
      variables: { first },
    }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(body.errors[0]?.message ?? 'Linear error');
  return body.data.issues.nodes;
})(context)`,
      },
      {
        name: 'linear-create-issue',
        route: 'linear-create-issue',
        description: 'Create an issue. Invoke with { "title": "...", "description": "...", "teamId": "..." }.',
        code: `// Creates one Linear issue.
(async (context) => {
  const teamId = context.teamId ?? env.LINEAR_TEAM_ID;
  if (!teamId) throw new Error('No teamId given and LINEAR_TEAM_ID is not set');
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { Authorization: env.LINEAR_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: 'mutation($input:IssueCreateInput!){issueCreate(input:$input){success issue{id identifier url}}}',
      variables: {
        input: {
          teamId,
          title: String(context.title ?? ''),
          description: context.description,
          priority: context.priority,
          labelIds: Array.isArray(context.labelIds) ? context.labelIds : undefined,
        },
      },
    }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(body.errors[0]?.message ?? 'Linear error');
  return body.data.issueCreate.issue;
})(context)`,
      },
      {
        name: 'linear-comment',
        route: 'linear-comment',
        description: 'Comment on an issue. Invoke with { "issueId": "…", "body": "markdown" }.',
        code: `// Adds one comment to a Linear issue (how a deploy or an alert reports back).
(async (context) => {
  if (!context.issueId) throw new Error('issueId is required');
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { Authorization: env.LINEAR_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: 'mutation($input:CommentCreateInput!){commentCreate(input:$input){success comment{id url}}}',
      variables: { input: { issueId: String(context.issueId), body: String(context.body ?? '') } },
    }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(body.errors[0]?.message ?? 'Linear error');
  return body.data.commentCreate.comment;
})(context)`,
      },
      {
        name: 'linear-webhook',
        route: 'linear-webhook',
        kind: 'webhook',
        description:
          'Signature-verified Linear webhook receiver. Create the webhook in Linear settings with this route and store its secret in LINEAR_WEBHOOK_SECRET.',
        code: `${WEBHOOK_PRELUDE}
// Linear webhook receiver.
//
// Linear signs the raw body with HMAC-SHA256 (hex) in the Linear-Signature
// header, and puts a send timestamp in the payload: Linear's own guidance is to
// reject a payload older than a minute.
const TOLERANCE_MS = 60_000;

export default async (req) => {
  if (req.method !== 'POST') return reject('method not allowed', 405);

  const secret = env.LINEAR_WEBHOOK_SECRET;
  if (!secret) return reject('LINEAR_WEBHOOK_SECRET is not set', 500);

  const raw = await req.text();
  const given = req.headers.get('linear-signature') || '';
  if (!given) return reject('missing Linear-Signature');

  const expected = await hmacHex(secret, raw);
  if (!safeEqual(given, expected)) return reject('invalid signature');

  const payload = JSON.parse(raw);
  if (payload.webhookTimestamp && Math.abs(Date.now() - Number(payload.webhookTimestamp)) > TOLERANCE_MS) {
    return reject('timestamp outside the replay window');
  }

  console.log('linear', payload.type, payload.action, payload.data?.identifier ?? payload.data?.id);
  return Response.json({ received: true });
};`,
      },
    ],
  },
  {
    key: 'sentry',
    name: 'Sentry',
    description: 'Read unresolved issues, resolve them, and list recent releases.',
    category: 'devtools',
    docsUrl: 'https://docs.sentry.io/api/events/list-a-projects-issues/',
    secrets: [
      { name: 'SENTRY_AUTH_TOKEN', label: 'Auth token', placeholder: 'sntrys_…' },
      { name: 'SENTRY_ORG', label: 'Organization slug', placeholder: 'acme' },
      { name: 'SENTRY_PROJECT', label: 'Project slug', placeholder: 'backend' },
    ],
    functions: [
      {
        name: 'sentry-issues',
        route: 'sentry-issues',
        description: 'List unresolved issues for the configured project.',
        code: `// Lists unresolved Sentry issues for the configured project.
(async (context) => {
  const url = 'https://sentry.io/api/0/projects/' + env.SENTRY_ORG + '/' + env.SENTRY_PROJECT +
    '/issues/?query=' + encodeURIComponent(context.query ?? 'is:unresolved');
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + env.SENTRY_AUTH_TOKEN } });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.detail ?? 'Sentry error ' + res.status);
  return body.map(i => ({ id: i.id, title: i.title, count: i.count, lastSeen: i.lastSeen, permalink: i.permalink }));
})(context)`,
      },
      {
        name: 'sentry-resolve-issue',
        route: 'sentry-resolve-issue',
        description: 'Resolve or ignore an issue. Invoke with { "issueId": "…", "status": "resolved" }.',
        code: `// Moves one Sentry issue to resolved (or ignored).
(async (context) => {
  if (!context.issueId) throw new Error('issueId is required');
  const status = String(context.status ?? 'resolved');
  const res = await fetch('https://sentry.io/api/0/issues/' + encodeURIComponent(String(context.issueId)) + '/', {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + env.SENTRY_AUTH_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.detail ?? 'Sentry error ' + res.status);
  return { id: body.id, status: body.status };
})(context)`,
      },
      {
        name: 'sentry-releases',
        route: 'sentry-releases',
        description: 'List recent releases for the project.',
        code: `// Lists recent Sentry releases: what shipped, and when errors started.
(async (context) => {
  const url = 'https://sentry.io/api/0/projects/' + env.SENTRY_ORG + '/' + env.SENTRY_PROJECT + '/releases/';
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + env.SENTRY_AUTH_TOKEN } });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.detail ?? 'Sentry error ' + res.status);
  const limit = Math.min(Number(context.limit ?? 10), 50);
  return body.slice(0, limit).map(r => ({ version: r.version, released: r.dateReleased, newGroups: r.newGroups }));
})(context)`,
      },
    ],
  },
  {
    key: 'posthog',
    name: 'PostHog',
    description: 'Capture backend events, identify users and read feature flags.',
    category: 'data',
    docsUrl: 'https://posthog.com/docs/api/capture',
    secrets: [
      { name: 'POSTHOG_API_KEY', label: 'Project API key', placeholder: 'phc_…' },
      { name: 'POSTHOG_HOST', label: 'Host', placeholder: 'https://eu.i.posthog.com', optional: true },
    ],
    functions: [
      {
        name: 'posthog-capture',
        route: 'posthog-capture',
        description: 'Capture an event. Invoke with { "event": "signed_up", "distinctId": "usr_1", "properties": {} }.',
        code: `// Captures one PostHog event. POSTHOG_HOST selects the region, US by default.
(async (context) => {
  const base = env.POSTHOG_HOST || 'https://us.i.posthog.com';
  const host = base.endsWith('/') ? base.slice(0, -1) : base;
  const res = await fetch(host + '/capture/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: env.POSTHOG_API_KEY,
      event: String(context.event ?? 'server_event'),
      distinct_id: String(context.distinctId ?? 'anonymous'),
      properties: context.properties ?? {},
      timestamp: new Date().toISOString(),
    }),
  });
  if (!res.ok) throw new Error('PostHog error ' + res.status + ' ' + (await res.text()));
  return { captured: true };
})(context)`,
      },
      {
        name: 'posthog-identify',
        route: 'posthog-identify',
        description: 'Attach person properties. Invoke with { "distinctId": "usr_1", "properties": { "plan": "pro" } }.',
        code: `// Sets person properties in PostHog, so later events carry the user's plan,
// company and signup date without resending them each time.
(async (context) => {
  if (!context.distinctId) throw new Error('distinctId is required');
  const base = env.POSTHOG_HOST || 'https://us.i.posthog.com';
  const host = base.endsWith('/') ? base.slice(0, -1) : base;
  const res = await fetch(host + '/capture/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: env.POSTHOG_API_KEY,
      event: '$identify',
      distinct_id: String(context.distinctId),
      properties: { $set: context.properties ?? {}, $set_once: context.setOnce ?? {} },
      timestamp: new Date().toISOString(),
    }),
  });
  if (!res.ok) throw new Error('PostHog error ' + res.status + ' ' + (await res.text()));
  return { identified: true };
})(context)`,
      },
      {
        name: 'posthog-flags',
        route: 'posthog-flags',
        description: 'Evaluate feature flags for a user. Invoke with { "distinctId": "usr_1" }.',
        code: `// Evaluates PostHog feature flags server-side, so a backend branch matches
// what the user sees in the UI.
(async (context) => {
  if (!context.distinctId) throw new Error('distinctId is required');
  const base = env.POSTHOG_HOST || 'https://us.i.posthog.com';
  const host = base.endsWith('/') ? base.slice(0, -1) : base;
  const res = await fetch(host + '/decide?v=3', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: env.POSTHOG_API_KEY,
      distinct_id: String(context.distinctId),
      person_properties: context.properties ?? {},
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error('PostHog error ' + res.status);
  return { flags: body.featureFlags ?? {}, payloads: body.featureFlagPayloads ?? {} };
})(context)`,
      },
    ],
  },
  {
    key: 'algolia',
    name: 'Algolia',
    description: 'Search, index and delete records in Algolia.',
    category: 'data',
    docsUrl: 'https://www.algolia.com/doc/rest-api/search/',
    secrets: [
      { name: 'ALGOLIA_APP_ID', label: 'Application ID', placeholder: 'XXXXXXXXXX' },
      { name: 'ALGOLIA_ADMIN_KEY', label: 'Admin API key', placeholder: '32-char key' },
      { name: 'ALGOLIA_INDEX', label: 'Index name', placeholder: 'products' },
    ],
    functions: [
      {
        name: 'algolia-search',
        route: 'algolia-search',
        description: 'Search the configured index. Invoke with { "query": "shoes", "filters": "price < 50" }.',
        code: `// Searches the configured Algolia index.
(async (context) => {
  const res = await fetch('https://' + env.ALGOLIA_APP_ID + '-dsn.algolia.net/1/indexes/' + env.ALGOLIA_INDEX + '/query', {
    method: 'POST',
    headers: {
      'X-Algolia-API-Key': env.ALGOLIA_ADMIN_KEY,
      'X-Algolia-Application-Id': env.ALGOLIA_APP_ID,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: String(context.query ?? ''),
      filters: context.filters,
      page: context.page,
      hitsPerPage: Math.min(Number(context.limit ?? 20), 100),
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.message ?? 'Algolia error ' + res.status);
  return { hits: body.hits, found: body.nbHits, pages: body.nbPages };
})(context)`,
      },
      {
        name: 'algolia-index',
        route: 'algolia-index',
        description: 'Upsert records. Invoke with { "records": [{ "objectID": "1", ... }] }.',
        code: `// Upserts a batch of records into the configured Algolia index.
(async (context) => {
  const records = Array.isArray(context.records) ? context.records : [];
  if (records.length === 0) throw new Error('No records given');
  const res = await fetch('https://' + env.ALGOLIA_APP_ID + '.algolia.net/1/indexes/' + env.ALGOLIA_INDEX + '/batch', {
    method: 'POST',
    headers: {
      'X-Algolia-API-Key': env.ALGOLIA_ADMIN_KEY,
      'X-Algolia-Application-Id': env.ALGOLIA_APP_ID,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ requests: records.map(record => ({ action: 'partialUpdateObject', body: record })) }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.message ?? 'Algolia error ' + res.status);
  return { taskID: body.taskID, count: records.length };
})(context)`,
      },
      {
        name: 'algolia-delete',
        route: 'algolia-delete',
        description: 'Delete records by objectID. Invoke with { "objectIDs": ["1", "2"] }.',
        code: `// Deletes records from the configured index. The row is gone from search the
// moment Algolia processes the task, so mirror your own deletes here.
(async (context) => {
  const ids = Array.isArray(context.objectIDs) ? context.objectIDs : [];
  if (ids.length === 0) throw new Error('objectIDs is required');
  const res = await fetch('https://' + env.ALGOLIA_APP_ID + '.algolia.net/1/indexes/' + env.ALGOLIA_INDEX + '/batch', {
    method: 'POST',
    headers: {
      'X-Algolia-API-Key': env.ALGOLIA_ADMIN_KEY,
      'X-Algolia-Application-Id': env.ALGOLIA_APP_ID,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ requests: ids.map(objectID => ({ action: 'deleteObject', body: { objectID: String(objectID) } })) }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.message ?? 'Algolia error ' + res.status);
  return { taskID: body.taskID, deleted: ids.length };
})(context)`,
      },
    ],
  },
  {
    key: 'shopify',
    name: 'Shopify',
    description: 'Read orders and customers, and receive HMAC-verified store webhooks.',
    category: 'payments',
    docsUrl: 'https://shopify.dev/docs/api/admin-rest',
    secrets: [
      { name: 'SHOPIFY_SHOP', label: 'Shop domain', placeholder: 'acme.myshopify.com' },
      { name: 'SHOPIFY_ACCESS_TOKEN', label: 'Admin API access token', placeholder: 'shpat_…' },
      { name: 'SHOPIFY_WEBHOOK_SECRET', label: 'Webhook signing secret', placeholder: 'from the app settings', optional: true },
    ],
    functions: [
      {
        name: 'shopify-orders',
        route: 'shopify-orders',
        description: 'List recent orders. Invoke with { "limit": 25, "status": "any" }.',
        code: `// Lists recent Shopify orders through the Admin REST API.
(async (context) => {
  const limit = Math.min(Number(context.limit ?? 25), 250);
  const res = await fetch('https://' + env.SHOPIFY_SHOP + '/admin/api/2024-10/orders.json?status=' + encodeURIComponent(String(context.status ?? 'any')) + '&limit=' + limit, {
    headers: { 'X-Shopify-Access-Token': env.SHOPIFY_ACCESS_TOKEN },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.errors ? JSON.stringify(body.errors) : 'Shopify error ' + res.status);
  return body.orders.map(o => ({ id: o.id, name: o.name, total: o.total_price, email: o.email, createdAt: o.created_at }));
})(context)`,
      },
      {
        name: 'shopify-customers',
        route: 'shopify-customers',
        description: 'Search customers. Invoke with { "query": "email:a@b.c" }.',
        code: `// Searches Shopify customers, or lists the most recent ones without a query.
(async (context) => {
  const limit = Math.min(Number(context.limit ?? 25), 250);
  const base = 'https://' + env.SHOPIFY_SHOP + '/admin/api/2024-10/customers';
  const url = context.query
    ? base + '/search.json?query=' + encodeURIComponent(String(context.query)) + '&limit=' + limit
    : base + '.json?limit=' + limit;
  const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': env.SHOPIFY_ACCESS_TOKEN } });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.errors ? JSON.stringify(body.errors) : 'Shopify error ' + res.status);
  return body.customers.map(c => ({ id: c.id, email: c.email, name: (c.first_name || '') + ' ' + (c.last_name || ''), orders: c.orders_count }));
})(context)`,
      },
      {
        name: 'shopify-webhook',
        route: 'shopify-webhook',
        kind: 'webhook',
        description:
          'HMAC-verified Shopify webhook receiver (orders/create and friends). Store the app signing secret in SHOPIFY_WEBHOOK_SECRET.',
        code: `${WEBHOOK_PRELUDE}
// Shopify webhook receiver.
//
// Shopify signs the raw body with HMAC-SHA256 and sends it base64 encoded in
// X-Shopify-Hmac-Sha256. Shopify gives up after a 5 second wait, so keep the
// work here to a queue insert.
export default async (req) => {
  if (req.method !== 'POST') return reject('method not allowed', 405);

  const secret = env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) return reject('SHOPIFY_WEBHOOK_SECRET is not set', 500);

  const raw = await req.text();
  const given = req.headers.get('x-shopify-hmac-sha256') || '';
  if (!given) return reject('missing X-Shopify-Hmac-Sha256');

  const expected = await hmacBase64(secret, raw);
  if (!safeEqual(given, expected)) return reject('invalid signature');

  const topic = req.headers.get('x-shopify-topic') || 'unknown';
  // X-Shopify-Webhook-Id repeats across retries of the same delivery.
  const deliveryId = req.headers.get('x-shopify-webhook-id') || '';
  const payload = JSON.parse(raw);

  switch (topic) {
    case 'orders/create':
      console.log('order', payload.name, payload.total_price, payload.email);
      break;
    case 'orders/cancelled':
      console.log('order cancelled', payload.name);
      break;
    default:
      console.log('unhandled shopify topic', topic);
  }

  return Response.json({ received: true, topic, deliveryId });
};`,
      },
    ],
  },
  {
    key: 'cloudflare',
    name: 'Cloudflare',
    description: 'Purge the CDN cache and manage DNS records for a zone.',
    category: 'devtools',
    docsUrl: 'https://developers.cloudflare.com/api/operations/zone-purge',
    secrets: [
      { name: 'CLOUDFLARE_API_TOKEN', label: 'API token', placeholder: 'token with Cache Purge' },
      { name: 'CLOUDFLARE_ZONE_ID', label: 'Zone ID', placeholder: '32-char id' },
    ],
    functions: [
      {
        name: 'cloudflare-purge',
        route: 'cloudflare-purge',
        description: 'Purge cache. Invoke with { "files": ["https://…"] }, { "tags": ["…"] }, or nothing to purge everything.',
        code: `// Purges the Cloudflare cache for the configured zone: by URL, by cache tag,
// or (with no argument) the whole zone.
(async (context) => {
  const files = Array.isArray(context.files) && context.files.length > 0 ? context.files : null;
  const tags = Array.isArray(context.tags) && context.tags.length > 0 ? context.tags : null;
  const payload = files ? { files } : tags ? { tags } : { purge_everything: true };
  const res = await fetch('https://api.cloudflare.com/client/v4/zones/' + env.CLOUDFLARE_ZONE_ID + '/purge_cache', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.CLOUDFLARE_API_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!body.success) throw new Error(body?.errors?.[0]?.message ?? 'Cloudflare error ' + res.status);
  return { purged: files ? files.length : tags ? tags.length : 'everything' };
})(context)`,
      },
      {
        name: 'cloudflare-dns-records',
        route: 'cloudflare-dns-records',
        description: 'List DNS records for the zone. Invoke with { "type": "A", "name": "app.example.com" }.',
        code: `// Lists the zone's DNS records, optionally filtered by type and name.
(async (context) => {
  let query = 'per_page=100';
  if (context.type) query += '&type=' + encodeURIComponent(String(context.type));
  if (context.name) query += '&name=' + encodeURIComponent(String(context.name));
  const res = await fetch('https://api.cloudflare.com/client/v4/zones/' + env.CLOUDFLARE_ZONE_ID + '/dns_records?' + query, {
    headers: { Authorization: 'Bearer ' + env.CLOUDFLARE_API_TOKEN },
  });
  const body = await res.json();
  if (!body.success) throw new Error(body?.errors?.[0]?.message ?? 'Cloudflare error ' + res.status);
  return body.result.map(r => ({ id: r.id, type: r.type, name: r.name, content: r.content, proxied: r.proxied }));
})(context)`,
      },
      {
        name: 'cloudflare-upsert-dns',
        route: 'cloudflare-upsert-dns',
        description: 'Create or update a record. Invoke with { "type": "A", "name": "app.example.com", "content": "1.2.3.4" }.',
        code: `// Creates a DNS record, or updates the existing one with the same type+name.
// Two records with the same name is the usual accident here, hence the lookup.
(async (context) => {
  if (!context.name || !context.content) throw new Error('name and content are required');
  const type = String(context.type ?? 'A');
  const headers = { Authorization: 'Bearer ' + env.CLOUDFLARE_API_TOKEN, 'Content-Type': 'application/json' };
  const base = 'https://api.cloudflare.com/client/v4/zones/' + env.CLOUDFLARE_ZONE_ID + '/dns_records';

  const found = await (await fetch(base + '?type=' + encodeURIComponent(type) + '&name=' + encodeURIComponent(String(context.name)), { headers })).json();
  const existing = found?.result?.[0];

  const payload = {
    type,
    name: String(context.name),
    content: String(context.content),
    ttl: Number(context.ttl ?? 1),
    proxied: context.proxied === true,
  };
  const res = await fetch(existing ? base + '/' + existing.id : base, {
    method: existing ? 'PUT' : 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!body.success) throw new Error(body?.errors?.[0]?.message ?? 'Cloudflare error ' + res.status);
  return { id: body.result.id, name: body.result.name, content: body.result.content, updated: Boolean(existing) };
})(context)`,
      },
    ],
  },
  {
    key: 'hubspot',
    name: 'HubSpot',
    description: 'Read, create and search CRM contacts, and open deals.',
    category: 'data',
    docsUrl: 'https://developers.hubspot.com/docs/api/crm/contacts',
    secrets: [
      { name: 'HUBSPOT_ACCESS_TOKEN', label: 'Private app token', placeholder: 'pat-…' },
    ],
    functions: [
      {
        name: 'hubspot-contacts',
        route: 'hubspot-contacts',
        description: 'List recent contacts.',
        code: `// Lists recent HubSpot CRM contacts.
(async (context) => {
  const limit = Math.min(Number(context.limit ?? 25), 100);
  const res = await fetch('https://api.hubapi.com/crm/v3/objects/contacts?limit=' + limit, {
    headers: { Authorization: 'Bearer ' + env.HUBSPOT_ACCESS_TOKEN },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.message ?? 'HubSpot error ' + res.status);
  return body.results.map(c => ({ id: c.id, ...c.properties }));
})(context)`,
      },
      {
        name: 'hubspot-create-contact',
        route: 'hubspot-create-contact',
        description: 'Create a contact. Invoke with { "email": "a@b.c", "firstname": "...", "lastname": "..." }.',
        code: `// Creates one HubSpot CRM contact.
(async (context) => {
  const { email, ...rest } = context;
  if (!email) throw new Error('email is required');
  const res = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.HUBSPOT_ACCESS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ properties: { email, ...rest } }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.message ?? 'HubSpot error ' + res.status);
  return { id: body.id };
})(context)`,
      },
      {
        name: 'hubspot-search-contacts',
        route: 'hubspot-search-contacts',
        description: 'Find contacts by property. Invoke with { "property": "email", "value": "a@b.c" }.',
        code: `// Searches contacts by an exact property value: the lookup you need before
// creating a contact, so you update instead of duplicating.
(async (context) => {
  const property = String(context.property ?? 'email');
  if (context.value === undefined) throw new Error('value is required');
  const res = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.HUBSPOT_ACCESS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: property, operator: 'EQ', value: String(context.value) }] }],
      properties: Array.isArray(context.properties) ? context.properties : ['email', 'firstname', 'lastname', 'lifecyclestage'],
      limit: Math.min(Number(context.limit ?? 10), 100),
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.message ?? 'HubSpot error ' + res.status);
  return body.results.map(c => ({ id: c.id, ...c.properties }));
})(context)`,
      },
      {
        name: 'hubspot-create-deal',
        route: 'hubspot-create-deal',
        description: 'Open a deal. Invoke with { "name": "Acme · Pro", "amount": 4900, "stage": "appointmentscheduled", "contactId": "…" }.',
        code: `// Creates a deal and, when contactId is given, associates it with that contact.
(async (context) => {
  if (!context.name) throw new Error('name is required');
  const payload = {
    properties: {
      dealname: String(context.name),
      amount: context.amount === undefined ? undefined : String(context.amount),
      dealstage: context.stage,
      pipeline: context.pipeline,
      closedate: context.closeDate,
    },
  };
  if (context.contactId) {
    // 3 is HubSpot's association type id for deal -> contact.
    payload.associations = [{
      to: { id: String(context.contactId) },
      types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }],
    }];
  }
  const res = await fetch('https://api.hubapi.com/crm/v3/objects/deals', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.HUBSPOT_ACCESS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.message ?? 'HubSpot error ' + res.status);
  return { id: body.id };
})(context)`,
      },
    ],
  },
];

export function getIntegration(key: string): Integration | undefined {
  return INTEGRATIONS.find(i => i.key === key);
}
