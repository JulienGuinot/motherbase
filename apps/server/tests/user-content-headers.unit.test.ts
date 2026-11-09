import { describe, it, expect } from 'vitest';
import { userContentHeaders } from '../helpers/storage-stream.helper';

describe('userContentHeaders', () => {
  it.each(['text/html', 'text/html; charset=utf-8', 'image/svg+xml', 'application/xhtml+xml', 'application/octet-stream', '', undefined])(
    'forces %j to download and sandboxes it',
    mime => {
      const headers = userContentHeaders(mime);
      expect(headers['Content-Disposition']).toBe('attachment');
      expect(headers['Content-Security-Policy']).toContain('sandbox');
      expect(headers['X-Content-Type-Options']).toBe('nosniff');
    },
  );

  it.each(['image/png', 'image/jpeg', 'video/mp4', 'audio/mpeg'])('lets %s render inline, still sandboxed', mime => {
    const headers = userContentHeaders(mime);
    expect(headers['Content-Disposition']).toBeUndefined();
    expect(headers['Content-Security-Policy']).toContain('sandbox');
  });

  it('lets a PDF render inline without the sandbox its viewer cannot load under', () => {
    const headers = userContentHeaders('application/pdf');
    expect(headers['Content-Disposition']).toBeUndefined();
    expect(headers['Content-Security-Policy']).toBeUndefined();
  });
});
