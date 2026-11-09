import { describe, it, expect, afterAll } from 'vitest';
import prisma from '../lib/prisma';
import { SqlService } from '../services/admin/sql.service';

// `motherbase inspect db` sends its queries to POST /sql/readonly, which is
// SqlService in read-only mode. That endpoint has two gates a catalog query can
// trip over without being wrong: the static read-only guard (a WITH whose body
// says VACUUM or LOCK reads as a disguised write) and Prisma's deserialisation
// (numeric comes back as a Decimal's internals). Running the CLI's own query set
// through the real service is the check that both sides still agree.

const { REPORT } = require('../../../packages/cli/src/inspect/queries.js');

const sql = new SqlService({ prisma } as any);

afterAll(async () => {
  await prisma.$disconnect();
});

describe('CLI inspect queries on the read-only SQL endpoint', () => {
  for (const { name, query } of REPORT) {
    it(`${name} runs and returns the columns the CLI renders`, async () => {
      let result;
      try {
        result = await sql.execute(query.sql, { enabled: true, readonly: true });
      } catch (err: any) {
        // Not every database has created pg_stat_statements; the CLI turns this
        // exact failure into a hint, so it is the one failure allowed here.
        if (query.needsStatStatements && /pg_stat_statements.*does not exist/.test(err.message)) return;
        throw err;
      }
      expect(result.kind).toBe('read');
      const [first] = result.rows ?? [];
      if (!first) return;
      for (const column of query.columns) expect(first, column.key).toHaveProperty(column.key);
      // Every value must reach the CLI as a plain JSON scalar.
      for (const value of Object.values(first)) {
        expect(value === null || typeof value !== 'object', JSON.stringify(first)).toBe(true);
      }
    });
  }
});
