import { describe, expect, it } from 'vitest';
import { flatNav } from '@/shared/lib/nav';

describe('command palette keywords', () => {
  it('finds the SMTP form by typing smtp, which no label contains', () => {
    const entries = flatNav();
    expect(entries.some(entry => entry.label.toLowerCase().includes('smtp'))).toBe(false);

    const match = entries.find(entry => entry.keywords?.includes('smtp'));
    expect(match?.path).toBe('/auth/settings');
  });
});
