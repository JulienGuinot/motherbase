import { before, GET, POST, PATCH, DELETE, route } from 'awilix-express';
import { NextFunction, Request, Response } from 'express';
import IContextContainer from '../../context/icontext-container';
import { adminOnly } from '../../middlewares/platform-admin.middleware';
import * as apiResponse from '../../helpers/api-response.helper';
import { HttpException } from '../../exceptions/http-exception';
import type { JobPatch } from '../../services/admin/job-inventory.service';


@route('/api/admin')
export default class AdminOperationsController {
  constructor(private di: IContextContainer) {}

  @GET()
  @route('/cron/pg/jobs')
  @before(adminOnly)
  async listPgCronJobs(_req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', await this.di.CronService.listJobs());
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/cron/pg/jobs/:id')
  @before(adminOnly)
  async getPgCronJobById(req: Request, res: Response, next: NextFunction) {
    try {
      const jobid = Number(req.params.id);
      if (!Number.isInteger(jobid)) throw new HttpException('invalid jobid', 400);
      return apiResponse.successResponseWithData(res, 'OK', { job: await this.di.CronService.getJob(jobid) });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/cron/pg/jobs')
  @before(adminOnly)
  async createPgCronJob(req: Request, res: Response, next: NextFunction) {
    try {
      const { name, schedule, command } = req.body as { name: string; schedule: string; command: string };
      const job = await this.di.CronService.createJob(name, schedule, command);
      return apiResponse.successResponseWithData(res, 'Created', { job });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @PATCH()
  @route('/cron/pg/jobs/:id')
  @before(adminOnly)
  async togglePgCronJob(req: Request, res: Response, next: NextFunction) {
    try {
      const jobid = Number(req.params.id);
      if (!Number.isInteger(jobid)) throw new HttpException('invalid jobid', 400);
      await this.di.CronService.setActive(jobid, Boolean(req.body.active));
      return apiResponse.successResponseWithData(res, 'Updated', {});
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/cron/pg/jobs/:id/run')
  @before(adminOnly)
  async runPgCronJob(req: Request, res: Response, next: NextFunction) {
    try {
      const jobid = Number(req.params.id);
      if (!Number.isInteger(jobid)) throw new HttpException('invalid jobid', 400);
      return apiResponse.successResponseWithData(res, 'Ran', await this.di.CronService.runJob(jobid));
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/cron/pg/jobs/:id')
  @before(adminOnly)
  async deletePgCronJob(req: Request, res: Response, next: NextFunction) {
    try {
      const jobid = Number(req.params.id);
      if (!Number.isInteger(jobid)) throw new HttpException('invalid jobid', 400);
      await this.di.CronService.deleteJob(jobid);
      return apiResponse.successResponse(res, 'Deleted');
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/cron/pg/jobs/:id/runs')
  @before(adminOnly)
  async pgCronJobRuns(req: Request, res: Response, next: NextFunction) {
    try {
      const jobid = Number(req.params.id);
      if (!Number.isInteger(jobid)) throw new HttpException('invalid jobid', 400);
      const runs = await this.di.CronService.jobRuns(jobid);
      return apiResponse.successResponseWithData(res, 'OK', { runs });
    } catch (error: unknown) {
      return next(error);
    }
  }

  // ── App cron ───────────────────────────────────────────────────────────────

  /**
   * Every job that runs on a timer in this project, in one list.
   *
   * Built from the schedulers themselves (`JobInventoryService`), then joined to
   * the ledger on a stable id: the ledger alone would only show jobs that have
   * already run once. `partial` says when the outcomes are missing rather than
   * absent.
   */
  @GET()
  @route('/cron/app/jobs')
  @before(adminOnly)
  async listAppCronJobs(_req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', await this.di.JobInventoryService.list());
    } catch (error: unknown) {
      return next(error);
    }
  }

  /**
   * Persisted scheduler history. The in-memory status on `/cron/app/jobs`
   * answers "did the last run fail"; this answers "has it been failing" and
   * "has it stopped running", which are the two an operator is paged for.
   */
  @GET()
  @route('/jobs/runs')
  @before(adminOnly)
  async listJobRuns(req: Request, res: Response, next: NextFunction) {
    try {
      const runs = await this.di.JobLedgerService.list({
        job: typeof req.query.job === 'string' ? req.query.job : undefined,
        limit: Number(req.query.limit) || undefined,
      });
      return apiResponse.successResponseWithData(res, 'OK', { runs });
    } catch (error: unknown) {
      return next(error);
    }
  }

  /**
   * Force one job to run now.
   *
   * Routed to the scheduler that declares the id, so a test run is the same
   * code path the timer takes and lands in the ledger the same way, tagged
   * `manual` so it is never mistaken for evidence that the schedule is alive.
   */
  @POST()
  @route('/jobs/:id/run')
  @before(adminOnly)
  async runJobNow(req: Request, res: Response, next: NextFunction) {
    try {
      const id = String(req.params.id ?? '');
      if (!id) throw new HttpException('job id is required', 400);
      const result = await this.di.JobInventoryService.run(id);
      return apiResponse.successResponseWithData(res, 'Ran', result);
    } catch (error: unknown) {
      return next(error);
    }
  }

  /**
   * Change a job's cadence, or arm and disarm it.
   *
   * Only jobs whose schedule is data rather than code accept this; the rest
   * answer 400 and the console links to the settings that own the value.
   */
  @PATCH()
  @route('/jobs/:id')
  @before(adminOnly)
  async configureJob(req: Request, res: Response, next: NextFunction) {
    try {
      const id = String(req.params.id ?? '');
      if (!id) throw new HttpException('job id is required', 400);
      const body = (req.body ?? {}) as { schedule?: unknown; enabled?: unknown };
      const patch: JobPatch = {};
      if (body.schedule !== undefined) {
        if (body.schedule !== null && typeof body.schedule !== 'string') {
          throw new HttpException('schedule must be a cron string or null', 400);
        }
        patch.schedule = body.schedule as string | null;
      }
      if (body.enabled !== undefined) {
        if (typeof body.enabled !== 'boolean') throw new HttpException('enabled must be a boolean', 400);
        patch.enabled = body.enabled;
      }
      if (patch.schedule === undefined && patch.enabled === undefined) {
        throw new HttpException('nothing to change: send schedule, enabled, or both', 400);
      }
      await this.di.JobInventoryService.configure(id, patch);
      return apiResponse.successResponseWithData(res, 'Updated', {});
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/jobs/alerts')
  @before(adminOnly)
  async listJobAlerts(_req: Request, res: Response, next: NextFunction) {
    try {
      // Deliberately the pure read, not `announce`. This is a GET, and a GET
      // that sends webhooks is a side effect reachable with a read-only
      // capability. Delivery is driven from the advisor run instead.
      const alerts = await this.di.JobLedgerService.alerts();
      return apiResponse.successResponseWithData(res, 'OK', { alerts });
    } catch (error: unknown) {
      return next(error);
    }
  }

  // ── Schema migrations ────────────────────────────────────────────────────────

  @GET()
  @route('/migrations')
  @before(adminOnly)
  async listMigrations(_req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', { migrations: await this.di.SchemaMigrationService.list() });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/migrations')
  @before(adminOnly)
  async createMigration(req: Request, res: Response, next: NextFunction) {
    try {
      const { name, upSql, downSql } = req.body as { name?: string; upSql?: string; downSql?: string };
      const migration = await this.di.SchemaMigrationService.create({ name, upSql, downSql });
      return apiResponse.successResponseWithData(res, 'Created', { migration });
    } catch (error: unknown) {
      return next(error);
    }
  }

  // Declared before /migrations/:id so "diff" is not captured as an id param.

  @GET()
  @route('/migrations/diff')
  @before(adminOnly)
  async migrationsDiff(_req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', await this.di.SchemaMigrationService.liveDiff());
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/migrations/:id')
  @before(adminOnly)
  async getMigration(req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', { migration: await this.di.SchemaMigrationService.get(req.params.id) });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/migrations/:id/apply')
  @before(adminOnly)
  async applyMigration(req: Request, res: Response, next: NextFunction) {
    try {
      const migration = await this.di.SchemaMigrationService.apply(req.params.id);
      return apiResponse.successResponseWithData(res, 'Applied', { migration });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/migrations/:id/rollback')
  @before(adminOnly)
  async rollbackMigration(req: Request, res: Response, next: NextFunction) {
    try {
      const migration = await this.di.SchemaMigrationService.rollback(req.params.id);
      return apiResponse.successResponseWithData(res, 'RolledBack', { migration });
    } catch (error: unknown) {
      return next(error);
    }
  }

  // ── Import from Supabase ─────────────────────────────────────────────────────

  // Migrate an existing Supabase project into this Motherbase project. Body:
  //   { connectionString,
  //     serviceRoleKey?, managementToken?, projectRef?, projectUrl?,
  //     include?: {schema?,data?,auth?,storage?,edgeFunctions?,secrets?},
  //     preview?: bool, confirm?: 'IMPORT' }
  //
  // preview:true → dry-run counts (no confirm needed). Otherwise confirm='IMPORT'
  // is required. The connection string, the service_role key and the Management
  // API token are all secrets: none is logged or echoed back.
  //
  // Sections beyond the database need a credential: storage objects need
  // serviceRoleKey, edge functions and secrets need managementToken. Without
  // one, that section reports a note rather than failing the import.

  @POST()
  @route('/import/supabase')
  @before(adminOnly)
  async importSupabase(req: Request, res: Response, next: NextFunction) {
    try {
      const { connectionString, include, preview, confirm, serviceRoleKey, managementToken, projectRef, projectUrl } =
        req.body ?? {};
      const request = { connectionString, include, serviceRoleKey, managementToken, projectRef, projectUrl };
      if (preview) {
        const result = await this.di.ImportService.preview(request);
        return apiResponse.successResponseWithData(res, 'OK', result);
      }
      const result = await this.di.ImportService.importAll({ ...request, confirm });
      return apiResponse.successResponseWithData(res, 'Imported', result);
    } catch (error: unknown) {
      return next(error);
    }
  }
}
