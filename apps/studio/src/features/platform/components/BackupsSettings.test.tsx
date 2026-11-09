import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/ui/SettingsForm', () => ({
  default: ({ group }: { group: string }) => <div data-settings-group={group} />,
}));
vi.mock('@/features/platform/hooks/usePlatform', () => ({
  useBackups: () => ({ data: [], isLoading: false, refetch: vi.fn() }),
}));
vi.mock('@/shared/lib/toast', () => ({
  useToast: () => ({ push: vi.fn() }),
}));

import { BackupsSettings } from '@/features/platform/components/BackupsSettings';

describe('BackupsSettings', () => {
  it('exposes the backup.schedule settings group', () => {
    const html = renderToStaticMarkup(<BackupsSettings />);

    expect(html).toContain('data-settings-group="backup.schedule"');
    expect(html).toContain('saving or resetting');
    expect(html).toContain('database or environment');
  });
});
