// Starting points for a new edge function. Pure data, shared with
// `motherbase functions new --template` (packages/cli/src/edge-templates.js):
// keep the ids and sources in step.
//
// Every source is module-shaped (`export default handler`), running on the Deno
// edge runtime. `%NAME%` is replaced with the function's name.

export interface FunctionTemplate {
  id: string;
  label: string;
  description: string;
  source: string;
}

export const FUNCTION_TEMPLATES: FunctionTemplate[] = [
  {
    id: 'hello-world',
    label: 'Hello world',
    description: 'Echo the request body and the time.',
    source: `// Edge function: %NAME%
//
// Runs on Deno with the whole Web platform: Request, Response, fetch, streams,
// crypto.subtle (for webhook signature checks) and friends. npm:, jsr: and URL
// imports load as they do on Deno; a bare package name is read as npm:
//
//   import { z } from 'zod';
//
// \`env\` holds this project's edge secrets, and \`sendMail()\` sends through the
// project's own SMTP settings (the same transport auth uses):
//
//   await sendMail({ to: 'sales@example.com', subject: 'New lead', text: '...' });

export default async (req: Request) => {
  const body = req.method === 'GET' ? {} : await req.json().catch(() => ({}));
  return Response.json({ hello: '%NAME%', received: body, at: new Date().toISOString() });
};
`,
  },
  {
    id: 'stripe-webhook',
    label: 'Stripe webhook',
    description: 'Verify a Stripe signature, then handle the event.',
    source: `// Edge function: %NAME%
// Secrets to set: STRIPE_WEBHOOK_SECRET (the endpoint's "whsec_..." signing secret).

const encoder = new TextEncoder();

async function sign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return [...new Uint8Array(mac)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export default async (req: Request) => {
  // The raw body: a re-serialised one no longer matches the signature.
  const payload = await req.text();
  const header = req.headers.get('stripe-signature') ?? '';
  const parts = Object.fromEntries(header.split(',').map(part => part.split('=') as [string, string]));
  const expected = await sign(env.STRIPE_WEBHOOK_SECRET, \`\${parts.t}.\${payload}\`);
  if (!parts.v1 || parts.v1 !== expected) return new Response('Invalid signature', { status: 400 });

  const event = JSON.parse(payload);
  switch (event.type) {
    case 'checkout.session.completed':
      console.log('checkout completed', event.data.object.id);
      break;
    default:
      console.log('ignored event', event.type);
  }
  return Response.json({ received: true });
};
`,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'Send a prompt to OpenAI and return the answer.',
    source: `// Edge function: %NAME%
// Secrets to set: OPENAI_API_KEY.

export default async (req: Request) => {
  const { prompt } = await req.json();
  if (typeof prompt !== 'string' || !prompt) return Response.json({ error: 'prompt is required' }, { status: 400 });

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: \`Bearer \${env.OPENAI_API_KEY}\` },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }] }),
  });
  if (!response.ok) return Response.json({ error: 'OpenAI request failed' }, { status: 502 });

  const completion = await response.json();
  return Response.json({ answer: completion.choices[0].message.content });
};
`,
  },
  {
    id: 'resend-email',
    label: 'Send email',
    description: 'Send a transactional email with Resend, or with sendMail.',
    source: `// Edge function: %NAME%
// Secrets to set: RESEND_API_KEY. Prefer this project's own SMTP? Replace the
// fetch below with: await sendMail({ to, subject, html });

export default async (req: Request) => {
  const { to, subject, html } = await req.json();
  if (!to || !subject || !html) return Response.json({ error: 'to, subject and html are required' }, { status: 400 });

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: \`Bearer \${env.RESEND_API_KEY}\` },
    body: JSON.stringify({ from: 'Acme <onboarding@resend.dev>', to, subject, html }),
  });
  return Response.json(await response.json(), { status: response.ok ? 200 : 502 });
};
`,
  },
  {
    id: 'image-transform',
    label: 'Image transform',
    description: 'Resize an image fetched from a URL.',
    source: `// Edge function: %NAME%
// GET ?url=<image>&width=<px>. Uses ImageScript, a pure-JS image library.

import { Image } from 'npm:imagescript@1';

export default async (req: Request) => {
  const params = new URL(req.url).searchParams;
  const source = params.get('url');
  const width = Math.min(Number(params.get('width') ?? 320), 2000);
  if (!source || !Number.isFinite(width) || width < 1) return new Response('url and a positive width are required', { status: 400 });

  const upstream = await fetch(source);
  if (!upstream.ok) return new Response('Could not fetch the image', { status: 502 });

  const image = await Image.decode(new Uint8Array(await upstream.arrayBuffer()));
  const resized = image.resize(width, Image.RESIZE_AUTO);
  return new Response(await resized.encode(), { headers: { 'content-type': 'image/png' } });
};
`,
  },
  {
    id: 'websocket',
    label: 'WebSocket',
    description: 'Upgrade the request and echo every message.',
    source: `// Edge function: %NAME%

export default (req: Request) => {
  if (req.headers.get('upgrade') !== 'websocket') return new Response('Expected a WebSocket upgrade', { status: 426 });

  const { socket, response } = Deno.upgradeWebSocket(req);
  socket.onopen = () => console.log('client connected');
  socket.onmessage = event => socket.send(\`echo: \${event.data}\`);
  socket.onclose = () => console.log('client disconnected');
  return response;
};
`,
  },
  {
    id: 'storage-upload',
    label: 'Storage upload',
    description: 'Store a request body as a file in Storage.',
    source: `// Edge function: %NAME%
// Secrets to set: SERVICE_TOKEN (a token allowed to write files). API_URL is
// optional and defaults to this project's own API.

export default async (req: Request) => {
  const { path, text } = await req.json();
  if (!path || typeof text !== 'string') return Response.json({ error: 'path and text are required' }, { status: 400 });

  const form = new FormData();
  form.append('file', new Blob([text], { type: 'text/plain' }), path);
  form.append('path', path);

  const response = await fetch(\`\${env.API_URL ?? 'http://api:5001'}/api/files/\`, {
    method: 'POST',
    headers: { authorization: \`Bearer \${env.SERVICE_TOKEN}\` },
    body: form,
  });
  return Response.json(await response.json(), { status: response.ok ? 200 : 502 });
};
`,
  },
];

/** The source of a template for a function of this name. */
export function renderFunctionTemplate(template: FunctionTemplate, name: string): string {
  return template.source.replace(/%NAME%/g, name || 'my-function');
}
