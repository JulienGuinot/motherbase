import { describe, expect, it } from 'vitest';
import { stringifyCodeValue, tokenizeLine } from '@/shared/ui/CodeBlock';

function colorOf(line: string, needle: string) {
  return tokenizeLine(line).find(node => node.text === needle)?.color;
}

describe('tokenizeLine', () => {
  it('colours HTTP status codes by class', () => {
    expect(colorOf('GET /users 200 12ms', '200')).toBe('var(--green)');
    expect(colorOf('GET /users 404 12ms', '404')).toBe('var(--amber)');
    expect(colorOf('GET /users 503 12ms', '503')).toBe('var(--red)');
  });

  it('does not split durations that start like status codes', () => {
    expect(colorOf('GET /users 200ms', '200ms')).toBe('var(--amber)');
  });

  it('tags methods, URLs and quoted strings', () => {
    const line = 'POST https://api.test/v1 failed: "connection refused"';
    expect(colorOf(line, 'POST')).toBe('var(--purple)');
    expect(colorOf(line, 'https://api.test/v1')).toBe('var(--blue)');
    expect(colorOf(line, '"connection refused"')).toBe('var(--green)');
  });

  it('round-trips the original text exactly', () => {
    const line = 'WARN  pool at 95% after 1.5s: 3 retries';
    expect(tokenizeLine(line).map(node => node.text).join('')).toBe(line);
  });
});

describe('stringifyCodeValue', () => {
  it('pretty-prints structured values for display and copy', () => {
    expect(stringifyCodeValue({ ok: true })).toBe('{\n  "ok": true\n}');
  });

  it('keeps raw strings unchanged', () => {
    expect(stringifyCodeValue('  npm run dev\n')).toBe('  npm run dev\n');
  });
});
