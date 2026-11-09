# Edge functions

Edge functions run on Deno, in a private sidecar next to the project API
(`deploy/edge-runtime`). Each function gets its own OS process, capped in
memory and killed at its timeout, and two functions never share a process. The
server side of it is `apps/server/services/admin/edge-sandbox.ts`.

Supabase functions run as written: `Deno.serve(handler)` and
`export default handler` are both entry points, and `Deno.env.get('X')` reads
the same secrets as `env.X`.

```ts
export default async (req: Request) => {
  const lead = await req.json();
  await sendMail({
    to: 'sales@example.com',
    subject: `New lead: ${lead.email}`,
    text: JSON.stringify(lead, null, 2),
  });
  return Response.json({ ok: true });
};
```

## Authoring

```bash
motherbase functions new notify-lead     # functions/notify-lead/index.ts (+ motherbase.d.ts)
motherbase functions deploy notify-lead
```

`functions new <name> --template <id>` starts from a template instead of the
hello world: `stripe-webhook`, `openai`, `resend-email`, `image-transform`,
`websocket` or `storage-upload`. Studio offers the same list when you create a
function. Each one names the secrets it reads in its first lines.

`motherbase functions new` also writes `functions/motherbase.d.ts` once, so an
editor knows the injected globals below. It is generated: delete it and scaffold
again to refresh it.

Imports load the way they do on Deno: `npm:zod@3`, `jsr:@std/encoding@1`,
`https://esm.sh/…`. A bare package name (`import { z } from 'zod'`) is read as
`npm:zod`, so functions written for Node keep working. Deploying a function
loads it once without calling it, so an import that does not resolve is a 400
on save, not a 500 on the first invocation.

## What a function gets

The Web platform as Deno ships it (`Request`, `Response`, `fetch`, streams,
`crypto.subtle`, `URL`, `TextEncoder`…), plus:

| Global | Notes |
| --- | --- |
| `console.log` / `.warn` / `.error` | Captured in full on the invocation's own log row; the first 20 lines per invocation are also mirrored into the Logs stream, with a "… N more line(s) truncated" marker after them. |
| `fetch` | Refuses private, loopback and reserved addresses, including after a redirect. The one exception is this project's own API (`http://api:5001` inside the stack). |
| `sendMail` | This project's SMTP. See below. |
| `env` / `Deno.env.get()` | This project's edge secrets, frozen. Requires `EDGE_SECRETS_ENABLED=true` on the API, otherwise it is empty and the logs say so. Nothing else of the host environment is readable. |
| `context` | The invoke payload, for the older expression-shaped form. Module-shaped functions read the `Request` instead. |

## Sending email

```ts
await sendMail({ to: 'sales@example.com', subject: 'New lead', text: 'body' });
await sendMail({ to: 'sales@example.com', subject: 'New lead', html: '<b>body</b>' });
```

The project API sends it: the function's call goes back to the API with a
token that is only valid for that invocation. It is the same `TransporterService` and the same `email.smtp` settings the auth emails
(magic links, OTP, password resets) already use: configure SMTP once under
Settings, and functions inherit it. Nothing to sign up for, no API key to store.

`sendMail` rejects (a normal `throw` you can catch) when:

- `to` is missing or is not an address,
- `subject` is missing, or neither `text` nor `html` is given,
- SMTP is unconfigured or the server refuses the message.

The validation happens in the API, not in the function: operator code is the
untrusted side of that boundary.

There is no queue and no retry. If losing a notification matters, write the row
first and send afterwards, so a failed send leaves the data behind.

A third-party HTTP mail API (Resend, Postmark, SendGrid) still works through
`fetch` if you would rather not run SMTP. `sendMail` is the zero-configuration
path, not the only one.

## Limits

Memory and timeout are per function (`memoryLimitMb`, `timeoutMs`), clamped by
the server. A function past its timeout has its process killed, busy loop or
not. Scheduled functions (`schedule`, a cron expression) run through the exact
same runtime as an HTTP invocation.

## Running it

In Docker the `edge-runtime` service starts with the stack. It shares a network
with the API and nothing else, so operator code has no route to Postgres or
MinIO. It needs outbound internet for `npm:`/`jsr:` imports and third-party APIs.
On a host that can only reach the internet through a proxy, set `HTTPS_PROXY`
(and `NO_PROXY`, plus `DENO_CERT` if the proxy presents its own CA) on the
`edge-runtime` service: every function process inherits those, and nothing else
of the host environment.

Locally, with Deno 2 installed:

```bash
npm run edge-runtime    # reads apps/server/.env: EDGE_RUNTIME_TOKEN, EDGE_RUNTIME_URL
```

The API and the sidecar must share `EDGE_RUNTIME_TOKEN`; `./setup.sh` generates
one, and the Console generates one per project.
