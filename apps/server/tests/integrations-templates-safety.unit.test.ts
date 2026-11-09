import { describe, it, expect } from 'vitest';
import { INTEGRATIONS } from '../config/integrations-registry';

const functions = INTEGRATIONS.flatMap(i => i.functions.map(f => ({ key: `${i.key}/${f.name}`, code: f.code })));

describe('integration templates', () => {
  it('never send a secret to a URL the caller chose', () => {
    // `fetch(String(context.x) + …)` lets whoever invokes the function aim the
    // provider token at any host. The origin must be a literal in the template,
    // or the caller's URL must be checked against one first.
    const offenders = functions
      .filter(f => /fetch\(\s*(String\()?context\./.test(f.code) && !/startsWith\('https:\/\//.test(f.code))
      .map(f => f.key);
    expect(offenders).toEqual([]);
  });

  it('encode caller input that lands in a URL path', () => {
    const offenders = functions
      .filter(f => /\/\s*'\s*\+\s*String\(context\.\w+\)/.test(f.code))
      .map(f => f.key);
    expect(offenders).toEqual([]);
  });
});
