// Table Editor row-filter model (frontend mirror of the backend row-filters
// contract). Operators and their display metadata live here so the FilterBar,
// the query hook and any future callers share one source of truth.

export type FilterOperator =
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'like' | 'ilike' | 'in' | 'is_null' | 'not_null';

export interface RowFilter {
  column: string;
  op: FilterOperator;
  value: string;
}

export interface FilterOperatorMeta {
  op: FilterOperator;
  /** Short symbol/label shown in the operator dropdown and chips. */
  label: string;
  /** Whether this operator takes a value input. */
  hasValue: boolean;
}

export const FILTER_OPERATORS: FilterOperatorMeta[] = [
  { op: 'eq', label: '=', hasValue: true },
  { op: 'neq', label: '≠', hasValue: true },
  { op: 'gt', label: '>', hasValue: true },
  { op: 'gte', label: '≥', hasValue: true },
  { op: 'lt', label: '<', hasValue: true },
  { op: 'lte', label: '≤', hasValue: true },
  { op: 'like', label: 'like', hasValue: true },
  { op: 'ilike', label: 'ilike', hasValue: true },
  { op: 'in', label: 'in', hasValue: true },
  { op: 'is_null', label: 'is null', hasValue: false },
  { op: 'not_null', label: 'not null', hasValue: false },
];

const OPERATOR_LABEL = new Map(FILTER_OPERATORS.map(o => [o.op, o.label]));

export function operatorLabel(op: FilterOperator): string {
  return OPERATOR_LABEL.get(op) ?? op;
}

export function operatorHasValue(op: FilterOperator): boolean {
  return FILTER_OPERATORS.find(o => o.op === op)?.hasValue ?? true;
}

/** Drop incomplete rows (no column, or a value-taking op with an empty value). */
export function completeFilters(filters: RowFilter[]): RowFilter[] {
  return filters.filter(f => f.column && (!operatorHasValue(f.op) || f.value.trim() !== ''));
}

/** Serialize for the `filters` query param; empty when nothing is applied. */
export function serializeFilters(filters: RowFilter[]): string | null {
  const complete = completeFilters(filters);
  if (!complete.length) return null;
  return JSON.stringify(complete.map(f => ({
    column: f.column,
    op: f.op,
    ...(operatorHasValue(f.op) ? { value: f.value } : {}),
  })));
}
