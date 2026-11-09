import BaseContext from '../../context/base-context';
import { HttpException } from '../../exceptions/http-exception';
import { INTEGRATIONS, getIntegration, type Integration } from '../../config/integrations-registry';

export interface IntegrationStatus {
  key: string;
  name: string;
  description: string;
  category: Integration['category'];
  docsUrl: string;
  secrets: Array<{ name: string; label: string; placeholder: string; optional?: boolean; set: boolean }>;
  functions: Array<{
    name: string;
    route: string;
    description: string;
    readiness: 'production' | 'example';
    kind: 'action' | 'webhook';
    schedule?: string;
    installed: boolean;
    id?: string;
  }>;
  connected: boolean;
}

export class IntegrationsService extends BaseContext {
  async list(): Promise<IntegrationStatus[]> {
    const [secretNames, fns] = await Promise.all([this.secretNames(), this.di.EdgeFunctionService.list()]);
    const routes = new Map<string, { id: string }>(fns.map((f: any) => [f.route, { id: f.id }]));

    return INTEGRATIONS.map(integration => {
      const secrets = integration.secrets.map(s => ({ ...s, set: secretNames.has(s.name) }));
      const functions = integration.functions.map(f => ({
        name: f.name,
        route: f.route,
        description: f.description,
        readiness: f.readiness ?? 'production',
        kind: f.kind ?? 'action',
        schedule: f.schedule,
        installed: routes.has(f.route),
        id: routes.get(f.route)?.id,
      }));
      const connected = secrets.filter(s => !s.optional).every(s => s.set);
      return {
        key: integration.key,
        name: integration.name,
        description: integration.description,
        category: integration.category,
        docsUrl: integration.docsUrl,
        secrets,
        functions,
        connected,
      };
    });
  }

  /**
   * Connect an integration: persist provided secrets and install the templates
   * the operator picked. `functions` is a list of routes; omitting it installs
   * all of them, which is what the catalogue did before the picker existed.
   * Existing routes are left untouched so user edits to installed functions
   * survive a reconnect.
   */
  async connect(
    key: string,
    secrets: Record<string, string>,
    installFunctions = true,
    functions?: string[],
  ): Promise<{ installed: string[]; skipped: string[] }> {
    const integration = getIntegration(key);
    if (!integration) throw new HttpException('Unknown integration', 404);

    const known = new Set(integration.secrets.map(s => s.name));
    for (const [name, value] of Object.entries(secrets ?? {})) {
      if (!known.has(name)) throw new HttpException(`Unexpected secret "${name}" for ${integration.name}`, 400);
      if (String(value ?? '').length > 0) await this.di.SecretsService.set(name, String(value));
    }

    // A route the operator did not pick must not be installed by a typo: the
    // selection is validated against the catalogue rather than intersected
    // silently, so a stale client gets told instead of getting nothing.
    const selection = functions === undefined ? null : new Set(functions.map(String));
    if (selection) {
      const routes = new Set(integration.functions.map(f => f.route));
      for (const route of selection) {
        if (!routes.has(route)) throw new HttpException(`Unknown function "${route}" for ${integration.name}`, 400);
      }
    }

    const installed: string[] = [];
    const skipped: string[] = [];
    if (installFunctions) {
      const existing = new Set((await this.di.EdgeFunctionService.list()).map((f: any) => f.route));
      for (const fn of integration.functions) {
        if (selection && !selection.has(fn.route)) continue;
        if (existing.has(fn.route)) {
          skipped.push(fn.route);
          continue;
        }
        const created = await this.di.EdgeFunctionService.create({ name: fn.name, route: fn.route, code: fn.code });
        if (fn.schedule) await this.di.EdgeFunctionService.update(created.id, { schedule: fn.schedule });
        installed.push(fn.route);
      }
    }
    return { installed, skipped };
  }

  /**
   * Disconnect an integration: delete its secrets, and optionally the edge
   * functions that were installed from its templates (matched by route).
   */
  async disconnect(key: string, removeFunctions = false): Promise<void> {
    const integration = getIntegration(key);
    if (!integration) throw new HttpException('Unknown integration', 404);

    const secretNames = await this.secretNames();
    for (const s of integration.secrets) {
      if (secretNames.has(s.name)) await this.di.SecretsService.delete(s.name);
    }

    if (removeFunctions) {
      const fns = await this.di.EdgeFunctionService.list();
      const routes = new Set(integration.functions.map(f => f.route));
      for (const fn of fns as any[]) {
        if (routes.has(fn.route)) await this.di.EdgeFunctionService.delete(fn.id);
      }
    }
  }

  private async secretNames(): Promise<Set<string>> {
    const secrets = await this.di.SecretsService.list();
    return new Set(secrets.map((s: any) => s.name));
  }
}
