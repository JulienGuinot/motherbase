/**
 * `placeholderData` that holds the previous result only while the *same*
 * selection is refetching (another page, sort, filter, or a poll).
 *
 * Plain `keepPreviousData` also holds it across a selection change, which is
 * the bug this exists for: the headers, tabs and toolbars around a list switch
 * the instant you click another table or bucket, while the rows are still the
 * previous one's. That rendered old rows under new headers (every cell
 * undefined for the table grid) and, in storage, offered a delete button whose
 * object id belonged to the bucket you just left.
 *
 * `key` is whatever sits at `queryKey[1]`: the selection every one of these
 * hooks keys on.
 */
export function keepPreviousFor(key: unknown) {
  return <T>(
    previous: T | undefined,
    previousQuery: { queryKey: readonly unknown[] } | undefined,
  ): T | undefined => (previousQuery?.queryKey[1] === key ? previous : undefined);
}
