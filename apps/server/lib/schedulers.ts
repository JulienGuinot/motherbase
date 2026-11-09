import cron from 'node-cron';

/** Minimal handle a scheduler returns so we can cancel it. */
export interface ScheduledTask {
  stop(): void;
}

/**
 * Pluggable cron scheduler. Production uses node-cron; tests inject a fake that
 * captures the callback and fires it deterministically (no real time).
 */
export interface Scheduler {
  schedule(cronExpr: string, fn: () => void): ScheduledTask;
}

export const nodeCronScheduler: Scheduler = {
  schedule(cronExpr, fn) {
    return cron.schedule(cronExpr, fn);
  },
};

/** Same idea as {@link Scheduler}, for workers that poll on a fixed interval. */
export interface IntervalScheduler {
  every(intervalMs: number, task: () => void): ScheduledTask;
}

export const nodeIntervalScheduler: IntervalScheduler = {
  every(intervalMs, task) {
    const timer = setInterval(task, intervalMs);
    timer.unref();
    return { stop: () => clearInterval(timer) };
  },
};
