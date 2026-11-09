import { Router } from 'express';
import { auditMutations } from '../middlewares/audit.middleware';
import { registerAdminRoutes } from './platform/admin.routes';
import { classifyPlatformMutation } from './platform/audit-classifier';
import type { PlatformDeps } from './platform/deps';
import { registerMonitoringRoutes } from './platform/monitoring.routes';
import { registerProjectRoutes } from './platform/project.routes';

export type { PlatformDeps };

export function platformRouter(deps: PlatformDeps): Router {
  const r = Router();
  r.use(deps.requireSession);
  r.use(auditMutations(deps.audit, classifyPlatformMutation, deps.logs));
  registerAdminRoutes(r, deps);
  registerMonitoringRoutes(r, deps);
  registerProjectRoutes(r, deps);
  return r;
}
