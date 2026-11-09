import prisma from '../../lib/prisma';
import { errorMessage } from '../../lib/errors';
import { HttpException } from '../../exceptions/http-exception';

export interface PgCronJob {
  jobid: number;
  jobname: string;
  schedule: string;
  command: string;
  active: boolean;
  database: string;
  username: string;
}

export interface PgCronRun {
  runid: number;
  jobid: number;
  status: string;
  return_message: string | null;
  start_time: string | null;
  end_time: string | null;
}

export class CronService {
  async isPgCronInstalled(): Promise<boolean> {
    try {
      const rows = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT count(*)::bigint AS count
        FROM pg_extension
        WHERE extname = 'pg_cron'
      `;
      return Number(rows[0]?.count ?? 0) > 0;
    } catch {
      return false;
    }
  }

  async listJobs(): Promise<{ jobs: PgCronJob[]; extensionMissing: boolean }> {
    if (!(await this.isPgCronInstalled())) {
      return { jobs: [], extensionMissing: true };
    }
    const rows = await prisma.$queryRaw<PgCronJob[]>`
      SELECT
        jobid,
        jobname,
        schedule,
        command,
        active,
        database,
        username
      FROM cron.job
      ORDER BY jobid
    `;
    return { jobs: rows, extensionMissing: false };
  }

  async jobRuns(jobid: number, limit = 50): Promise<PgCronRun[]> {
    if (!(await this.isPgCronInstalled())) return [];
    try {
      return await prisma.$queryRaw<PgCronRun[]>`
        SELECT runid, jobid, status, return_message, start_time, end_time
        FROM cron.job_run_details
        WHERE jobid = ${jobid}
        ORDER BY start_time DESC NULLS LAST
        LIMIT ${Math.min(Math.max(limit, 1), 200)}
      `;
    } catch {
      // job_run_details may be unavailable on some pg_cron configurations.
      return [];
    }
  }

  async createJob(name: string, schedule: string, command: string): Promise<PgCronJob> {
    if (!name?.trim()) throw new HttpException('name is required', 400);
    if (!schedule?.trim()) throw new HttpException('schedule is required', 400);
    if (!command?.trim()) throw new HttpException('command is required', 400);
    if (!(await this.isPgCronInstalled())) {
      throw new HttpException('pg_cron extension is not installed', 400);
    }
    try {
      await prisma.$queryRaw`SELECT cron.schedule(${name}, ${schedule}, ${command})`;
    } catch (err) {
      throw new HttpException(errorMessage(err) || 'Failed to schedule job', 400);
    }
    const jobs = await prisma.$queryRaw<PgCronJob[]>`
      SELECT jobid, jobname, schedule, command, active, database, username
      FROM cron.job WHERE jobname = ${name}
    `;
    if (!jobs.length) throw new HttpException('Job created but not found', 500);
    return jobs[0];
  }

  async getJob(jobid: number): Promise<PgCronJob> {
    if (!(await this.isPgCronInstalled())) {
      throw new HttpException('pg_cron extension is not installed', 400);
    }
    const jobs = await prisma.$queryRaw<PgCronJob[]>`
      SELECT jobid, jobname, schedule, command, active, database, username
      FROM cron.job WHERE jobid = ${jobid}
    `;
    if (!jobs.length) throw new HttpException('Job not found', 404);
    return jobs[0];
  }

  /**
   * Run a job's command once, now, to test it. pg_cron has no "run now": this
   * executes the stored SQL on the server's own connection, so it does not
   * appear in `cron.job_run_details` and does not run as the job's `username`.
   */
  async runJob(jobid: number): Promise<{ durationMs: number; rowsAffected: number }> {
    const job = await this.getJob(jobid);
    const startedAt = Date.now();
    try {
      const rowsAffected = await prisma.$executeRawUnsafe(job.command);
      return { durationMs: Date.now() - startedAt, rowsAffected };
    } catch (err) {
      throw new HttpException(errorMessage(err) || 'Job command failed', 400);
    }
  }

  async setActive(jobid: number, active: boolean): Promise<void> {
    if (!(await this.isPgCronInstalled())) {
      throw new HttpException('pg_cron extension is not installed', 400);
    }
    const result = await prisma.$executeRaw`
      UPDATE cron.job SET active = ${active} WHERE jobid = ${jobid}
    `;
    if (!result) throw new HttpException('Job not found', 404);
  }

  async deleteJob(jobid: number): Promise<void> {
    if (!(await this.isPgCronInstalled())) {
      throw new HttpException('pg_cron extension is not installed', 400);
    }
    const jobs = await prisma.$queryRaw<{ jobname: string }[]>`
      SELECT jobname FROM cron.job WHERE jobid = ${jobid}
    `;
    if (!jobs.length) throw new HttpException('Job not found', 404);
    try {
      await prisma.$queryRaw`SELECT cron.unschedule(${jobs[0].jobname})`;
    } catch (err) {
      throw new HttpException(errorMessage(err) || 'Failed to unschedule job', 400);
    }
  }
}
