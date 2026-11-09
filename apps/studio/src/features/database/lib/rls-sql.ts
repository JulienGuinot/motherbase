// Pure helpers: structured policy draft <-> CREATE POLICY SQL.
// No React imports here so it can be unit-tested directly with vitest.

export type PolicyCommand = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'ALL';

export interface PolicyDraft {
  name: string;
  command: PolicyCommand;
  role: string;   // 'anon' | 'authenticated' in form mode; any role in raw mode
  using: string;  // raw expression, no surrounding parens
  check: string;  // raw expression, no surrounding parens
}

const CHECK_COMMANDS = new Set<string>(['INSERT', 'UPDATE', 'ALL']);

export function commandTakesCheck(command: string): boolean {
  return CHECK_COMMANDS.has(command.toUpperCase());
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function buildCreatePolicySql(
  table: string,
  d: PolicyDraft,
  opts: { drop?: boolean } = {},
): string {
  const lines: string[] = [];
  if (opts.drop) {
    lines.push(`DROP POLICY IF EXISTS ${quoteIdent(d.name)} ON ${quoteIdent(table)};`);
  }
  const body = [
    `CREATE POLICY ${quoteIdent(d.name)} ON ${quoteIdent(table)}`,
    `  FOR ${d.command}`,
    `  TO ${d.role}`,
  ];
  const using = d.using.trim();
  if (using) body.push(`  USING ( ${using} )`);
  const check = d.check.trim();
  if (check && commandTakesCheck(d.command)) body.push(`  WITH CHECK ( ${check} )`);
  lines.push(body.join('\n') + ';');
  return lines.join('\n');
}

function unquoteIdent(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/""/g, '"');
  return t;
}

// From `index` (pointing at the char after a keyword), skip whitespace, require
// a `(`, then return the balanced inner text and the index just past the `)`.
// Returns null if there is no balanced parenthesized group.
function readBalancedParens(sql: string, from: number): { inner: string; end: number } | null {
  let i = from;
  while (i < sql.length && /\s/.test(sql[i])) i++;
  if (sql[i] !== '(') return null;
  let depth = 0;
  const start = i;
  for (; i < sql.length; i++) {
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')') {
      depth--;
      if (depth === 0) return { inner: sql.slice(start + 1, i).trim(), end: i + 1 };
    }
  }
  return null;
}

export function parsePolicySql(sql: string): { table: string; draft: PolicyDraft } | null {
  // Locate the CREATE POLICY ... ON ... FOR ... TO ... header.
  const header =
    /CREATE\s+POLICY\s+("(?:[^"]|"")+"|\S+)\s+ON\s+("(?:[^"]|"")+"|\S+)\s+FOR\s+(SELECT|INSERT|UPDATE|DELETE|ALL)\s+TO\s+(\S+)/i.exec(sql);
  if (!header) return null;

  const name = unquoteIdent(header[1]);
  const table = unquoteIdent(header[2]);
  const command = header[3].toUpperCase() as PolicyCommand;
  const role = header[4].replace(/[;,]$/, '');
  if (!name || !table) return null;

  let using = '';
  let check = '';
  const usingKw = /\bUSING\b/i.exec(sql.slice(header.index));
  if (usingKw) {
    const grp = readBalancedParens(sql, header.index + usingKw.index + usingKw[0].length);
    if (grp) using = grp.inner;
  }
  const checkKw = /\bWITH\s+CHECK\b/i.exec(sql.slice(header.index));
  if (checkKw) {
    const grp = readBalancedParens(sql, header.index + checkKw.index + checkKw[0].length);
    if (grp) check = grp.inner;
  }

  return { table, draft: { name, command, role, using, check } };
}
