import { useEffect, useState } from 'react';
import { safeStorage } from '@/shared/lib/safe-storage';

const LS_CPU = 'console.alerts.cpuThreshold';
const LS_MEM = 'console.alerts.memThreshold';

const DEFAULT_CPU_THRESHOLD = 85;
const DEFAULT_MEM_THRESHOLD = 85;

/** A stored threshold, or the default when it is absent or not a finite number. */
export function parseThreshold(raw: string | null, fallback: number): number {
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function useResourceAlertThresholds() {
  const [cpuThreshold, setCpuThresholdState] = useState<number>(() =>
    parseThreshold(safeStorage.get(LS_CPU), DEFAULT_CPU_THRESHOLD));
  const [memThreshold, setMemThresholdState] = useState<number>(() =>
    parseThreshold(safeStorage.get(LS_MEM), DEFAULT_MEM_THRESHOLD));

  useEffect(() => { safeStorage.set(LS_CPU, String(cpuThreshold)); }, [cpuThreshold]);
  useEffect(() => { safeStorage.set(LS_MEM, String(memThreshold)); }, [memThreshold]);

  return {
    cpuThreshold,
    memThreshold,
    setCpuThreshold: setCpuThresholdState,
    setMemThreshold: setMemThresholdState,
  };
}
