import type { EnumChange } from '@/features/database/api/catalog.api';

/**
 * The ALTER TYPE steps that turn an enum's values into the list edited in
 * place, or null when the edit asks for something Postgres cannot do: drop a
 * value, or merge two (a rename onto a value already listed collapses them).
 *
 * One ListInput edit replaces one run of values: a chip renamed, a value
 * appended, or a chip edited into several ("paid" → "paid refunded"). That run
 * is what lies between the unchanged head and tail. Its first values are
 * renames of the old ones, in order; the rest are additions, each anchored
 * after its predecessor so it lands where it was typed.
 */
export function enumChanges(current: readonly string[], next: readonly string[]): EnumChange[] | null {
  if (next.length < current.length) return null;

  let head = 0;
  while (head < current.length && current[head] === next[head]) head += 1;
  let tail = 0;
  while (tail < current.length - head && current[current.length - 1 - tail] === next[next.length - 1 - tail]) tail += 1;

  const replaced = current.slice(head, current.length - tail);
  const changes: EnumChange[] = replaced.map((from, i) => ({ action: 'rename-value', from, to: next[head + i] }));
  for (let index = head + replaced.length; index < next.length - tail; index += 1) {
    changes.push(
      index > 0
        ? { action: 'add-value', value: next[index], after: next[index - 1] }
        : { action: 'add-value', value: next[index], before: next[index + 1] },
    );
  }
  return changes;
}
