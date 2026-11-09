import type React from 'react';
import { Moon, Sun, Monitor, Trash2, Database, KeyRound, Globe, RefreshCw } from 'lucide-react';
import { useSession, usePlatformConnectInfo } from '@/features/platform/hooks/usePlatform';
import { usePreferences } from '@/shared/lib/theme';
import { useToast } from '@/shared/lib/toast';
import { Section } from '@/shared/ui/Section';
import { SettingRow } from '@/shared/ui/Row';
import { SkeletonList } from '@/shared/ui/Skeleton';

function PreferenceOption({ active, onClick, icon: Icon, label }: { active: boolean; onClick: () => void; icon?: React.ComponentType<{ size?: number }>; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="flex items-center gap-2 px-3 py-1.5 text-[11px]"
      style={{
        background: active ? 'var(--accent-soft)' : 'transparent',
        color: active ? 'var(--text)' : 'var(--text-mute)',
      }}
    >
      {Icon && <Icon size={12} />} {label}
    </button>
  );
}

function Tile({ icon: Icon, title, desc }: { icon: React.ComponentType<{ size?: number }>; title: string; desc: string }) {
  return (
    <div className="card flex items-start gap-3 p-4">
      <Icon size={16} />
      <div>
        <div className="text-[13px]" style={{ fontWeight: 600 }}>{title}</div>
        <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-mute)' }}>{desc}</div>
      </div>
    </div>
  );
}

export function GeneralSettings() {
  const {
    theme,
    density,
    animations,
    setTheme,
    setDensity,
    setAnimations,
    resetPreferences,
  } = usePreferences();
  const toast = useToast();

  const sessionQ = useSession();

  // The project's real public API URL (built server-side from BASE_HOST), not the
  // console proxy origin. Same source as the Connect page.
  const connectQ = usePlatformConnectInfo();
  const publicApiUrl = connectQ.data?.apiUrl ?? `${location.origin}/api`;

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Appearance */}
        <Section bodyClassName="space-y-3" title="Appearance">
          <SettingRow label="Theme" hint="Follow the device theme or choose a fixed appearance.">
            <div className="flex overflow-hidden rounded-md border hairline-strong" style={{ background: 'var(--surface-2)' }}>
              <PreferenceOption
                active={theme === 'dark'}
                onClick={() => setTheme('dark')}
                icon={Moon}
                label="Dark"
              />
              <PreferenceOption
                active={theme === 'light'}
                onClick={() => setTheme('light')}
                icon={Sun}
                label="Light"
              />
              <PreferenceOption active={theme === 'system'} onClick={() => setTheme('system')} icon={Monitor} label="System" />
            </div>
          </SettingRow>

          <SettingRow label="Interface density" hint="Adjust controls and data tables across the console.">
            <div className="flex overflow-hidden rounded-md border hairline-strong" style={{ background: 'var(--surface-2)' }}>
              <PreferenceOption active={density === 'comfortable'} onClick={() => setDensity('comfortable')} label="Comfortable" />
              <PreferenceOption active={density === 'compact'} onClick={() => setDensity('compact')} label="Compact" />
            </div>
          </SettingRow>

          <SettingRow label="Animations" hint="Disable motion while keeping every interaction available.">
            <div className="flex overflow-hidden rounded-md border hairline-strong" style={{ background: 'var(--surface-2)' }}>
              <PreferenceOption active={animations === 'on'} onClick={() => setAnimations('on')} label="On" />
              <PreferenceOption active={animations === 'off'} onClick={() => setAnimations('off')} label="Off" />
            </div>
          </SettingRow>
        </Section>

        {/* Profile */}
        <Section bodyClassName="space-y-3" title="Operator">
          {sessionQ.data ? (
            <>
              <SettingRow label="Email"><span className="text-[12px]">{sessionQ.data.email}</span></SettingRow>
              <SettingRow label="Role"><span className="chip" style={{ color: 'var(--accent)' }}>{sessionQ.data.role}</span></SettingRow>
              <SettingRow label="User ID"><span className="mono text-[11px] break-all">{sessionQ.data.id}</span></SettingRow>
            </>
          ) : (
            <SkeletonList rows={3} height={24} />
          )}
        </Section>

        {/* Project */}
        <Section bodyClassName="space-y-3" title="Project">
          <SettingRow label="API base URL" hint="The project's public API endpoint (clients call this directly).">
            <span className="mono text-[12px] break-all">{publicApiUrl}</span>
          </SettingRow>
          <SettingRow label="Console basename"><span className="mono text-[12px]">/console</span></SettingRow>
          <SettingRow label="Build" hint="Vite + React 19 + Tailwind v4.">
            <span className="text-[12px]" style={{ color: 'var(--text-mute)' }}>vite · v1.0</span>
          </SettingRow>
        </Section>

        {/* Danger / cache */}
        <Section bodyClassName="space-y-3" title="Danger zone" tone="danger">
          <SettingRow label="Reset console preferences" hint="Appearance, navigation, schema, editor history, alerts and onboarding.">
            <button
              onClick={() => {
                resetPreferences();
                toast.push({ kind: 'success', title: 'Console preferences reset' });
                setTimeout(() => location.reload(), 400);
              }}
              className="btn"
              style={{ color: 'var(--red)', borderColor: 'var(--red)' }}
            >
              <Trash2 size={12} /> Reset preferences
            </button>
          </SettingRow>

          <SettingRow label="Refresh metadata" hint="Re-fetch table schemas and counts.">
            <button
              onClick={() => { location.reload(); }}
              className="btn"
            >
              <RefreshCw size={12} /> Reload
            </button>
          </SettingRow>
        </Section>
      </div>

      {/* Surface tiles */}
      <section className="grid gap-3 md:grid-cols-3">
        <Tile icon={Database} title="Schema" desc="Browse models, columns, types." />
        <Tile icon={KeyRound} title="Secrets" desc="Editable from the Settings provider tabs." />
        <Tile icon={Globe} title="Regions" desc="Single-region deployment." />
      </section>
    </div>
  );
}
