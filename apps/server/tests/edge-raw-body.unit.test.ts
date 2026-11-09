// A webhook receiver verifies an HMAC over the bytes the sender signed. If the
// invoke route hands the isolate a re-serialised object instead, every signed
// delivery fails and the only symptom is "invalid signature" at the provider.

import { createHmac } from 'crypto';
import { describe, expect, it } from 'vitest';
import { edgeRequestBody } from '../controllers/edge-invoke.controller';

const asRequest = (value: Record<string, unknown>) => value as any;

describe('edgeRequestBody', () => {
  it('prefers the exact bytes express kept over the parsed object', () => {
    // Key order and spacing differ from what JSON.stringify would emit.
    const sent = '{ "type":"payment_intent.succeeded",  "id":"evt_1" }';
    const req = asRequest({ rawBody: Buffer.from(sent), body: { id: 'evt_1', type: 'payment_intent.succeeded' } });

    expect(edgeRequestBody(req)).toBe(sent);
  });

  it('keeps a signature over the raw body verifiable', () => {
    const secret = 'whsec_x';
    const sent = '{"a":"é","b":"\\u00e9"}';
    const signature = createHmac('sha256', secret).update(sent).digest('hex');

    const forwarded = edgeRequestBody(asRequest({ rawBody: Buffer.from(sent), body: JSON.parse(sent) }));

    expect(createHmac('sha256', secret).update(forwarded).digest('hex')).toBe(signature);
  });

  it('forwards a form-encoded body as sent, for Twilio-style signing', () => {
    const sent = 'Body=hello&From=%2B15550001111';
    const req = asRequest({ rawBody: Buffer.from(sent), body: { Body: 'hello', From: '+15550001111' } });

    expect(edgeRequestBody(req)).toBe(sent);
  });

  it('falls back to the parsed body when nothing kept the bytes', () => {
    expect(edgeRequestBody(asRequest({ body: { ok: true } }))).toBe('{"ok":true}');
    expect(edgeRequestBody(asRequest({ body: 'plain text' }))).toBe('plain text');
    expect(edgeRequestBody(asRequest({ body: Buffer.from('raw bytes') }))).toBe('raw bytes');
    expect(edgeRequestBody(asRequest({}))).toBe('{}');
  });

  it('ignores an empty rawBody, which a GET leaves behind', () => {
    expect(edgeRequestBody(asRequest({ rawBody: Buffer.alloc(0), body: { a: 1 } }))).toBe('{"a":1}');
  });
});
