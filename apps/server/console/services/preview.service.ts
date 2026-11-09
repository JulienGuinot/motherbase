import { SLUG_RE } from '../../constants/regex.constants';

// Preview projects: one isolated stack per pull request, torn down when the PR
// closes.
//
// This is the differentiator that costs the least, because the hard part is
// already built: provisioning an isolated project from a Compose file is what
// the Console does. What was missing is the four lines of glue between a GitHub
// webhook and `orchestrator.create` / `orchestrator.destroy`.
//
// Everything that decides *what* to do lives here as pure functions over the
// event payload, so the routing layer only verifies a signature and calls in.

export interface PreviewConfig {
  enabled: boolean;
  /** `owner/repo` entries allowed to provision. Empty means none: fail closed. */
  repoAllowlist: string[];
  /** Hours after which an untouched preview is swept, 0 to never sweep. */
  ttlHours: number;
}

export type PreviewDecision =
  | { action: 'create'; project: string; pr: number; repo: string; branch: string }
  | { action: 'destroy'; project: string; pr: number; repo: string }
  | { action: 'ignore'; reason: string };

/** GitHub `pull_request` actions that mean "the code changed, rebuild". */
const BUILD_ACTIONS = new Set(['opened', 'reopened', 'synchronize', 'ready_for_review']);
const TEARDOWN_ACTIONS = new Set(['closed']);

/**
 * Project name for a pull request.
 *
 * It has to be a DNS label (it becomes a subdomain) and stable across events for
 * the same PR, so a `synchronize` updates the stack it created rather than
 * provisioning a second one. Derived from the repository name and the PR number,
 * both of which are immutable for the life of the PR. The branch name is not,
 * so it is deliberately not part of this.
 */
export function previewProjectName(repo: string, pr: number): string {
  const shortRepo = String(repo).split('/').pop() ?? repo;
  const slug = shortRepo
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    // A DNS label is 63 characters. Reserve room for the `pr-<n>-` prefix.
    .slice(0, 40) || 'repo';
  return `pr-${pr}-${slug}`;
}

/** True when this name was produced by `previewProjectName`, i.e. is disposable. */
export function isPreviewProject(name: string): boolean {
  return /^pr-\d+-[a-z0-9-]+$/.test(String(name));
}

/**
 * What a `pull_request` webhook should cause.
 *
 * Draft pull requests are ignored until they are marked ready: provisioning a
 * database for every work-in-progress push is how this feature turns into a
 * surprise hosting bill.
 */
export function decide(event: any, config: PreviewConfig): PreviewDecision {
  if (!config.enabled) return { action: 'ignore', reason: 'previews are disabled' };

  const action = String(event?.action ?? '');
  const pr = Number(event?.pull_request?.number ?? event?.number);
  const repo = String(event?.repository?.full_name ?? '');
  const branch = String(event?.pull_request?.head?.ref ?? '');

  if (!repo || !Number.isInteger(pr) || pr <= 0) {
    return { action: 'ignore', reason: 'payload is not a pull_request event' };
  }
  // Fail closed. An empty allowlist provisioning for anyone would let any
  // repository that learns the URL spend this host's disk.
  if (!config.repoAllowlist.includes(repo)) {
    return { action: 'ignore', reason: `repository ${repo} is not allowlisted` };
  }

  const project = previewProjectName(repo, pr);
  // Belt and braces: the name is generated, but it is about to be joined onto a
  // filesystem path and a subdomain.
  if (!SLUG_RE.test(project)) return { action: 'ignore', reason: 'derived project name is invalid' };

  if (TEARDOWN_ACTIONS.has(action)) return { action: 'destroy', project, pr, repo };
  if (!BUILD_ACTIONS.has(action)) return { action: 'ignore', reason: `action ${action} needs no change` };
  if (event?.pull_request?.draft && action !== 'ready_for_review') {
    return { action: 'ignore', reason: 'pull request is a draft' };
  }
  return { action: 'create', project, pr, repo, branch };
}

/**
 * Preview projects whose last event is older than the TTL.
 *
 * The sweeper exists because a teardown can be missed: a webhook delivery fails,
 * a repository is deleted, someone closes a PR while the console is down. Without
 * it those stacks live forever and the operator finds out through disk usage.
 */
export function expiredPreviews(
  projects: Array<{ name: string; createdAt?: string }>,
  config: PreviewConfig,
  now: Date = new Date(),
): string[] {
  if (!config.ttlHours || config.ttlHours <= 0) return [];
  const cutoff = now.getTime() - config.ttlHours * 3600_000;
  return projects
    .filter(project => isPreviewProject(project.name))
    .filter(project => {
      const created = Date.parse(project.createdAt ?? '');
      // An unparseable timestamp is not evidence of expiry. Leaving the stack up
      // costs disk; destroying someone's database on a bad date string does not
      // have an equivalent undo.
      return Number.isFinite(created) && created < cutoff;
    })
    .map(project => project.name);
}

/** The comment posted back on the pull request. */
export function previewComment(project: string, url: string): string {
  return [
    `### Preview ready`,
    ``,
    `| | |`,
    `|---|---|`,
    `| API | ${url} |`,
    `| Project | \`${project}\` |`,
    ``,
    `This stack has its own database and storage. It is destroyed when this pull request closes.`,
  ].join('\n');
}
