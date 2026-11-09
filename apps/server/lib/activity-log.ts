import { logBuffer } from '../models';
import type { LogLevel } from './log-buffer';

const MAX_MESSAGE_LENGTH = 2_000;

/**
 * Known non-HTTP log sources. The request logger writes `http` itself and the
 * SQL editor writes `sql`; everything that is not an inbound HTTP request goes
 * through here.
 *
 * Background work (jobs, webhook delivery, realtime, edge invocations) produces
 * no request line at all, so without this it is invisible in the Logs screen.
 * An operator cannot tell "the backup never ran" from "the backup ran fine".
 */
export type ActivitySource =
  | 'edge'
  | 'job'
  | 'webhook'
  | 'auth'
  | 'storage'
  | 'shield'
  | 'realtime'
  | 'pooler'
  | 'ai';

/**
 * Append one line to the shared ring buffer. Never throws: a log write must not
 * be able to fail the operation it is describing.
 */
export function logActivity(level: LogLevel, source: ActivitySource, message: string): void {
  try {
    logBuffer.push({
      level,
      source,
      message: message.length > MAX_MESSAGE_LENGTH ? `${message.slice(0, MAX_MESSAGE_LENGTH)}…` : message,
    });
  } catch {
    /* a broken log buffer must stay invisible to callers */
  }
}
