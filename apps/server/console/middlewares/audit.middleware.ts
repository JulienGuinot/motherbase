import type { Request, RequestHandler } from 'express';
import { errorMessage } from '../../lib/errors';
import { sessionUser } from '../auth/session';
import { SAFE_METHODS } from '../constants';
import type { AuditDetail, AuditStore } from '../services/audit.service';


export interface AuditMutation {
  action: string;
  target: string;
  detail?: AuditDetail;
}

type MutationClassifier = (req: Request) => AuditMutation;
type AuditErrorSink = { push: (entry: { level: 'error'; source: string; message: string }) => void };

/**
 * Records the outcome after the response completes. The classifier deliberately
 * receives the request, but callers only return allow-listed metadata.
 */
export function auditMutations(
  audit: AuditStore | undefined,
  classify: MutationClassifier,
  logs?: AuditErrorSink,
): RequestHandler {
  return (req, res, next) => {
    if (!audit || SAFE_METHODS.has(req.method.toUpperCase())) return next();
    const actor = sessionUser(req);
    if (!actor) return next();
    const event = classify(req);
    let recorded = false;

    const record = (completed: boolean) => {
      if (recorded) return;
      recorded = true;
      try {
        audit.append({
          actorId: actor.id,
          actorEmail: actor.email,
          actorRole: actor.role,
          ip: req.ip ?? 'unknown',
          action: event.action,
          target: event.target,
          success: completed && res.statusCode >= 200 && res.statusCode < 400,
          detail: { ...event.detail, statusCode: completed ? res.statusCode : 499 },
        });
      } catch (error: unknown) {
        const message = errorMessage(error);
        logs?.push({ level: 'error', source: 'audit', message: `audit append failed: ${message}` });
      }
    };

    res.once('finish', () => record(true));
    res.once('close', () => record(res.writableFinished));
    return next();
  };
}
