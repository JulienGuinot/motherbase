import { describe, expect, it } from 'vitest';
import { describeAccess } from '@/features/database/lib/rls-access';

describe('describeAccess', () => {
  it('tells RLS-off apart from a policy that allows everything', () => {
    expect(describeAccess({ level: 'all' }, 'anon', 'SELECT', false).reason).toMatch(/RLS is off/);
    expect(describeAccess({ level: 'all' }, 'anon', 'SELECT', true).reason).toMatch(/A policy/);
  });

  it('names the gate that closed', () => {
    expect(describeAccess({ level: 'none', blockedBy: 'grant' }, 'anon', 'DELETE', true).reason).toMatch(/no DELETE grant/);
    expect(describeAccess({ level: 'none', blockedBy: 'policy' }, 'anon', 'INSERT', true).reason).toMatch(/no policy/);
    expect(describeAccess({ level: 'none', blockedBy: 'read' }, 'anon', 'UPDATE', true).reason).toMatch(/cannot read/);
  });

  it('flags conditional access as a warning', () => {
    const some = describeAccess({ level: 'some', conditions: [] }, 'authenticated', 'UPDATE', true);
    expect(some).toMatchObject({ tone: 'warn', label: 'Some rows' });
  });
});
