import { proxyHeaders, resolveUpstream, type UpstreamProbe } from '../routes/proxy.routes';

type FetchFn = typeof fetch;

/**
 * The console calling a project's admin API itself, server to server, the way
 * the admin proxy does for a browser: same upstream resolution, same platform
 * token. Branching is the first caller that needs it, since copying a
 * project's migrations or data is a conversation between two stacks.
 */
export class ProjectAdminClient {
  constructor(
    private registry: { platformToken(name: string): Promise<string | undefined> } & Record<string, any>,
    private probe?: UpstreamProbe,
    private fetchFn: FetchFn = fetch,
  ) {}

  /** Is the project's API answering yet? */
  async ready(project: string): Promise<boolean> {
    return (await resolveUpstream(this.registry, project, this.probe)).ready;
  }

  private async send(project: string, method: string, apiPath: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}) {
    const { target } = await resolveUpstream(this.registry, project, this.probe);
    const response = await this.fetchFn(`${target}/api/admin${apiPath}`, {
      method,
      headers: { ...(await proxyHeaders(this.registry, project)), ...init.headers },
      body: init.body,
      // Dumps and restores of a real database take a while.
      signal: AbortSignal.timeout(15 * 60_000),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      throw new Error(`${project} ${method} ${apiPath} answered ${response.status}${body?.message ? `: ${body.message}` : ''}`);
    }
    return response;
  }

  /** A JSON admin call; returns the envelope's `data`. */
  async request<T = any>(project: string, method: string, apiPath: string, body?: unknown): Promise<T> {
    const response = await this.send(project, method, apiPath, body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
    return ((await response.json()) as { data: T }).data;
  }

  /** The bytes of one backup file. Buffered: branches are copies of project databases, not of warehouses. */
  async download(project: string, file: string): Promise<Buffer> {
    const response = await this.send(project, 'GET', `/backups/download?file=${encodeURIComponent(file)}`);
    return Buffer.from(await response.arrayBuffer());
  }

  /** Put a backup file into the project's backup directory; returns the name it was stored under. */
  async upload(project: string, bytes: Buffer, name: string): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)]), name);
    const response = await this.send(project, 'POST', '/backups/upload', { body: form });
    return ((await response.json()) as { data: { file: { name: string } } }).data.file.name;
  }
}
