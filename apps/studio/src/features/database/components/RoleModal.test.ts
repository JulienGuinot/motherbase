import { describe, expect, it } from 'vitest';
import { roleChanges } from '@/features/database/components/RoleModal';

const base = {
  canLogin: true, isSuperuser: false, canCreateDb: false, canCreateRole: false,
  canReplicate: false, canBypassRls: false, inheritRole: true, connectionLimit: -1,
};

describe('roleChanges', () => {
  it('sends only the attributes that changed, so ALTER ROLE touches nothing else', () => {
    expect(roleChanges(base, base)).toEqual({});
    expect(roleChanges(base, { ...base, canLogin: false, connectionLimit: 3 })).toEqual({ canLogin: false, connectionLimit: 3 });
  });
});
