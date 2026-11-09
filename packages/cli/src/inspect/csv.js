'use strict';

// CSV for `inspect report`, written the way Postgres' `COPY ... TO STDOUT WITH
// CSV HEADER` writes it (which is how the Supabase CLI produces its report), so
// the files read the same whichever tool made them: NULL is an empty field, an
// empty string is `""`, booleans are `t`/`f`.

function field(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 't' : 'f';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return text === '' || /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One CSV document: a header of column keys, then one line per row. */
function toCsv(columns, rows) {
  const lines = [columns.map(c => field(c.key)).join(',')];
  for (const row of rows) lines.push(columns.map(c => field(row[c.key])).join(','));
  return lines.join('\n') + '\n';
}

module.exports = { toCsv };
