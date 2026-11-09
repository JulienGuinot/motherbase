export const TRIGGER_EVENTS = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] as const;
export type TriggerEvent = (typeof TRIGGER_EVENTS)[number];

export interface TriggerDraft {
  editing?: { table: string; name: string };
  name: string;
  table: string;
  timing: 'BEFORE' | 'AFTER';
  events: Record<TriggerEvent, boolean>;
  orientation: 'ROW' | 'STATEMENT';
  fn: string;
  advanced: boolean;
  rawSql: string;
  rawEdited: boolean;
}

export function createEmptyTriggerDraft(table = ''): TriggerDraft {
  return {
    name: '',
    table,
    timing: 'AFTER',
    events: { INSERT: true, UPDATE: false, DELETE: false, TRUNCATE: false },
    orientation: 'ROW',
    fn: '',
    advanced: false,
    rawSql: '',
    rawEdited: false,
  };
}

function selectedTriggerEvents(draft: TriggerDraft): TriggerEvent[] {
  return TRIGGER_EVENTS.filter(event => draft.events[event]);
}

/**
 * @param schema the schema the form is operating in. Both identifiers used to
 * be hardcoded to `public`, so a trigger built while a custom schema was
 * selected was created on `public."<table>"` and bound to `public."<fn>"`:
 * either the wrong relation, or an error naming a table the operator can see
 * right there in the picker.
 */
export function generateTriggerSql(draft: TriggerDraft, schema = 'public'): string {
  const events = selectedTriggerEvents(draft).join(' OR ');
  return [
    `CREATE TRIGGER "${draft.name}"`,
    `  ${draft.timing} ${events} ON "${schema}"."${draft.table}"`,
    `  FOR EACH ${draft.orientation}`,
    `  EXECUTE FUNCTION "${schema}"."${draft.fn}"();`,
  ].join('\n');
}

export function triggerDraftSql(draft: TriggerDraft, schema = 'public'): string {
  return draft.advanced ? draft.rawSql : generateTriggerSql(draft, schema);
}

export function canSaveTrigger(draft: TriggerDraft): boolean {
  if (draft.advanced) return Boolean(draft.rawSql.trim());
  return Boolean(draft.name.trim() && draft.table && draft.fn && selectedTriggerEvents(draft).length);
}
