// Central navigation taxonomy: single source of truth for the studio shell.
// Supabase-style two-tier nav: a thin icon rail (products) + a contextual panel
// per product. Consumed by NavRail, ProductLayout/NavPanel, the topbar
// breadcrumbs and the command palette.

import {
  LayoutDashboard,
  Table,
  Terminal,
  Database,
  Users,
  FolderOpen,
  Radio,
  Zap,
  Blocks,
  ShieldAlert,
  BarChart3,
  ScrollText,
  Code2,
  Settings,
  Plug,
  Lock,
  Braces,
  Puzzle,
  GitBranch,
  GitCompare,
  DatabaseBackup,
  Webhook,
  Clock,
  LogIn,
  KeyRound,
  Fingerprint,
  ShieldCheck,
  Grid3x3,
  Building2,
  Telescope,
  Network,
  Rows3,
  ListTree,
  Tags,
  UserCog,
  Columns3,
  Send,
  SlidersHorizontal,
  ShieldBan,
  History,
  Link2,
  Gauge,
  Inbox,
  Vault,
  Cable,
  FileText,
} from 'lucide-react';

type IconType = React.ComponentType<{ size?: number; color?: string }>;

interface NavItem {
  /** Path segment appended to the product base, '' for the product index. */
  to: string;
  label: string;
  icon: IconType;
  /** Extra terms the command palette matches on. The label is what a page is
   *  called; these are what people actually type when looking for it. SMTP
   *  lives under Authentication - Settings, which nobody guesses. */
  keywords?: string[];
}

export interface NavPanelConfig {
  title: string;
  items: NavItem[];
}

export interface Product {
  key: string;
  label: string;
  icon: IconType;
  /** Project-relative base path, e.g. '/database'. */
  base: string;
  /** Static contextual panel; absent means the product is single-page. */
  panel?: NavPanelConfig;
  placement?: 'main' | 'bottom';
}

const databasePanel: NavPanelConfig = {
  title: 'Database',
  items: [
    { to: 'schemas', label: 'Schema Visualizer', icon: Network, keywords: ['erd', 'diagram', 'relations', 'foreign keys'] },
    { to: 'tables', label: 'Tables', icon: Rows3, keywords: ['size', 'rows'] },
    { to: 'functions', label: 'Functions', icon: Braces },
    { to: 'triggers', label: 'Triggers', icon: GitBranch },
    { to: 'types', label: 'Enumerated Types', icon: Tags, keywords: ['enum'] },
    { to: 'extensions', label: 'Extensions', icon: Puzzle },
    { to: 'indexes', label: 'Indexes', icon: ListTree },
    { to: 'publications', label: 'Publications', icon: Send, keywords: ['replication', 'logical', 'wal'] },
    { to: 'roles', label: 'Roles', icon: UserCog, keywords: ['postgres roles', 'login', 'users'] },
    { to: 'column-privileges', label: 'Column Privileges', icon: Columns3, keywords: ['grant', 'revoke'] },
    { to: 'settings', label: 'Settings', icon: SlidersHorizontal, keywords: ['statement_timeout', 'max_connections', 'work_mem', 'postgres config', 'connection', 'sql editor', 'read-only', 'allow writes'] },
    { to: 'migrations', label: 'Migrations', icon: GitCompare },
    { to: 'backups', label: 'Backups', icon: DatabaseBackup },
    { to: 'webhooks', label: 'Webhooks', icon: Webhook },
    { to: 'cron', label: 'Cron Jobs', icon: Clock },
    { to: 'queues', label: 'Queues', icon: Inbox, keywords: ['pgmq', 'message queue', 'jobs'] },
  ],
};

const integrationsPanel: NavPanelConfig = {
  title: 'Integrations',
  items: [
    { to: '', label: 'Catalogue', icon: Blocks },
    { to: 'vault', label: 'Vault', icon: Vault, keywords: ['secrets', 'encryption', 'supabase_vault'] },
    { to: 'wrappers', label: 'Wrappers', icon: Cable, keywords: ['fdw', 'foreign data wrapper', 'postgres_fdw', 'file_fdw'] },
  ],
};

const authPanel: NavPanelConfig = {
  title: 'Authentication',
  items: [
    { to: '', label: 'Users', icon: Users },
    { to: 'policies', label: 'Policies', icon: Lock },
    { to: 'access', label: 'Role Access', icon: Grid3x3, keywords: ['rls', 'permissions', 'anon', 'authenticated'] },
    { to: 'providers', label: 'Sign In / Providers', icon: LogIn },
    { to: 'sessions', label: 'Sessions', icon: KeyRound },
    { to: 'mfa', label: 'Multi-Factor', icon: ShieldCheck },
    { to: 'rate-limits', label: 'Rate Limits', icon: Gauge, keywords: ['429', 'throttle', 'email rate limit', 'sms rate limit'] },
    { to: 'url-configuration', label: 'URL Configuration', icon: Link2, keywords: ['site url', 'redirect urls', 'redirectTo', 'callback'] },
    { to: 'protection', label: 'Attack Protection', icon: ShieldBan, keywords: ['captcha', 'hcaptcha', 'turnstile', 'leaked passwords', 'hibp'] },
    { to: 'third-party', label: 'Third-Party Auth', icon: Network, keywords: ['clerk', 'firebase', 'auth0', 'cognito', 'workos', 'jwks', 'oidc'] },
    { to: 'hooks', label: 'Auth Hooks', icon: ShieldAlert },
    { to: 'audit', label: 'Audit Logs', icon: History, keywords: ['audit_log_entries', 'sign-in history', 'events'] },
    { to: 'passkeys', label: 'Passkeys', icon: Fingerprint },
    { to: 'organizations', label: 'Organizations', icon: Building2 },
    { to: 'settings', label: 'Settings', icon: Settings, keywords: ['smtp', 'email', 'mail', 'sms', 'twilio', 'templates', 'tokens', 'api keys'] },
  ],
};

const observabilityPanel: NavPanelConfig = {
  title: 'Observability',
  items: [
    { to: '', label: 'Overview', icon: Telescope },
    { to: 'api', label: 'API Gateway', icon: BarChart3 },
    { to: 'database', label: 'Query Performance', icon: Database },
    { to: 'reports', label: 'Reports', icon: FileText, keywords: ['custom', 'charts', 'dashboard'] },
  ],
};

export const PRODUCTS: Product[] = [
  { key: 'overview', label: 'Home', icon: LayoutDashboard, base: '/overview' },
  { key: 'tables', label: 'Table Editor', icon: Table, base: '/tables' },
  { key: 'sql', label: 'SQL Editor', icon: Terminal, base: '/sql' },
  { key: 'database', label: 'Database', icon: Database, base: '/database', panel: databasePanel },
  { key: 'auth', label: 'Authentication', icon: Users, base: '/auth', panel: authPanel },
  { key: 'storage', label: 'Storage', icon: FolderOpen, base: '/storage' },
  { key: 'realtime', label: 'Realtime', icon: Radio, base: '/realtime' },
  { key: 'edge-functions', label: 'Edge Functions', icon: Zap, base: '/edge-functions' },
  { key: 'integrations', label: 'Integrations', icon: Blocks, base: '/integrations', panel: integrationsPanel },
  { key: 'branches', label: 'Branches', icon: GitBranch, base: '/branches' },
  { key: 'advisor', label: 'Advisors', icon: ShieldAlert, base: '/advisor' },
  { key: 'observability', label: 'Observability', icon: Telescope, base: '/observability', panel: observabilityPanel },
  { key: 'logs', label: 'Logs', icon: ScrollText, base: '/logs' },
  { key: 'api', label: 'API Docs', icon: Code2, base: '/api' },
  { key: 'connect', label: 'Connect', icon: Plug, base: '/connect', placement: 'bottom' },
  { key: 'settings', label: 'Project Settings', icon: Settings, base: '/settings', placement: 'bottom' },
];

export const PRODUCT_BY_KEY: Record<string, Product> = Object.fromEntries(
  PRODUCTS.map(p => [p.key, p]),
);

/** Strip a leading `/p/:id` prefix, returning the project-relative pathname. */
export function stripProjectPrefix(pathname: string): string {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] === 'p' && parts[1]) return '/' + parts.slice(2).join('/');
  return '/' + parts.join('/');
}

/** Resolve the active product from a pathname (with or without project prefix). */
export function resolveProduct(pathname: string): Product | undefined {
  const rel = stripProjectPrefix(pathname);
  const seg = '/' + (rel.split('/').filter(Boolean)[0] ?? '');
  return PRODUCTS.find(p => p.base === seg);
}

/**
 * Human label for a project-relative path segment (topbar breadcrumbs).
 *
 * `parent` is the segment before it. A panel item can share its segment with
 * a product (`/database/tables` vs the Table Editor at `/tables`,
 * `/observability/database` vs Database), and under its own product the panel
 * item is the one meant.
 */
export function segmentLabel(seg: string, parent?: string): string {
  const owner = parent ? PRODUCTS.find(p => p.base === '/' + parent) : undefined;
  const own = owner?.panel?.items.find(i => i.to === seg);
  if (own) return own.label;
  const product = PRODUCTS.find(p => p.base === '/' + seg);
  if (product) return product.label;
  for (const p of PRODUCTS) {
    const item = p.panel?.items.find(i => i.to === seg);
    if (item) return item.label;
  }
  return seg;
}

/** Typed deep-link builder. Returns a project-relative path (no `/p/:id`). */
export function linkTo(productKey: string, sub?: string): string {
  const product = PRODUCT_BY_KEY[productKey];
  if (!product) return '/overview';
  return sub ? `${product.base}/${sub}` : product.base;
}

export interface FlatNavEntry { id: string; label: string; icon: IconType; path: string; keywords?: string[]; }

/** Flattened products + panel items for the command palette. */
export function flatNav(): FlatNavEntry[] {
  const out: FlatNavEntry[] = [];
  for (const p of PRODUCTS) {
    out.push({ id: p.key, label: p.label, icon: p.icon, path: p.base });
    if (p.panel) {
      for (const item of p.panel.items) {
        if (!item.to) continue;
        out.push({ id: `${p.key}:${item.to}`, label: `${p.label} · ${item.label}`, icon: item.icon, path: `${p.base}/${item.to}`, keywords: item.keywords });
      }
    }
  }
  return out;
}
