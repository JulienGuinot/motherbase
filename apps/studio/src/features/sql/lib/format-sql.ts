// Lightweight, dependency-free SQL pretty-printer for the editor's "Format"
// action. Not a full parser. It tokenises while preserving string literals
// ('...'), quoted identifiers ("..."), and line/block comments verbatim, then
// re-flows the remaining tokens: major clauses on their own lines, keywords
// upper-cased. Good enough for the day-to-day queries people write here, and
// safe against corrupting quoted content (the main risk with naive regex).

const MAJOR = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT', 'OFFSET',
  'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'RETURNING',
  'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN', 'JOIN',
  'UNION ALL', 'UNION', 'ON', 'CREATE TABLE', 'ALTER TABLE', 'CREATE POLICY',
  'CREATE INDEX', 'WITH',
];

const KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'AS', 'ON',
  'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'INSERT', 'INTO', 'VALUES',
  'UPDATE', 'SET', 'DELETE', 'RETURNING', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL',
  'CROSS', 'UNION', 'ALL', 'DISTINCT', 'COUNT', 'CASE', 'WHEN', 'THEN', 'ELSE',
  'END', 'ASC', 'DESC', 'LIKE', 'ILIKE', 'BETWEEN', 'EXISTS', 'CREATE', 'TABLE',
  'ALTER', 'POLICY', 'INDEX', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'DEFAULT',
  'UNIQUE', 'CHECK', 'CONSTRAINT', 'WITH', 'USING', 'TO', 'FOR', 'CASCADE', 'INT',
  'TRUE', 'FALSE', 'NULLS', 'FIRST', 'LAST', 'INTERVAL', 'COALESCE',
]);

interface Token { text: string; kind: 'string' | 'ident' | 'comment' | 'word' | 'punct' | 'ws'; }

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      // String literal or quoted identifier: consume to the matching quote,
      // honouring doubled-quote escapes ('' / "").
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c && sql[j + 1] === c) { j += 2; continue; }
        if (sql[j] === c) { j++; break; }
        j++;
      }
      tokens.push({ text: sql.slice(i, j), kind: c === "'" ? 'string' : 'ident' });
      i = j;
    } else if (c === '-' && sql[i + 1] === '-') {
      let j = sql.indexOf('\n', i);
      if (j === -1) j = sql.length;
      tokens.push({ text: sql.slice(i, j), kind: 'comment' });
      i = j;
    } else if (c === '/' && sql[i + 1] === '*') {
      let j = sql.indexOf('*/', i);
      j = j === -1 ? sql.length : j + 2;
      tokens.push({ text: sql.slice(i, j), kind: 'comment' });
      i = j;
    } else if (/\s/.test(c)) {
      let j = i;
      while (j < sql.length && /\s/.test(sql[j])) j++;
      tokens.push({ text: ' ', kind: 'ws' });
      i = j;
    } else if (/[A-Za-z0-9_.$]/.test(c)) {
      let j = i;
      while (j < sql.length && /[A-Za-z0-9_.$]/.test(sql[j])) j++;
      tokens.push({ text: sql.slice(i, j), kind: 'word' });
      i = j;
    } else {
      tokens.push({ text: c, kind: 'punct' });
      i++;
    }
  }
  return tokens;
}

export function formatSql(sql: string): string {
  const trimmed = sql.trim();
  if (!trimmed) return sql;

  const tokens = tokenize(trimmed).filter(t => t.kind !== 'ws');
  // Upper-case bare keyword words (never strings/identifiers/comments).
  const norm = tokens.map(t =>
    t.kind === 'word' && KEYWORDS.has(t.text.toUpperCase())
      ? { ...t, text: t.text.toUpperCase() }
      : t,
  );

  // Reassemble into a single spaced string, then split on major clauses.
  let out = '';
  for (let k = 0; k < norm.length; k++) {
    const t = norm[k];
    const prev = norm[k - 1];
    const noSpaceBefore = t.text === ',' || t.text === ')' || t.text === '::' || (prev && prev.text === '(');
    const noSpaceAfterPrev = prev && (prev.text === '(' || prev.kind === 'comment');
    if (out && !noSpaceBefore && !noSpaceAfterPrev) out += ' ';
    out += t.text;
    if (t.kind === 'comment') out += '\n';
  }

  // Break before each major clause keyword (word-boundary, case done above).
  const pattern = new RegExp(`\\s+(${MAJOR.map(m => m.replace(/ /g, '\\s+')).join('|')})\\b`, 'g');
  out = out.replace(pattern, (_m, kw) => `\n${kw.replace(/\s+/g, ' ')}`);

  // Indent AND / OR under their clause for readability.
  out = out.replace(/\s+(AND|OR)\b/g, '\n  $1');

  // Ensure a single trailing semicolon-newline hygiene: collapse >1 blank line.
  return out.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
