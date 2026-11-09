import { describe, it, expect } from 'vitest';
import { templates } from '@/features/database/lib/rls-templates';

describe('rls templates', () => {
  it('owner template emits auth.uid() = <column> for SELECT', () => {
    const owner = templates.find(t => t.id === 'owner')!;
    const sql = owner.build({ ownerColumn: 'user_id' });
    expect(sql.using).toBe('auth.uid() = user_id');
    expect(sql.role).toBe('authenticated');
  });

  it('public-read emits true to anon for SELECT', () => {
    const pub = templates.find(t => t.id === 'public_read')!;
    expect(pub.build({}).using).toBe('true');
    expect(pub.build({}).role).toBe('anon');
  });

  it('admin checks the user_role claim', () => {
    const admin = templates.find(t => t.id === 'admin')!;
    expect(admin.build({}).using).toBe("auth.jwt() ->> 'user_role' = 'ADMIN'");
  });
});
