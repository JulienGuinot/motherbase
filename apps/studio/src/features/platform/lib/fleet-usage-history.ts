import { safeStorage } from '@/shared/lib/safe-storage';

export interface FleetUsageSample {
  cpu: number;
  mem: number;
}

const STORAGE_KEY = 'console.fleet.usageHistory';
const listeners = new Set<() => void>();
let history = loadHistory();
let lastRecordedUpdate = 0;

function loadHistory(): FleetUsageSample[] {
  try {
    const stored = JSON.parse(safeStorage.get(STORAGE_KEY) ?? '[]');
    return Array.isArray(stored) ? stored.slice(-60) : [];
  } catch {
    return [];
  }
}

export function getFleetUsageHistory(): FleetUsageSample[] {
  return history;
}

export function subscribeFleetUsageHistory(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function recordFleetUsage(
  projects: Array<{
    cpuLimit?: number;
    cpuPct?: number;
    cpuPercent: number;
    memLimitBytes?: number;
    memPct?: number;
    memPercent: number;
  }>,
  dataUpdatedAt: number,
): void {
  if (!dataUpdatedAt || dataUpdatedAt === lastRecordedUpdate || projects.length === 0) return;
  lastRecordedUpdate = dataUpdatedAt;
  const cpu = projects.reduce((sum, project) => sum + (project.cpuLimit ? project.cpuPct ?? 0 : project.cpuPercent), 0) / projects.length;
  const mem = projects.reduce((sum, project) => sum + (project.memLimitBytes ? project.memPct ?? 0 : project.memPercent), 0) / projects.length;
  history = [...history, { cpu, mem }].slice(-60);
  safeStorage.set(STORAGE_KEY, JSON.stringify(history));
  listeners.forEach(listener => listener());
}
