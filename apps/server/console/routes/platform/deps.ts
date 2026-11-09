import type { RequestHandler } from 'express';
import type { PlatformSettingsService } from '../../services/settings.service';
import type { ProjectDefaultsStore } from '../../services/project-defaults.service';
import type { OrgAiConfigService } from '../../services/org-ai.service';
import type { PlatformUsersService } from '../../services/users.service';
import type { OrgStore } from '../../services/org-store';
import type { AuditStore } from '../../services/audit.service';
import type { UpstreamProbe } from '../proxy.routes';

export interface PlatformDeps {
  orchestrator: any;
  registry: any;
  branches?: { hasBranches(project: string): Promise<boolean> };
  diagnostics?: any;
  logs?: any;
  metrics?: any;
  settings?: PlatformSettingsService;
  projectDefaults?: ProjectDefaultsStore;
  users?: PlatformUsersService;
  orgs?: OrgStore;
  orgAi?: OrgAiConfigService;
  updates?: { check: () => Promise<any>; currentVersion: () => string; plan?: () => Promise<any> };
  audit?: AuditStore;
  requireSession: RequestHandler;
  /** Overridable so tests can answer the readiness probe without a container. */
  probe?: UpstreamProbe;
  // The console shares one mutable config object across services. Account/settings
  // mutations write to it in place so they take effect without a restart.
  cfg: {
    mode: 'dev' | 'prod';
    domainSuffix: string;
    adminEmail?: string;
    adminPasswordHash?: string;
    apiImage?: string;
    certResolver?: string;
    traefikNetwork?: string;
    alertWebhookUrl?: string;
    alertCpuThreshold?: string;
    alertMemThreshold?: string;
  };
}
