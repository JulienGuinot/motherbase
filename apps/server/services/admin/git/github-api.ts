import { HttpException } from '../../../exceptions/http-exception';
import type { OutboundHttpClientLike } from '../../http/outbound-http-client.service';

/**
 * The slice of the GitHub REST API this project uses, and nothing more.
 *
 * Every call goes through `OutboundHttpClient`, not `fetch`, so it inherits the
 * SSRF guard: the host is resolved, checked to be public and pinned before the
 * socket opens. That matters here because the owner/repo/path segments are
 * operator input.
 */

const API = 'https://api.github.com';
const OAUTH_AUTHORIZE = 'https://github.com/login/oauth/authorize';
const OAUTH_TOKEN = 'https://github.com/login/oauth/access_token';

/** Directory listings and file blobs are far larger than the 256KB default. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** `repo` covers private repositories, reading contents and managing webhooks. */
export const OAUTH_SCOPES = 'repo';

export interface GitHubRepo {
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  updatedAt: string | null;
}

export interface GitHubContentEntry {
  name?: string;
  path?: string;
  type?: string;
}

export function authorizeUrl(clientId: string, callbackUrl: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl,
    scope: OAUTH_SCOPES,
    state,
    allow_signup: 'false',
  });
  return `${OAUTH_AUTHORIZE}?${params.toString()}`;
}

export class GitHubApi {
  constructor(private readonly http: OutboundHttpClientLike) {}

  /** Exchange an authorization code for a user access token. */
  async exchangeCode(params: {
    clientId: string;
    clientSecret: string;
    callbackUrl: string;
    code: string;
  }): Promise<string> {
    const response = await this.http.request(OAUTH_TOKEN, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: params.clientId,
        client_secret: params.clientSecret,
        code: params.code,
        redirect_uri: params.callbackUrl,
      }),
      maxResponseBytes: 64 * 1024,
    });
    const payload = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      error_description?: string;
      error?: string;
    };
    if (!payload.access_token) {
      // GitHub answers 200 with an `error` field for a bad or reused code.
      throw new HttpException(
        payload.error_description || payload.error || 'GitHub did not return an access token',
        400,
      );
    }
    return payload.access_token;
  }

  async viewer(token: string): Promise<{ login: string }> {
    const user = (await this.get(token, '/user')) as { login?: string };
    if (!user.login) throw new HttpException('GitHub did not identify the account', 502);
    return { login: user.login };
  }

  /** Repositories the token can push to, most recently updated first. */
  async listRepos(token: string): Promise<GitHubRepo[]> {
    const raw = (await this.get(
      token,
      '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member',
    )) as Array<Record<string, any>>;
    return (Array.isArray(raw) ? raw : [])
      .filter(repo => repo?.permissions?.admin || repo?.permissions?.push)
      .map(repo => ({
        fullName: String(repo.full_name),
        owner: String(repo.owner?.login ?? ''),
        name: String(repo.name),
        private: Boolean(repo.private),
        defaultBranch: String(repo.default_branch ?? 'main'),
        updatedAt: repo.updated_at ? String(repo.updated_at) : null,
      }));
  }

  /** Directory listing at `path` on `ref`. A missing directory is an empty list. */
  async listDirectory(
    token: string,
    owner: string,
    repo: string,
    path: string,
    ref: string,
  ): Promise<GitHubContentEntry[]> {
    const url = `/repos/${seg(owner)}/${seg(repo)}/contents/${path.split('/').map(seg).join('/')}?ref=${encodeURIComponent(ref)}`;
    const raw = await this.get(token, url, { allow404: true });
    if (raw === null) return [];
    if (!Array.isArray(raw)) {
      throw new HttpException(`${path || '/'} is a file, not a directory of migrations`, 400);
    }
    return raw as GitHubContentEntry[];
  }

  /** UTF-8 contents of one file. */
  async readFile(token: string, owner: string, repo: string, path: string, ref: string): Promise<string> {
    const url = `/repos/${seg(owner)}/${seg(repo)}/contents/${path.split('/').map(seg).join('/')}?ref=${encodeURIComponent(ref)}`;
    const raw = (await this.get(token, url)) as { content?: string; encoding?: string };
    if (typeof raw.content !== 'string') throw new HttpException(`Could not read ${path}`, 502);
    return raw.encoding === 'base64'
      ? Buffer.from(raw.content, 'base64').toString('utf8')
      : raw.content;
  }

  /** Head commit sha of a branch, recorded so a sync can name what it ran from. */
  async branchSha(token: string, owner: string, repo: string, branch: string): Promise<string | null> {
    const raw = (await this.get(
      token,
      `/repos/${seg(owner)}/${seg(repo)}/commits/${seg(branch)}`,
      { allow404: true },
    )) as { sha?: string } | null;
    return raw?.sha ?? null;
  }

  /** Create the push webhook. Returns its id so disconnect can remove it. */
  async createWebhook(
    token: string,
    owner: string,
    repo: string,
    url: string,
    secret: string,
  ): Promise<string> {
    const created = (await this.request(token, `/repos/${seg(owner)}/${seg(repo)}/hooks`, {
      method: 'POST',
      body: {
        name: 'web',
        active: true,
        events: ['push'],
        config: { url, content_type: 'json', secret, insecure_ssl: '0' },
      },
    })) as { id?: number | string };
    if (created.id === undefined) throw new HttpException('GitHub did not return a webhook id', 502);
    return String(created.id);
  }

  /** Best effort: a hook the operator already deleted must not block disconnect. */
  async deleteWebhook(token: string, owner: string, repo: string, hookId: string): Promise<void> {
    await this.request(token, `/repos/${seg(owner)}/${seg(repo)}/hooks/${seg(hookId)}`, {
      method: 'DELETE',
      allow404: true,
    }).catch(() => undefined);
  }

  private get(token: string, path: string, opts: { allow404?: boolean } = {}): Promise<unknown> {
    return this.request(token, path, opts);
  }

  private async request(
    token: string,
    path: string,
    opts: { method?: string; body?: unknown; allow404?: boolean } = {},
  ): Promise<unknown> {
    const response = await this.http.request(`${API}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'motherbase',
        ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      maxResponseBytes: MAX_RESPONSE_BYTES,
      timeoutMs: 15_000,
    });

    if (response.status === 404 && opts.allow404) return null;
    if (response.status === 204) return null;
    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))) as { message?: string };
      // 401 here means the stored token was revoked on GitHub's side, which the
      // console has to be able to tell apart from "the repo is gone".
      throw new HttpException(
        `GitHub ${response.status}: ${detail.message || response.statusText || 'request failed'}`,
        response.status === 401 || response.status === 403 ? 401 : 502,
      );
    }
    return response.json().catch(() => null);
  }
}

/** Encode one path segment; owner/repo/branch names are operator input. */
function seg(value: string): string {
  return encodeURIComponent(value);
}
