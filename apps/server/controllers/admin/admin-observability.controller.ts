import { before, GET, POST, PATCH, PUT, route } from 'awilix-express';
import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import IContextContainer from '../../context/icontext-container';
import { adminOnly, secretKeyOrAdmin } from '../../middlewares/platform-admin.middleware';
import { apiKeyMiddleware } from '../../middlewares/api-key.middleware';
import * as apiResponse from '../../helpers/api-response.helper';
import { metricsService } from '../../services/admin/metrics.service';
import { requestMeter } from '../../services/admin/request-metrics.service';
import { logCursor, matchesLogFilter, parseLogCursor, parseStatusFilter, type LogFilter } from '../../lib/log-filter';
import type { LogEntry } from '../../lib/log-buffer';
import { isLogService, LOG_SERVICES } from '../../lib/log-services';
import { REALTIME_INSPECTOR_RETAINED } from '../../services/admin/realtime-admin.service';
import { backupUpload, removeUploadedFile } from '../../helpers/multer.helper';
import { HttpException } from '../../exceptions/http-exception';
import { parseBody } from '../../lib/zod-body';

/** Admin-gated multipart, for uploading a backup file back into BACKUP_DIR. */
const adminBackupUpload = [...adminOnly, backupUpload.single('file')];

const indexAdvisorSchema = z.object({ query: z.string().trim().min(1).max(100_000) });


/** Default page size, and the ceiling the client cannot argue with. Both sides
 *  of this limit matter: the Logs screen renders every line it is handed. */
const DEFAULT_LOG_LIMIT = 500;
const MAX_LOG_LIMIT = 5_000;

function clampLimit(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(Math.floor(value), MAX_LOG_LIMIT);
}

/** `since` and `until` accept an ISO timestamp or epoch milliseconds. */
function parseInstant(raw: unknown): Date | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  const value = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  return Number.isFinite(value) ? new Date(value) : undefined;
}

/** Repeated or comma-separated query values, e.g. `?level=warn&level=error`. */
function listParam(raw: unknown): string[] | undefined {
  const values = (Array.isArray(raw) ? raw : [raw])
    .filter((value): value is string => typeof value === 'string')
    .flatMap(value => value.split(','))
    .map(value => value.trim())
    .filter(Boolean);
  return values.length ? values : undefined;
}

function textParam(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

/**
 * The Logs Explorer filters, read from the query string. An unknown service
 * or an unreadable status is refused rather than dropped: dropping it would
 * answer a narrower question than the one asked with every line there is.
 */
function logFilterFromQuery(query: Request['query']): LogFilter {
  const services = listParam(query.service);
  const unknown = services?.find(service => !isLogService(service));
  if (unknown) throw new HttpException(`Unknown log service "${unknown}". Use one of: ${LOG_SERVICES.join(', ')}.`, 400);
  const statusRaw = textParam(query.status);
  const statuses = statusRaw ? parseStatusFilter(statusRaw) : undefined;
  if (statuses === null) throw new HttpException('status must look like 404, 5xx or 400-499 (comma-separated).', 400);
  const cursorRaw = textParam(query.before);
  const cursor = cursorRaw ? parseLogCursor(cursorRaw) : undefined;
  if (cursor === null) throw new HttpException('before must be the nextCursor of a previous page.', 400);
  return {
    since: parseInstant(query.since),
    until: parseInstant(query.until),
    levels: listParam(query.level),
    sources: listParam(query.source),
    services: services?.filter(isLogService),
    search: textParam(query.q)?.toLowerCase(),
    statuses,
    method: textParam(query.method),
    path: textParam(query.path),
    userId: textParam(query.user),
    before: cursor,
  };
}

/** Where the next (older) page starts: the oldest line of this one, when more exist. */
function nextCursorOf(logs: LogEntry[], hasMore: boolean): string | null {
  return hasMore && logs.length ? logCursor(logs[0]) : null;
}

@route('/api/admin')
export default class AdminObservabilityController {
  constructor(private di: IContextContainer) {}

  /**
   * Readable with a secret project key as well as by an operator, so a project
   * can fetch the server-side trace behind a request id it was handed. See
   * `secretKeyOrAdmin`.
   */
  @GET()
  @route('/logs')
  @before([apiKeyMiddleware, secretKeyOrAdmin])
  async logs(req: Request, res: Response, next: NextFunction) {
    try {
      const limit = clampLimit(req.query.limit);
      const filter = logFilterFromQuery(req.query);
      const stored = await this.di.LogPersistenceService.config().catch(() => null);

      // The ring buffer only ever holds the last few hundred lines and is lost
      // on restart, so anything but "the last minutes" has to come from the
      // table. The buffer stays the answer when storage is off, and for the
      // sub-second window between a line being emitted and the next flush.
      const take = limit ?? DEFAULT_LOG_LIMIT;

      if (!stored?.enabled) {
        // Same filter as the SQL branch (see lib/log-filter), so a line found
        // in one source is found in the other.
        const all = this.di.logBuffer.recent();
        const matched = all.filter(entry => matchesLogFilter(entry, filter));
        const logs = matched.slice(-take);
        const hasMore = matched.length > logs.length;
        return apiResponse.successResponseWithData(res, 'OK', {
          logs,
          persisted: false,
          retentionDays: null,
          // The oldest line the buffer still holds, NOT the oldest line
          // returned: with a limit reached those differ, and reporting the
          // latter claims nothing older exists.
          oldestAvailable: all[0]?.at ?? null,
          hasMore,
          nextCursor: nextCursorOf(logs, hasMore),
          matched: matched.length,
        });
      }

      await this.di.LogPersistenceService.flush();
      const page = await this.di.LogPersistenceService.queryPage({ ...filter, limit: take });

      return apiResponse.successResponseWithData(res, 'OK', {
        logs: page.logs,
        persisted: true,
        retentionDays: stored.retentionDays,
        oldestAvailable: page.oldestAvailable,
        hasMore: page.hasMore,
        nextCursor: nextCursorOf(page.logs, page.hasMore),
      });
    } catch (error: unknown) {
      return next(error);
    }
  }

  // Depth of the durable outbox: what the in-memory inspector cannot show.
  @GET()
  @route('/realtime/queue')
  @before(adminOnly)
  async realtimeQueue(_req: Request, res: Response, next: NextFunction) {
    try {
      const queue = await this.di.RealtimeAdminService.queueHealth();
      return apiResponse.successResponseWithData(res, 'OK', {
        queue,
        inspectorRetained: REALTIME_INSPECTOR_RETAINED,
      });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/realtime/channels')
  @before(adminOnly)
  async realtimeChannels(_req: Request, res: Response, next: NextFunction) {
    try {
      const channels = await this.di.RealtimeAdminService.getChannels();
      return apiResponse.successResponseWithData(res, 'OK', { channels });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/realtime/events')
  @before(adminOnly)
  async realtimeEvents(req: Request, res: Response, next: NextFunction) {
    try {
      const channel = req.query.channel as string | undefined;
      const events = this.di.RealtimeAdminService.getRecentEvents(channel);
      return apiResponse.successResponseWithData(res, 'OK', { events });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/realtime/channels/:channel/presence')
  @before(adminOnly)
  async realtimePresence(req: Request, res: Response, next: NextFunction) {
    try {
      const users = await this.di.RealtimeAdminService.getPresence(req.params.channel);
      return apiResponse.successResponseWithData(res, 'OK', { users });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/realtime/config')
  @before(adminOnly)
  async realtimeConfig(_req: Request, res: Response, next: NextFunction) {
    try {
      const config = await this.di.RealtimeAdminService.getConfig();
      return apiResponse.successResponseWithData(res, 'OK', config);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @PATCH()
  @route('/realtime/config')
  @before(adminOnly)
  async updateRealtimeConfig(req: Request, res: Response, next: NextFunction) {
    try {
      const models = await this.di.RealtimeAdminService.setEnabledModels(req.body.models ?? []);
      return apiResponse.successResponseWithData(res, 'Updated', { models });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @PATCH()
  @route('/realtime/config/respect-rls')
  @before(adminOnly)
  async updateRealtimeRespectRls(req: Request, res: Response, next: NextFunction) {
    try {
      const model = req.body?.model;
      if (typeof model !== 'string' || model.trim().length === 0) {
        return apiResponse.validationErrorWithData(res, 'model is required', {});
      }
      const respectRls = Boolean(req.body?.respectRls);
      await this.di.RealtimeAdminService.setRespectRls(model, respectRls);
      const updated = await this.di.RealtimeAdminService.getModelConfig(model);
      return apiResponse.successResponseWithData(res, 'Updated', { model, respectRls: updated.respectRls });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/stats')
  @before(adminOnly)
  async stats(_req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', await this.di.AdminService.stats());
    } catch (error: unknown) {
      return next(error);
    }
  }

  // In-memory request meter for this API process: cumulative total, req/min over a
  // rolling window. Resets on restart. Guarded by adminOnly like all /api/admin/*.

  @GET()
  @route('/metrics/requests')
  @before(adminOnly)
  async requestMetrics(_req: Request, res: Response) {
    // lastActivityAt and realtimeClients are what the Console's auto-pause reads.
    return apiResponse.successResponseWithData(res, 'OK', {
      ...requestMeter.snapshot(),
      realtimeClients: this.di.RealtimeAdminService.connectedClients(),
    });
  }

  // Sampled runtime time-series (rps, p95, error rate, memory) for the Reports
  // dashboard. In-memory ring buffer; resets on restart. ?range=15m|1h|24h.
  //
  // `coverage` travels with the samples: the buffer holds about an hour, so a
  // 24h request is answered with what exists AND with the fact that the rest is
  // missing, instead of an hour of data drawn under a 24h label.

  @GET()
  @route('/metrics/timeseries')
  @before(adminOnly)
  async metricsTimeseries(req: Request, res: Response) {
    const RANGES: Record<string, number> = { '15m': 15 * 60_000, '1h': 60 * 60_000, '24h': 24 * 60 * 60_000 };
    const rangeMs = RANGES[(req.query.range as string) ?? '1h'] ?? RANGES['1h'];
    return apiResponse.successResponseWithData(res, 'OK', metricsService.getSeries(rangeMs));
  }

  @GET()
  @route('/performance')
  @before(adminOnly)
  async performance(_req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', await this.di.AdminService.performance());
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/performance/index-advisor')
  @before(adminOnly)
  async indexAdvisorStatus(_req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', await this.di.IndexAdvisorService.status());
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/performance/index-advisor/enable')
  @before(adminOnly)
  async enableIndexAdvisor(_req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'Enabled', await this.di.IndexAdvisorService.enable());
    } catch (error: unknown) {
      return next(error);
    }
  }

  /** A POST for its body, not because it writes: the query is only planned, over hypothetical indexes. */
  @POST()
  @route('/performance/index-advisor')
  @before(adminOnly)
  async adviseIndexes(req: Request, res: Response, next: NextFunction) {
    try {
      const { query } = parseBody(indexAdvisorSchema, req.body);
      return apiResponse.successResponseWithData(res, 'OK', await this.di.IndexAdvisorService.advise(query));
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/backups')
  @before(adminOnly)
  async backups(_req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', { backups: await this.di.BackupService.list() });
    } catch (error: unknown) {
      return next(error);
    }
  }

  // Local dumps + (when offsite is enabled) remote objects.

  @GET()
  @route('/backups/list')
  @before(adminOnly)
  async backupsList(_req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', await this.di.BackupService.listAll());
    } catch (error: unknown) {
      return next(error);
    }
  }

  // Effective backup schedule config (AppSetting overrides env).

  @GET()
  @route('/backups/config')
  @before(adminOnly)
  async backupConfig(_req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', await this.di.BackupService.config());
    } catch (error: unknown) {
      return next(error);
    }
  }

  // Persist config to AppSetting and reschedule the in-process job live.

  @PUT()
  @route('/backups/config')
  @before(adminOnly)
  async updateBackupConfig(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = (req.user as any)?.id;
      const saved = await this.di.SettingsService.set('backup.schedule', req.body ?? {}, userId);
      await this.di.BackupSchedulerService.reschedule();
      return apiResponse.successResponseWithData(res, 'Saved', saved.values);
    } catch (error: unknown) {
      return next(error);
    }
  }

  // Manual backup now; offsite/prune per the current effective config.

  @POST()
  @route('/backups/run')
  @before(adminOnly)
  async runBackup(_req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', await this.di.BackupSchedulerService.runOnce());
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/backups')
  @before(adminOnly)
  async createBackup(req: Request, res: Response, next: NextFunction) {
    try {
      const backup = await this.di.BackupService.backupDatabase(req.body?.file, { clean: req.body?.clean === true });
      return apiResponse.successResponseWithData(res, 'Created', backup);
    } catch (error: unknown) {
      return next(error);
    }
  }

  // Restore from a local dump ({ file }) or an offsite object ({ key }); both
  // require confirm === 'RESTORE'.

  @POST()
  @route('/backups/restore')
  @before(adminOnly)
  async restoreBackup(req: Request, res: Response, next: NextFunction) {
    try {
      const body = req.body ?? {};
      const result = body.key
        ? await this.di.BackupService.restoreFromRemote(body)
        : await this.di.BackupService.restoreDatabase(body);
      return apiResponse.successResponseWithData(res, 'Restored', result);
    } catch (error: unknown) {
      return next(error);
    }
  }

  // Stream a backup file to the browser: ?file=<local dump name> or
  // ?key=<offsite object key> (downloaded locally first).
  @GET()
  @route('/backups/download')
  @before(adminOnly)
  async downloadBackup(req: Request, res: Response, next: NextFunction) {
    try {
      const file = req.query.key
        ? (await this.di.BackupService.downloadBackup(String(req.query.key))).name
        : String(req.query.file ?? '');
      const path = await this.di.BackupService.localFilePath(file);
      return res.download(path, file);
    } catch (error: unknown) {
      return next(error);
    }
  }

  // The counterpart to /backups/download. Without it a downloaded backup could
  // never be fed back in: every restore path reads from BACKUP_DIR on the box.
  @POST()
  @route('/backups/upload')
  @before(adminBackupUpload)
  async uploadBackupFile(req: Request, res: Response, next: NextFunction) {
    const file = req.file;
    try {
      if (!file) throw new HttpException('A backup file is required (multipart field "file")', 400);
      const saved = await this.di.BackupService.importBackup({
        tempPath: file.path,
        originalName: file.originalname,
      });
      return apiResponse.successResponseWithData(res, 'Uploaded', { file: saved });
    } catch (error: unknown) {
      return next(error);
    } finally {
      await removeUploadedFile(file);
    }
  }

  @POST()
  @route('/backups/export')
  @before(adminOnly)
  async exportProject(req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'Exported', {
        file: await this.di.BackupService.exportProject(req.body?.file),
      });
    } catch (error: unknown) {
      return next(error);
    }
  }

  // Database dump + every storage object, bundled as one tar. See
  // BackupService.exportFullProject for why the DB dump alone already covers
  // config/functions/users/policies.
  @POST()
  @route('/backups/export-full')
  @before(adminOnly)
  async exportFullProject(req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'Exported', {
        file: await this.di.BackupService.exportFullProject(req.body?.file),
      });
    } catch (error: unknown) {
      return next(error);
    }
  }

  // Unpack a full project archive into database.sql + its storage objects. See
  // BackupService.extractArchive for why this extracts rather than restores.
  @POST()
  @route('/backups/extract')
  @before(adminOnly)
  async extractBackupArchive(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await this.di.BackupService.extractArchive({ file: String(req.body?.file ?? '') });
      return apiResponse.successResponseWithData(res, 'Extracted', result);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/backups/clone-staging')
  @before(adminOnly)
  async cloneStaging(req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'Cloned', await this.di.BackupService.cloneStaging(req.body ?? {}));
    } catch (error: unknown) {
      return next(error);
    }
  }
}
