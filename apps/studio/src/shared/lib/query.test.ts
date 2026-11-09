import { describe, expect, it } from 'vitest';
import { keepPreviousFor } from '@/shared/lib/query';

const query = (key: unknown) => ({ queryKey: ['rows', key] as const });

describe('keepPreviousFor', () => {
  it('keeps the previous data while the same selection refetches', () => {
    expect(keepPreviousFor('users')(['row'], query('users'))).toEqual(['row']);
  });

  it('drops it when the selection changed', () => {
    expect(keepPreviousFor('orders')(['row'], query('users'))).toBeUndefined();
  });

  it('drops it when there is no previous query', () => {
    expect(keepPreviousFor('users')(['row'], undefined)).toBeUndefined();
  });
});
