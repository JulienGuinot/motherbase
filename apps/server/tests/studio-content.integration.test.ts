import { afterAll, describe, expect, it } from 'vitest';
import prisma from '../lib/prisma';
import { ContentService, contentCreateSchema, operatorOf } from '../services/admin/content.service';

const content = new ContentService({ prisma } as any);
const alice = `alice-${Date.now()}`;
const bob = `bob-${Date.now()}`;
const create = (owner: string, input: Record<string, unknown>) =>
  content.create(owner, contentCreateSchema.parse({ type: 'sql', content: { sql: 'select 1' }, ...input }));

afterAll(async () => {
  await prisma.studioContent.deleteMany({ where: { ownerId: { in: [alice, bob] } } });
  await prisma.studioContentFolder.deleteMany({ where: { ownerId: { in: [alice, bob] } } });
});

describe('studio content (SQL snippets)', () => {
  it('shows a private snippet to its owner only and a shared one to everyone', async () => {
    const mine = await create(alice, { name: 'private' });
    const shared = await create(alice, { name: 'shared', visibility: 'project' });

    expect((await content.list(alice, 'sql')).map(item => item.id)).toEqual(expect.arrayContaining([mine.id, shared.id]));
    const seenByBob = (await content.list(bob, 'sql')).map(item => item.id);
    expect(seenByBob).toContain(shared.id);
    expect(seenByBob).not.toContain(mine.id);
    await expect(content.get(bob, mine.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('lets only the owner change or delete, even a shared snippet', async () => {
    const shared = await create(alice, { name: 'team query', visibility: 'project' });
    await expect(content.update(bob, shared.id, { name: 'hijacked' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(content.remove(bob, shared.id)).rejects.toMatchObject({ statusCode: 403 });
    expect((await content.update(alice, shared.id, { favorite: true })).favorite).toBe(true);
  });

  it('files snippets in the owner\'s folders, and frees them when the folder goes', async () => {
    const folder = await content.createFolder(alice, 'reports');
    await expect(create(bob, { name: 'x', folderId: folder.id })).rejects.toMatchObject({ statusCode: 404 });
    const filed = await create(alice, { name: 'filed', folderId: folder.id });
    await content.removeFolder(alice, folder.id);
    expect((await content.get(alice, filed.id)).folderId).toBeNull();
  });

  it('validates the payload per type', async () => {
    await expect(content.create(alice, contentCreateSchema.parse({ type: 'report', name: 'r', content: { sql: 'x' } })))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('attributes a request to the console operator, then the user', () => {
    expect(operatorOf({ user: { id: 'platform', operatorId: 'op-1' } } as any)).toBe('op-1');
    expect(operatorOf({ user: { id: 'u1' } } as any)).toBe('u1');
  });
});
