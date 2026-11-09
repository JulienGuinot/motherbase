import { describe, expect, it } from 'vitest';
import { indexSuggestionFindings, toAdvice } from '../services/admin/index-advisor.service';

describe('index advisor results', () => {
  it('maps index_advisor\'s row and computes the saving', () => {
    const advice = toAdvice({
      startup_cost_before: 0,
      startup_cost_after: 4.3,
      total_cost_before: 400,
      total_cost_after: 12,
      index_statements: ['CREATE INDEX ON public.t USING btree (a)'],
      errors: [],
    });
    expect(advice).toMatchObject({ totalCostBefore: 400, totalCostAfter: 12, improvementPct: 97 });
    expect(toAdvice({ index_statements: null, errors: ['boom'] })).toMatchObject({
      indexStatements: [],
      errors: ['boom'],
      improvementPct: null,
    });
  });

  it('turns only helpful advice into findings, graded by the saving', () => {
    const advice = (after: number, statements: string[]) =>
      toAdvice({ total_cost_before: 100, total_cost_after: after, index_statements: statements, errors: [] });
    const findings = indexSuggestionFindings([
      { query: 'select * from t where a = $1', calls: 10, totalExecTimeMs: 900, advice: advice(10, ['CREATE INDEX ON public.t USING btree (a)']) },
      { query: 'select * from t where b = $1', calls: 3, totalExecTimeMs: 90, advice: advice(80, ['CREATE INDEX ON public.t USING btree (b)']) },
      { query: 'select 1', calls: 1, totalExecTimeMs: 1, advice: advice(100, []) },
    ]);
    expect(findings.map(f => f.level)).toEqual(['warning', 'info']);
    expect(findings[0]).toMatchObject({
      id: 'perf_index_suggestion',
      category: 'performance',
      remediation: 'CREATE INDEX ON public.t USING btree (a);',
    });
  });
});
