import cron from 'node-cron';
import { errorMessage } from '../lib/errors';
import { logActivity } from '../lib/activity-log';
import IContextContainer from '../context/icontext-container';

export interface AppJobStatus {
  name: string;
  schedule: string;
  lastRunAt: string | null;
  lastStatus: 'ok' | 'error' | null;
  lastError: string | null;
  nextRunAt: string | null;
}

interface JobEntry {
  schedule: string;
  status: AppJobStatus;
}

// Singleton registry shared between initCron and the admin endpoint.
const registry = new Map<string, JobEntry>();

export function listAppJobs(): AppJobStatus[] {
  return Array.from(registry.values()).map(e => e.status);
}

export function computeNextRun(expression: string): string | null {
  try {
    // node-cron 4 exposes the next occurrence, so this finally answers instead of
    // building a task, stopping it and returning null. The task has to be started
    // for the schedule to be computed (`getNextRun()` is null before that), and
    // it runs a no-op anyway; `destroy()` clears the timer immediately.
    const task = cron.createTask(expression, () => {});
    task.start();
    const next = task.getNextRun();
    void task.destroy();
    return next ? next.toISOString() : null;
  } catch {
    return null;
  }
}

/**
 * Intentionally unreferenced: this is the server's extension point for
 * application cron jobs, see the example in initCron below. It is what makes
 * `registry` / `listAppJobs()` meaningful, so don't delete it as "dead code".
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- extension point, see above
function register(
  name: string,
  schedule: string,
  fn: () => Promise<void>
) {
  if (registry.has(name)) {
    logActivity('warn', 'job', `[cron] duplicate job name "${name}". Skipping`);
    return;
  }

  const entry: JobEntry = {
    schedule,
    status: {
      name,
      schedule,
      lastRunAt: null,
      lastStatus: null,
      lastError: null,
      nextRunAt: computeNextRun(schedule),
    },
  };
  registry.set(name, entry);

  cron.schedule(schedule, async () => {
    const s = entry.status;
    try {
      await fn();
      s.lastRunAt = new Date().toISOString();
      s.lastStatus = 'ok';
      s.lastError = null;
    } catch (err) {
      s.lastRunAt = new Date().toISOString();
      s.lastStatus = 'error';
      s.lastError = errorMessage(err);
      logActivity('error', 'job', `[cron] job "${name}" failed: ${s.lastError}`);
    }
  });
}

export const initCron = (_opts: IContextContainer) => () => {
  // Register application-level cron jobs here, e.g.:
  // register('cleanup-expired-tokens', '0 3 * * *', async () => { ... });
};
