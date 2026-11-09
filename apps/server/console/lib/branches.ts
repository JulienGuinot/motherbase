import { SLUG_RE } from '../../constants/regex.constants';
import type { BranchInfo } from './manifest';

// Preview branches: a project's isolated copy, as its own stack. The pure part
// is naming, and deciding what a merge or rebase has to replay.

/** A DNS label and a compose project name, so both limits apply. */
const MAX_SLUG = 63;

/**
 * The branch's project slug: `<parent>-<branch>`, from a display name that
 * may be a git branch (`feature/Login`). Derived rather than chosen so the
 * console can find a branch from its parent and name alone.
 */
export function branchProjectName(parent: string, name: string): string {
  const suffix = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!suffix) throw new Error('branch name must contain a letter or digit');
  const slug = `${parent}-${suffix}`.slice(0, MAX_SLUG).replace(/-+$/, '');
  // Hyphens in positions 3-4 mark an IDNA label ("xn--"), which certificate
  // authorities refuse for anything that is not punycode.
  if (!SLUG_RE.test(slug) || slug.slice(2, 4) === '--') throw new Error(`cannot derive a valid project name from ${name}`);
  return slug;
}

/** The project's own domain, moved to the branch: `app.example.com` → `app-feature.example.com`. */
export function branchDomain(parentDomain: string, parent: string, slug: string): string {
  const dot = parentDomain.indexOf('.');
  const suffix = dot >= 0 ? parentDomain.slice(dot + 1) : parentDomain;
  const first = dot >= 0 ? parentDomain.slice(0, dot) : '';
  // Keep a custom first label (api.example.com) by appending the branch part to it.
  const label = first === parent ? slug : `${first}-${slug.slice(parent.length + 1)}`;
  return `${label}.${suffix}`;
}

export interface MigrationRecord {
  id: string;
  name: string;
  upSql: string;
  downSql: string | null;
  checksum: string;
  status: string;
  appliedAt: string | null;
}

const key = (m: MigrationRecord) => `${m.name}\u0000${m.checksum}`;

function applied(rows: MigrationRecord[]): MigrationRecord[] {
  return rows
    .filter(m => m.status === 'applied')
    .sort((a, b) => Date.parse(a.appliedAt ?? '') - Date.parse(b.appliedAt ?? ''));
}

/**
 * Where two migration histories diverge, compared by name and checksum.
 *
 *   ahead   applied on the branch and not on the parent: what a merge replays
 *   behind  applied on the parent since the branch was cut: what a rebase replays
 *
 * Both in the order they were applied, which is the order they must replay in.
 */
export function migrationDiff(parent: MigrationRecord[], branch: MigrationRecord[]) {
  const onParent = new Set(applied(parent).map(key));
  const onBranch = new Set(applied(branch).map(key));
  return {
    ahead: applied(branch).filter(m => !onParent.has(key(m))),
    behind: applied(parent).filter(m => !onBranch.has(key(m))),
  };
}

/**
 * A branch left `creating` or `seeding` by a console that restarted mid-job
 * will never finish: nothing is running it any more. Reported as failed, so
 * the operator resets or deletes it instead of waiting forever.
 */
export function effectiveBranchStatus(info: BranchInfo, inFlight: boolean): Pick<BranchInfo, 'status' | 'error'> {
  if (inFlight || info.status === 'active' || info.status === 'failed') return { status: info.status, error: info.error };
  return { status: 'failed', error: 'interrupted: the console restarted before the branch was ready' };
}
