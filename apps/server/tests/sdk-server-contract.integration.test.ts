import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { contractPath, isApiEnvelope, isStorageUpload } from '@motherbase/contracts';
import { createClient } from '@motherbase/client';
import {
  CONTRACT_TOKEN,
  CONTRACT_USER,
  createSdkContractHarness,
  type SdkContractHarness,
} from './fixtures/sdk-contract-harness';

describe('SDK ↔ server HTTP contracts', () => {
  let harness: SdkContractHarness;
  let baseUrl: string;

  beforeAll(async () => {
    harness = await createSdkContractHarness(vi.spyOn);
    baseUrl = harness.baseUrl;
  });

  afterAll(async () => {
    await harness.close();
  });

  it('authenticates through the registered project auth transport', async () => {
    const client = createClient(baseUrl);
    const result = await client.auth.signIn.email({ email: CONTRACT_USER.email, password: 'irrelevant' });
    expect(result.error).toBeNull();
    expect(result.data?.user).toMatchObject(CONTRACT_USER);
    expect((await client.hydrate())?.accessToken).toBe(CONTRACT_TOKEN);
  });

  it('uploads, downloads and removes bytes through FileController', async () => {
    const client = createClient(baseUrl);
    await client.auth.signIn.email({ email: CONTRACT_USER.email, password: 'irrelevant' });
    const upload = await client.storage.from('contract').upload('hello.txt', new Blob(['hello']));
    expect(upload.error).toBeNull();
    const download = await client.storage.from('contract').download(upload.data!.id);
    expect(await download.data?.text()).toBe('hello');
    const remove = await client.storage.from('contract').remove([upload.data!.id]);
    expect(remove).toEqual({ data: [{ deleted: true }], error: null });
  });

  it('performs REST CRUD through RestApiController and the production error middleware', async () => {
    const client = createClient(baseUrl);
    await client.auth.signIn.email({ email: CONTRACT_USER.email, password: 'irrelevant' });
    expect(
      (await client.from('contract_items').insert({ id: 'r1', user_id: 'other', label: 'x' })).error
    ).toMatchObject({ status: 403, message: 'blocked by policy' });
    expect(
      (await client.from('contract_items').insert({ id: 'r1', user_id: CONTRACT_USER.id, label: 'one' })).error
    ).toBeNull();
    expect((await client.from('contract_items').update({ label: 'two' }).eq('id', 'r1').select()).data).toMatchObject([
      { label: 'two' },
    ]);
    expect((await client.from('contract_items').select('*')).data).toHaveLength(1);
    expect((await client.from('contract_items').delete().eq('id', 'r1')).error).toBeNull();
  });

  it('sends the session bearer through EdgeInvokeController', async () => {
    const client = createClient(baseUrl);
    await client.auth.signIn.email({ email: CONTRACT_USER.email, password: 'irrelevant' });
    await expect(client.functions.invoke('private-contract', { body: { value: 42 } })).resolves.toMatchObject({
      data: { echoed: 42 },
      error: null,
    });
  });

  it('shares envelope, storage and realtime runtime primitives', () => {
    expect(isApiEnvelope({ status: 1, message: 'ok', data: {} })).toBe(true);
    expect(isStorageUpload({ file: { id: 'f1' }, url: 'https://example.test/f1' })).toBe(true);
    expect(contractPath.realtime('Contract_Items', 'deleted')).toBe('contract_items:deleted');
  });
});
