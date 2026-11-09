import { describe, expect, it } from 'vitest';
import { projectFill } from '@/features/platform/components/DiskUsageCard';

const MB = 1024 ** 2;
const GB = 1024 ** 3;

describe('projectFill', () => {
  // Six small projects on a 144.3 GB disk, each with a 10 GB quota. Scaling the
  // bars to the largest project would draw a full bar for 0.9% of a quota.
  it('fills against the quota the text names, not against the largest project', () => {
    const disk = 144.3 * GB;
    expect(projectFill(88.9 * MB, 10 * GB, disk)).toBeCloseTo(0.87, 2);
    expect(projectFill(66 * MB, 10 * GB, disk)).toBeCloseTo(0.64, 2);
  });

  it('falls back to the whole disk without a quota, and to nothing without either', () => {
    expect(projectFill(1.443 * GB, undefined, 144.3 * GB)).toBeCloseTo(1, 5);
    expect(projectFill(88.9 * MB, undefined, undefined)).toBeNull();
  });
});
