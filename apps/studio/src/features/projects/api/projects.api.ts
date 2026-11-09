import { api } from '@/shared/lib/api';
import type { ConnectInfo } from '@/shared/lib/snippets';
import type {
  Integration,
  ModelCount,
  OverviewLogEntry,
  SystemStats,
} from '@/features/projects/types';

export interface OverviewStats { counts: ModelCount[]; system: SystemStats }


export const projectsApi = {
  connectInfo: () => api.get('/admin/connect-info').then(r => r.data.data as ConnectInfo),

  stats: () => api.get('/admin/stats').then(r => r.data.data as OverviewStats),
  /**
   * Log lines for the activity panel, bounded by time and not only by count.
   *
   * This used to ask for the last 200 lines with no `since`, and the page then
   * labelled the result "last 60m": on a quiet project those 200 lines can span
   * days, so an error from last week was counted as an error in the last hour.
   */
  logs: (sinceMs: number) =>
    api
      .get('/admin/logs', { params: { limit: 200, since: sinceMs } })
      .then(r => r.data.data.logs as OverviewLogEntry[]),


  integrations: () =>
    api.get('/admin/integrations').then(r => r.data.data.integrations as Integration[]),
  // `functions` is the list of routes to install. Omitted means every template,
  // which is what the server did before the picker existed.
  connectIntegration: (
    key: string,
    secrets: Record<string, string>,
    installFunctions: boolean,
    functions?: string[],
  ) => api.post(`/admin/integrations/${key}/connect`, { secrets, installFunctions, functions }),
  disconnectIntegration: (key: string, removeFunctions: boolean) =>
    api.delete(`/admin/integrations/${key}?removeFunctions=${removeFunctions}`),
};
