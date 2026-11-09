import { Database, Terminal, HardDrive, Users, Radio, Boxes, Gauge, SlidersHorizontal } from 'lucide-react';
import { safeStorage } from '@/shared/lib/safe-storage';

export interface TourStep {
  icon: React.ComponentType<{ size?: number }>;
  title: string;
  body: string;
  target?: string;
}

const PROJECT_SEEN_KEY = 'console.onboarding.project.seen';
const FLEET_SEEN_KEY = 'console.onboarding.fleet.seen';

export const PROJECT_TOUR_STEPS: TourStep[] = [
  { icon: Database, title: 'Tables & schema', body: 'Browse and edit rows, manage columns, indexes and relationships across every table in your database.', target: '[data-tour="nav-tables"]' },
  { icon: Terminal, title: 'SQL editor', body: 'Run raw SQL against your database with a full query history, saved snippets and schema autocomplete.', target: '[data-tour="nav-sql"]' },
  { icon: Users, title: 'Identity & access', body: 'Manage end users, roles and row-level security policies that control who can read or write what.', target: '[data-tour="nav-auth"]' },
  { icon: HardDrive, title: 'Storage', body: 'Upload, browse and share files across buckets, with visibility, quotas and CORS per bucket.', target: '[data-tour="nav-storage"]' },
  { icon: Radio, title: 'Realtime & edge functions', body: 'Inspect live WebSocket channels and broadcasts, and deploy edge functions and Postgres triggers.', target: '[data-tour="nav-realtime"]' },
];

export const FLEET_TOUR_STEPS: TourStep[] = [
  { icon: Boxes, title: 'One VPS, many projects', body: 'This home page lists every project running on this server. Start, stop, restart or destroy any of them from here.' },
  { icon: Gauge, title: 'Fleet resource usage', body: 'CPU and memory split by project, a rolling usage trend, and a banner that warns you when a project crosses its alert threshold.' },
  { icon: SlidersHorizontal, title: 'Quotas & platform settings', body: 'Tune CPU/memory quotas per project (also editable from inside a project\'s own Settings), and manage console users and their project access from System.' },
];

export function markOnboardingSeen(kind: 'project' | 'fleet'): void {
  safeStorage.set(kind === 'project' ? PROJECT_SEEN_KEY : FLEET_SEEN_KEY, '1');
}

export function hasSeenProjectOnboarding(): boolean {
  return safeStorage.get(PROJECT_SEEN_KEY) === '1';
}

export function hasSeenFleetOnboarding(): boolean {
  return safeStorage.get(FLEET_SEEN_KEY) === '1';
}
