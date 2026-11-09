import { describe, expect, it } from 'vitest';
import { parseTaggedLine, splitPairs } from '@/features/logs/lib/tagged-line';

describe('parseTaggedLine', () => {
  it('reads back what the job ledger writes', () => {
    expect(parseTaggedLine('[job:storage-cleanup] ok in 13ms')).toEqual({
      tag: 'job:storage-cleanup',
      rest: '',
      ms: 13,
      outcome: 'ok',
    });
  });

  it('keeps the reason when the duration sits mid-sentence', () => {
    expect(parseTaggedLine('[job:backup] failed after 42ms, disk full')).toEqual({
      tag: 'job:backup',
      rest: 'disk full',
      ms: 42,
      outcome: 'failed',
    });
  });

  it('handles a tagged line with no duration and no verdict', () => {
    expect(parseTaggedLine('[realtime] connect socket=abc user=usr_1')).toEqual({
      tag: 'realtime',
      rest: 'connect socket=abc user=usr_1',
      ms: undefined,
      outcome: undefined,
    });
  });

  it('leaves the message alone when the verdict came from the tag, not the body', () => {
    // Slicing the outcome off `rest` here used to eat real characters:
    // `[sql:ok] INSERT INTO …` rendered as `SERT INTO …`.
    expect(parseTaggedLine('[sql:ok] INSERT INTO public.events VALUES ($1)')?.rest).toBe(
      'INSERT INTO public.events VALUES ($1)',
    );
    expect(parseTaggedLine('[sql:ok] UPDATE public.orders SET status = $1')?.rest).toBe(
      'UPDATE public.orders SET status = $1',
    );
  });

  it('lifts a verdict that lives in the tag, as the SQL auditor writes it', () => {
    expect(parseTaggedLine('[sql:ok] SELECT * FROM orders (12 rows)')).toEqual({
      tag: 'sql',
      rest: 'SELECT * FROM orders (12 rows)',
      ms: undefined,
      outcome: 'ok',
    });
    expect(parseTaggedLine('[sql:error] DROP TABLE nope, relation does not exist')?.outcome).toBe('error');
  });

  it('does not mistake a job name for a verdict', () => {
    expect(parseTaggedLine('[job:storage-cleanup] ok')?.tag).toBe('job:storage-cleanup');
  });

  it('declines anything without a leading tag', () => {
    expect(parseTaggedLine('GET /api/health → 200 (3ms)')).toBeNull();
    expect(parseTaggedLine('GitHub connected as octocat')).toBeNull();
  });
});

describe('splitPairs', () => {
  it('separates key=value tokens from plain words', () => {
    expect(splitPairs('connect socket=abc')).toEqual([{ text: 'connect' }, { key: 'socket', text: 'abc' }]);
  });
});
