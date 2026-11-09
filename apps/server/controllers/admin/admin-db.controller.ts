import { before, GET, POST, route } from 'awilix-express';
import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import IContextContainer from '../../context/icontext-container';
import { adminOnly } from '../../middlewares/platform-admin.middleware';
import * as apiResponse from '../../helpers/api-response.helper';
import { HttpException } from '../../exceptions/http-exception';
import { toHistoryEntry } from '../../services/admin/schema-migration.service';

/**
 * The Supabase CLI's local-files workflow: `migration list/up/repair/fetch`,
 * `db push/pull/diff/reset/dump/seed` and `test db`.
 *
 * `/migrations` (admin-operations) stays the Studio's id-based surface; these
 * routes address a migration by its file `version` instead, which is what a
 * directory of `<version>_<name>.sql` files knows. Both read and write the same
 * history table. Bodies carry whole migration directories, so `/api/admin/db`
 * gets a larger JSON limit than the rest of the API (see app.ts).
 */

const migrationFile = z.object({
  version: z.string().regex(/^\d{1,32}$/, 'must be the digits of a <version>_<name>.sql prefix'),
  name: z.string().trim().min(1).max(200),
  sql: z.string(),
  downSql: z.string().nullish(),
});

const seedFile = z.object({ path: z.string().min(1).max(500), sql: z.string() });

const bodies = {
  push: migrationFile,
  repair: z.object({
    status: z.enum(['applied', 'reverted']),
    name: z.string().trim().max(200).optional(),
    sql: z.string().optional(),
    downSql: z.string().nullish(),
  }),
  diff: z.object({ migrations: z.array(migrationFile) }),
  dump: z
    .object({
      schemaOnly: z.boolean().optional(),
      dataOnly: z.boolean().optional(),
      useCopy: z.boolean().optional(),
      schemas: z.array(z.string().min(1)).optional(),
    })
    .refine(body => !(body.schemaOnly && body.dataOnly), 'schemaOnly and dataOnly are mutually exclusive'),
  seed: z.object({ files: z.array(seedFile).min(1) }),
  reset: z.object({
    confirm: z.literal('RESET', { error: 'Reset requires confirm=RESET' }),
    migrations: z.array(migrationFile),
    seeds: z.array(seedFile).optional(),
  }),
  test: z.object({ name: z.string().min(1).max(500), sql: z.string().min(1) }),
};

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new HttpException(
      parsed.error.issues.map(issue => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; '),
      400,
    );
  }
  return parsed.data;
}

@route('/api/admin')
export default class AdminDbController {
  constructor(private di: IContextContainer) {}

  /** The history, oldest version first: Supabase's schema_migrations, plus origin and status. */
  @GET()
  @route('/db/migrations')
  @before(adminOnly)
  async migrationHistory(_req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', { migrations: await this.di.SchemaMigrationService.history() });
    } catch (error: unknown) {
      return next(error);
    }
  }

  /** Record and apply one local migration file, atomically. `db push` calls it once per pending file. */
  @POST()
  @route('/db/migrations')
  @before(adminOnly)
  async pushMigration(req: Request, res: Response, next: NextFunction) {
    try {
      const row = await this.di.SchemaMigrationService.push(parse(bodies.push, req.body));
      return apiResponse.successResponseWithData(res, 'Applied', { migration: toHistoryEntry(row) });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/db/migrations/:version/repair')
  @before(adminOnly)
  async repairMigration(req: Request, res: Response, next: NextFunction) {
    try {
      const row = await this.di.SchemaMigrationService.repair(req.params.version, parse(bodies.repair, req.body));
      return apiResponse.successResponseWithData(res, 'Repaired', { migration: toHistoryEntry(row) });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/db/diff')
  @before(adminOnly)
  async diffSchema(req: Request, res: Response, next: NextFunction) {
    try {
      const { migrations } = parse(bodies.diff, req.body);
      return apiResponse.successResponseWithData(res, 'OK', await this.di.DbWorkflowService.diff(migrations));
    } catch (error: unknown) {
      return next(error);
    }
  }

  /** A POST although it reads: it can return every row of every app table. */
  @POST()
  @route('/db/dump')
  @before(adminOnly)
  async dumpDatabase(req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', await this.di.DbWorkflowService.dump(parse(bodies.dump, req.body)));
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/db/seed')
  @before(adminOnly)
  async seedDatabase(req: Request, res: Response, next: NextFunction) {
    try {
      const { files } = parse(bodies.seed, req.body);
      return apiResponse.successResponseWithData(res, 'Seeded', await this.di.DbWorkflowService.seed(files));
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/db/reset')
  @before(adminOnly)
  async resetDatabase(req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'Reset', await this.di.DbWorkflowService.reset(parse(bodies.reset, req.body)));
    } catch (error: unknown) {
      return next(error);
    }
  }

  /** Run one pgTAP file; always rolled back. */
  @POST()
  @route('/db/test')
  @before(adminOnly)
  async testDatabase(req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', await this.di.DbWorkflowService.runTest(parse(bodies.test, req.body)));
    } catch (error: unknown) {
      return next(error);
    }
  }
}
