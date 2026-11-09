import { describe, it, expect } from 'vitest';
import { resolveBaseUrl } from '../auth/auth-origins';

describe('resolveBaseUrl', () => {
  it('keeps dev .localhost stacks on http even in production mode', () => {
    expect(resolveBaseUrl('app.localhost', true)).toBe('http://app.localhost');
    expect(resolveBaseUrl('localhost:5001', true)).toBe('http://localhost:5001');
    expect(resolveBaseUrl('127.0.0.1:5001', true)).toBe('http://127.0.0.1:5001');
  });

  it('uses https for real domains in production only', () => {
    expect(resolveBaseUrl('api.example.com', true)).toBe('https://api.example.com');
    expect(resolveBaseUrl('api.example.com', false)).toBe('http://api.example.com');
  });

  it('does not treat a lookalike domain as local', () => {
    expect(resolveBaseUrl('notlocalhost.com', true)).toBe('https://notlocalhost.com');
  });
});
