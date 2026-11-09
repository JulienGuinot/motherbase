import { describe, it, expect, beforeEach } from 'vitest';
import { OrgStore, slugify } from '../console/services/org-store';

function store() {
  return new OrgStore(':memory:');
}

describe('OrgStore', () => {
  let s: OrgStore;
  beforeEach(() => { s = store(); });

  it('slugifies names to lowercase hyphenated alnum', () => {
    expect(slugify('My Cool Org!!')).toBe('my-cool-org');
    expect(slugify('   ')).toBe('org');
  });

  it('creates an org with the creator as owner and unique slugs', () => {
    const a = s.createOrg('Acme', 'u1');
    const b = s.createOrg('Acme', 'u2'); // same name → suffixed slug
    expect(a.slug).toBe('acme');
    expect(b.slug).toBe('acme-2');
    expect(s.memberRole(a.id, 'u1')).toBe('owner');
    const forU1 = s.listForUser('u1');
    expect(forU1).toHaveLength(1);
    expect(forU1[0]).toMatchObject({ id: a.id, role: 'owner', projectCount: 0 });
  });

  it('manages membership and refuses to remove the last owner', () => {
    const o = s.createOrg('Team', 'owner1');
    s.addMember(o.id, 'member1', 'member');
    expect(s.isMember(o.id, 'member1')).toBe(true);
    expect(s.listMembers(o.id)).toHaveLength(2);

    // upsert role
    s.addMember(o.id, 'member1', 'admin');
    expect(s.memberRole(o.id, 'member1')).toBe('admin');

    expect(s.removeMember(o.id, 'owner1')).toEqual({ ok: false, reason: 'cannot remove the last owner' });
    s.addMember(o.id, 'owner2', 'owner');
    expect(s.removeMember(o.id, 'owner1').ok).toBe(true);
    expect(s.removeMember(o.id, 'member1').ok).toBe(true);
  });

  it('assigns projects and reflects them in project count', () => {
    const o = s.createOrg('Org', 'u1');
    s.assignProject('proj-a', o.id);
    s.assignProject('proj-b', o.id);
    expect(s.orgOfProject('proj-a')).toBe(o.id);
    expect(s.projectsOfOrg(o.id).sort()).toEqual(['proj-a', 'proj-b']);
    expect(s.listForUser('u1')[0].projectCount).toBe(2);

    // reassign moves it (single source of truth)
    const o2 = s.createOrg('Org2', 'u1');
    s.assignProject('proj-a', o2.id);
    expect(s.orgOfProject('proj-a')).toBe(o2.id);
    expect(s.projectsOfOrg(o.id)).toEqual(['proj-b']);
  });

  it('refuses to delete an org that still owns projects, allows when empty', () => {
    const o = s.createOrg('Org', 'u1');
    s.assignProject('p1', o.id);
    expect(s.deleteOrg(o.id)).toEqual({ ok: false, reason: 'organization still has projects' });
    s.unassignProject('p1');
    expect(s.deleteOrg(o.id).ok).toBe(true);
    expect(s.getOrg(o.id)).toBeUndefined();
  });

  it('backfill is idempotent: default org, users as members, projects assigned', () => {
    const input = {
      users: [{ id: 'owner1', role: 'owner' }, { id: 'member1', role: 'member' }],
      projectNames: ['alpha', 'beta'],
    };
    const def1 = s.backfill(input);
    const def2 = s.backfill(input); // second run must not duplicate
    expect(def1.id).toBe(def2.id);
    expect(def1.slug).toBe('default-organization');

    expect(s.memberRole(def1.id, 'owner1')).toBe('owner');
    expect(s.memberRole(def1.id, 'member1')).toBe('member');
    expect(s.projectsOfOrg(def1.id).sort()).toEqual(['alpha', 'beta']);
    expect(s.listMembers(def1.id)).toHaveLength(2);

    // an already-assigned project is not moved back to default
    const other = s.createOrg('Other', 'owner1');
    s.assignProject('alpha', other.id);
    s.backfill(input);
    expect(s.orgOfProject('alpha')).toBe(other.id);
  });
});
