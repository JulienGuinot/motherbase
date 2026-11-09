import { createHmac, randomBytes } from 'crypto';
import BaseContext from '../../../context/base-context';
import { HttpException } from '../../../exceptions/http-exception';
import { encryptSecret, decryptSecret, isEncryptionConfigured } from '../../../helpers/crypto.helper';
import { logActivity } from '../../../lib/activity-log';
import { errorMessage } from '../../../lib/errors';
import prisma from '../../../lib/prisma';
import { safeEqual } from '../../../lib/safe-equal';
import { verifyHubSignature } from '../../../lib/webhook-signature';
import { GitHubApi, authorizeUrl, type GitHubRepo } from './github-api';
import { assertSafeDirectory, orderedMigrationFiles, parseMigrationSql, splitMigrationName } from './migration-files';

/**
 * Connect a GitHub repository to this project and import its migrations, the way
 * Vercel connects a repo and deploys on push.
 *
 * The shape of the feature:
 *
 *   * One repo per project (`LINK_ID`), one branch, one directory of `.sql`
 *     files. See `migration-files.ts` for the file convention.
 *   * A push to the tracked branch calls `/api/git/webhook`, which is
 *     authenticated by GitHub's HMAC signature and by nothing else. It cannot
 *     hold an operator session.
 *   * A sync creates a `SchemaMigration` row per new file and applies it through
 *     `SchemaMigrationService`, so a repo-driven migration and a Studio-authored
 *     one are the same object with the same transactional guarantees and show up
 *     on the same page. Files already imported (matched by name) are skipped, so
 *     a sync is idempotent and re-running one after a failure resumes.
 *   * Files are applied in name order and the run stops at the first failure. A
 *     later migration usually depends on an earlier one, so continuing past a
 *     failure would apply it to a schema that does not exist yet.
 *
 * What it deliberately does not do: build or host application code. This server
 * is the backend, and the only artefact it takes from a repository is SQL.
 */

const LINK_ID = 'default';
/** An OAuth state older than this is refused, so a captured URL cannot be replayed. */
const STATE_TTL_MS = 10 * 60 * 1000;

export interface GitLinkStatus {
  /** The OAuth App credentials are present, so connecting is possible at all. */
  configured: boolean;
  connected: boolean;
  accountLogin: string | null;
  owner: string | null;
  repo: string | null;
  branch: string;
  migrationsPath: string;
  webhookInstalled: boolean;
  lastSyncAt: Date | null;
  lastSyncStatus: string | null;
  lastSyncMessage: string | null;
  lastSyncSha: string | null;
}

export interface SyncResult {
  applied: string[];
  skipped: string[];
  failed: { name: string; message: string } | null;
  sha: string | null;
}

interface GithubConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}

export class GitRepoService extends BaseContext {
  private get api(): GitHubApi {
    return new GitHubApi(this.di.OutboundHttpClient);
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  async status(): Promise<GitLinkStatus> {
    const [config, row] = await Promise.all([this.config().catch(() => null), this.row()]);
    return {
      configured: Boolean(config?.clientId && config?.clientSecret && config?.callbackUrl),
      connected: Boolean(row?.owner),
      accountLogin: row?.accountLogin ?? null,
      owner: row?.owner ?? null,
      repo: row?.repo ?? null,
      branch: row?.branch ?? 'main',
      migrationsPath: row?.migrationsPath ?? 'migrations',
      webhookInstalled: Boolean(row?.webhookId),
      lastSyncAt: row?.lastSyncAt ?? null,
      lastSyncStatus: row?.lastSyncStatus ?? null,
      lastSyncMessage: row?.lastSyncMessage ?? null,
      lastSyncSha: row?.lastSyncSha ?? null,
    };
  }

  // ── OAuth ──────────────────────────────────────────────────────────────────

  /** The URL to send the operator's browser to, with a signed, expiring state. */
  async authorize(): Promise<{ url: string }> {
    const config = await this.config();
    return { url: authorizeUrl(config.clientId, config.callbackUrl, this.signState()) };
  }

  /**
   * Finish the OAuth dance. The row is created here, before a repo is chosen:
   * "authorized but not linked" is a real state the console renders as the repo
   * picker.
   */
  async completeAuthorization(code: string, state: string): Promise<GitLinkStatus> {
    if (!code) throw new HttpException('Missing authorization code', 400);
    this.verifyState(state);
    this.requireEncryption();

    const config = await this.config();
    const token = await this.api.exchangeCode({ ...config, code });
    const { login } = await this.api.viewer(token);

    const encrypted = encryptSecret(token);
    await prisma.gitRepoLink.upsert({
      where: { id: LINK_ID },
      create: { id: LINK_ID, accessToken: encrypted, accountLogin: login },
      // Re-authorising keeps the repo selection: the usual reason to redo this
      // is a revoked token, and losing the link would be a surprise.
      update: { accessToken: encrypted, accountLogin: login },
    });
    logActivity('info', 'webhook', `GitHub connected as ${login}`);
    return this.status();
  }

  // ── Repository selection ───────────────────────────────────────────────────

  async listRepos(): Promise<GitHubRepo[]> {
    return this.api.listRepos(await this.token());
  }

  /**
   * Point the project at a repo, branch and directory, and install the push
   * webhook. Re-linking replaces the previous hook rather than stacking a second
   * one, because two hooks mean two concurrent syncs of the same push.
   */
  async link(input: { owner?: string; repo?: string; branch?: string; migrationsPath?: string }): Promise<GitLinkStatus> {
    this.requireEncryption();
    const owner = String(input.owner ?? '').trim();
    const repo = String(input.repo ?? '').trim();
    if (!owner || !repo) throw new HttpException('owner and repo are required', 400);
    const branch = String(input.branch ?? '').trim() || 'main';
    const migrationsPath = assertSafeDirectory(String(input.migrationsPath ?? 'migrations'));

    const token = await this.token();
    const existing = await this.row();

    // Prove the branch exists before storing anything: a typo here would
    // otherwise present as "connected" with a webhook that never matches.
    const sha = await this.api.branchSha(token, owner, repo, branch);
    if (!sha) throw new HttpException(`Branch ${branch} was not found in ${owner}/${repo}`, 400);

    if (existing?.webhookId && existing.owner && existing.repo) {
      await this.api.deleteWebhook(token, existing.owner, existing.repo, existing.webhookId);
    }

    const secret = randomBytes(32).toString('hex');
    const webhookId = await this.api.createWebhook(token, owner, repo, await this.webhookUrl(), secret);

    await prisma.gitRepoLink.update({
      where: { id: LINK_ID },
      data: {
        owner,
        repo,
        branch,
        migrationsPath,
        webhookId,
        webhookSecret: encryptSecret(secret),
        lastSyncAt: null,
        lastSyncStatus: null,
        lastSyncMessage: null,
        lastSyncSha: null,
      },
    });
    logActivity('info', 'webhook', `GitHub repository linked: ${owner}/${repo}@${branch}`);
    return this.status();
  }

  /** Remove the webhook and forget the token. Migrations already applied stay. */
  async unlink(): Promise<GitLinkStatus> {
    const row = await this.row();
    if (row?.webhookId && row.owner && row.repo) {
      const token = await this.token().catch(() => null);
      if (token) await this.api.deleteWebhook(token, row.owner, row.repo, row.webhookId);
    }
    await prisma.gitRepoLink.deleteMany({ where: { id: LINK_ID } });
    logActivity('info', 'webhook', 'GitHub repository disconnected');
    return this.status();
  }

  // ── Sync ───────────────────────────────────────────────────────────────────

  /**
   * Import and apply every `.sql` file in the linked directory that has not been
   * imported yet, in name order, stopping at the first failure.
   */
  async sync(): Promise<SyncResult> {
    const row = await this.requireLinked();
    const token = await this.token();
    const { owner, repo, branch, migrationsPath } = row as {
      owner: string;
      repo: string;
      branch: string;
      migrationsPath: string;
    };

    const result: SyncResult = { applied: [], skipped: [], failed: null, sha: null };
    try {
      result.sha = await this.api.branchSha(token, owner, repo, branch);
      const entries = await this.api.listDirectory(token, owner, repo, migrationsPath, branch);
      const files = orderedMigrationFiles(entries);

      // Keyed on the version, like the CLI's history. Rows recorded before
      // migrations had versions stored the whole base name, so a file outside
      // the `<version>_<name>` convention is still recognised by that.
      const recorded = await prisma.schemaMigration.findMany({ select: { version: true, name: true } });
      const knownVersions = new Set(recorded.map(m => m.version));
      const knownNames = new Set(recorded.map(m => m.name));

      for (const file of files) {
        const { version, name } = splitMigrationName(file.name);
        if (version ? knownVersions.has(version) : knownNames.has(name)) {
          result.skipped.push(file.name);
          continue;
        }
        // file.path comes back from the listing already rooted at the repo root.
        const contents = await this.api.readFile(token, owner, repo, file.path, branch);
        const { upSql, downSql } = parseMigrationSql(contents);
        if (!upSql) {
          result.skipped.push(file.name);
          continue;
        }
        try {
          const created = await this.di.SchemaMigrationService.create({ version, name, upSql, downSql, origin: 'git' });
          await this.di.SchemaMigrationService.apply(created.id);
          result.applied.push(file.name);
        } catch (err) {
          // Stop here. The next file almost certainly builds on this one, and
          // applying it to a schema that never got this change is how a repo
          // and a database end up permanently out of step.
          result.failed = { name: file.name, message: errorMessage(err) || 'Failed to apply' };
          break;
        }
      }
    } catch (err) {
      result.failed = { name: '', message: errorMessage(err) || 'Sync failed' };
    }

    await this.recordSync(result);
    return result;
  }

  /**
   * Handle a push delivery. Authenticated by the HMAC signature alone, so the
   * signature check comes before anything is parsed or looked up.
   */
  async handlePush(
    rawBody: Buffer | string,
    signature: string | undefined,
    event: string | undefined,
  ): Promise<{ synced: boolean; reason?: string; result?: SyncResult }> {
    const row = await this.row();
    if (!row?.webhookSecret || !row.owner) return { synced: false, reason: 'not linked' };

    const secret = decryptSecret(row.webhookSecret);
    if (!verifyHubSignature(rawBody, signature, secret)) {
      throw new HttpException('Invalid signature', 401);
    }
    // Ping is what GitHub sends the moment the hook is created; answering it
    // successfully is how the hook shows as healthy in the repo settings.
    if (event === 'ping') return { synced: false, reason: 'ping' };
    if (event !== 'push') return { synced: false, reason: `ignored event: ${event ?? 'unknown'}` };

    const payload = JSON.parse(String(rawBody)) as { ref?: string };
    if (payload.ref !== `refs/heads/${row.branch}`) {
      return { synced: false, reason: `ignored ref: ${payload.ref ?? 'unknown'}` };
    }

    logActivity('info', 'webhook', `GitHub push on ${row.owner}/${row.repo}@${row.branch}, syncing migrations`);
    return { synced: true, result: await this.sync() };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async recordSync(result: SyncResult): Promise<void> {
    const message = result.failed
      ? `${result.failed.name ? `${result.failed.name}: ` : ''}${result.failed.message}`
      : result.applied.length
        ? `Applied ${result.applied.length} migration(s): ${result.applied.join(', ')}`
        : 'Already up to date';
    await prisma.gitRepoLink.updateMany({
      where: { id: LINK_ID },
      data: {
        lastSyncAt: new Date(),
        lastSyncStatus: result.failed ? 'failed' : 'ok',
        lastSyncMessage: message,
        lastSyncSha: result.sha,
      },
    });
    logActivity(result.failed ? 'error' : 'info', 'webhook', `GitHub sync: ${message}`);
  }

  private row() {
    return prisma.gitRepoLink.findUnique({ where: { id: LINK_ID } });
  }

  private async requireLinked() {
    const row = await this.row();
    if (!row) throw new HttpException('No GitHub account is connected', 400);
    if (!row.owner || !row.repo) throw new HttpException('No repository is linked', 400);
    return row;
  }

  private async token(): Promise<string> {
    const row = await this.row();
    if (!row) throw new HttpException('No GitHub account is connected', 400);
    try {
      return decryptSecret(row.accessToken);
    } catch {
      throw new HttpException('The stored GitHub token could not be decrypted. Reconnect the account.', 400);
    }
  }

  private async config(): Promise<GithubConfig> {
    const config = await this.di.SettingsService.get<GithubConfig>('git.github');
    if (!config?.clientId || !config?.clientSecret || !config?.callbackUrl) {
      throw new HttpException(
        'GitHub is not configured. Set the OAuth App client id, secret and callback URL in Settings.',
        400,
      );
    }
    return config;
  }

  /** Same origin as the callback the operator registered, see the settings group. */
  private async webhookUrl(): Promise<string> {
    const { callbackUrl } = await this.config();
    return new URL('/api/git/webhook', callbackUrl).toString();
  }

  private requireEncryption(): void {
    if (!isEncryptionConfigured()) {
      throw new HttpException(
        'CONFIG_ENCRYPTION_KEY is not set. A GitHub token cannot be stored without it.',
        500,
      );
    }
  }

  /** `<issuedAt>.<nonce>.<hmac>`, keyed by JWT_SECRET. No table needed. */
  private signState(): string {
    const body = `${Date.now()}.${randomBytes(12).toString('hex')}`;
    return `${body}.${stateMac(body)}`;
  }

  private verifyState(state: string): void {
    const parts = String(state ?? '').split('.');
    if (parts.length !== 3) throw new HttpException('Invalid OAuth state', 400);
    const [issuedAt, nonce, mac] = parts;
    if (!safeEqual(mac, stateMac(`${issuedAt}.${nonce}`))) {
      throw new HttpException('Invalid OAuth state', 400);
    }
    if (!Number.isFinite(Number(issuedAt)) || Date.now() - Number(issuedAt) > STATE_TTL_MS) {
      throw new HttpException('The GitHub authorization expired. Start again.', 400);
    }
  }
}

function stateMac(body: string): string {
  return createHmac('sha256', process.env.JWT_SECRET ?? '').update(body).digest('hex');
}

