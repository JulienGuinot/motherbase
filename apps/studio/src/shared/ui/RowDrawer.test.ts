import { describe, expect, it } from 'vitest';
import { blankRequiredReferences, type FieldMeta } from '@/shared/ui/RowDrawer';

const field = (name: string, isRequired: boolean): FieldMeta => ({
  name, type: 'String', kind: 'scalar', isId: false, isReadOnly: false, isRequired, sensitive: false,
});

describe('blankRequiredReferences', () => {
  const fields = [field('userId', true), field('teamId', false), field('title', true)];
  const references = { userId: 'users', teamId: 'teams' };

  it('names a required foreign key left blank, and nothing else', () => {
    expect(blankRequiredReferences(fields, { userId: '', teamId: '', title: '' }, references)).toEqual(['userId']);
  });

  it('lets the row through once the foreign key is filled in', () => {
    expect(blankRequiredReferences(fields, { userId: 'u_1', teamId: '', title: '' }, references)).toEqual([]);
  });
});
