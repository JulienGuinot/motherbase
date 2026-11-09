import { describe, expect, it } from 'vitest';
import { newProvider, providerProblems, type ThirdPartyProvider } from './third-party';

const row = (over: Partial<ThirdPartyProvider>): ThirdPartyProvider => ({
  ...newProvider([]),
  issuer: 'https://a.example.com',
  ...over,
});

describe('newProvider', () => {
  it('never reuses an existing id', () => {
    expect(newProvider([row({ id: 'clerk-2' })]).id).toBe('clerk-3');
  });
});

describe('providerProblems', () => {
  it('accepts a well-formed list', () => {
    expect(providerProblems([row({}), row({ id: 'b', issuer: 'https://b.example.com' })]).size).toBe(0);
  });

  it('flags a blank issuer, a bad JWKS URL and a shared issuer on the offending row', () => {
    const problems = providerProblems([
      row({ id: 'a' }),
      row({ id: 'b', issuer: '' }),
      row({ id: 'c', issuer: 'https://c.example.com', jwksUrl: 'nope' }),
      row({ id: 'd' }),
    ]);
    expect([...problems.keys()]).toEqual([1, 2, 3]);
    expect(problems.get(3)).toMatch(/share an issuer/);
  });
});
