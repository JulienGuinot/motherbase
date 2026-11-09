import type { Request } from 'express';
import { SLUG_RE } from '../../../constants/regex.constants';
import type { AuditMutation } from '../../middlewares/audit.middleware';
import { LIMIT_KEYS } from './limits';

const PROJECT_CONFIG_FIELDS = ['domain', 'storageDomain', 'minioConsoleDomain', 'corsOrigins', 'apiImage', 'certResolver'];
const PLATFORM_SETTING_FIELDS = [
  'domainSuffix', 'adminEmail', 'apiImage', 'certResolver', 'traefikNetwork',
  'alertWebhookUrl', 'alertCpuThreshold', 'alertMemThreshold',
];

function safeProjectTarget(value: unknown): string {
  return `project:${typeof value === 'string' && SLUG_RE.test(value) ? value : 'unknown'}`;
}

function selectedFields(body: unknown, allowList: readonly string[]): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  return allowList.filter(key => Object.prototype.hasOwnProperty.call(body, key));
}

/** Stable semantic classification; never returns request values beyond validated IDs. */
export function classifyPlatformMutation(req: Request): AuditMutation {
  const routePath = req.path;
  if (req.method === 'POST' && routePath === '/projects') {
    return { action: 'project.create', target: safeProjectTarget(req.body?.name) };
  }
  const lifecycle = routePath.match(/^\/projects\/([^/]+)\/(start|stop|restart|update|rebuild)$/);
  if (req.method === 'POST' && lifecycle) {
    return { action: `project.runtime.${lifecycle[2]}`, target: safeProjectTarget(lifecycle[1]) };
  }
  const projectSetting = routePath.match(/^\/projects\/([^/]+)\/(config|limits)$/);
  if (req.method === 'PATCH' && projectSetting) {
    const isConfig = projectSetting[2] === 'config';
    return {
      action: isConfig ? 'project.settings.update' : 'project.limits.update',
      target: safeProjectTarget(projectSetting[1]),
      detail: { fields: selectedFields(req.body, isConfig ? PROJECT_CONFIG_FIELDS : LIMIT_KEYS) },
    };
  }
  const deleted = routePath.match(/^\/projects\/([^/]+)$/);
  if (req.method === 'DELETE' && deleted) {
    return { action: 'project.delete', target: safeProjectTarget(deleted[1]) };
  }
  if (req.method === 'PUT' && routePath === '/settings') {
    return {
      action: 'platform.settings.update',
      target: 'platform',
      detail: { fields: selectedFields(req.body, PLATFORM_SETTING_FIELDS) },
    };
  }
  if (req.method === 'PUT' && routePath === '/project-defaults') {
    return { action: 'platform.settings.update', target: 'platform:project-defaults' };
  }
  if (req.method === 'POST' && routePath === '/account/password') {
    return { action: 'account.password.change', target: 'account:self' };
  }
  return { action: 'platform.mutation', target: 'platform' };
}
