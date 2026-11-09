'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Pencil } from 'lucide-react';
import { PageHeader, PageShell } from '@/shared/ui/PageHeader';
import SettingsForm from '@/shared/ui/SettingsForm';
import { QueryState } from '@/shared/ui/QueryState';
import { Section } from '@/shared/ui/Section';
import { Badge } from '@/shared/ui/Badge';
import { DetailField } from '@/shared/ui/DetailField';
import { WriteButton } from '@/shared/ui/WriteButton';
import { projectPath } from '@/shared/lib/project';
import { useToast } from '@/shared/lib/toast';
import { catalogApi, type ConfigChange, type PostgresConfig, type PostgresSetting } from '@/features/database/api/catalog.api';
import { useCatalogWrite, useDatabaseRoles, usePostgresConfig } from '@/features/database/hooks/useCatalog';
import { PostgresSettingModal } from '@/features/database/components/PostgresSettingModal';

function ConnectionSection({ config }: { config: PostgresConfig }) {
  const { connection } = config;
  return (
    <Section
      title="Connection"
      description="How the API reaches Postgres. The full connection string, password included, is on the Connect page."
      actions={<Link href={projectPath('/connect')} className="btn btn-ghost">Connect</Link>}
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <DetailField label="Host (project network)" value={<span className="mono">{connection.internalHost}:{connection.internalPort}</span>} />
        <DetailField label="Database" value={<span className="mono">{connection.database}</span>} />
        <DetailField label="User" value={<span className="mono">{connection.user}</span>} />
        <DetailField
          label="Published port"
          value={connection.hostPort
            ? <span className="mono">{connection.bind}:{connection.hostPort} {connection.publiclyBound && <Badge tone="warn">reachable from outside</Badge>}</span>
            : 'Not published'}
        />
        <DetailField label="Connection pooler" value="None: the API pools connections in-process" />
        <DetailField label="Postgres" value={<span className="mono">{config.version}</span>} />
      </div>
    </Section>
  );
}

function ParameterRow({ setting, onEdit }: { setting: PostgresSetting; onEdit: () => void }) {
  return (
    <tr>
      <td>
        <div className="mono text-[12.5px]">{setting.name}</div>
        <div className="max-w-[60ch] truncate text-[11px]" style={{ color: 'var(--text-mute)' }} title={setting.description}>{setting.description}</div>
      </td>
      <td className="mono tabular-nums">{setting.value}</td>
      <td>
        <div className="flex flex-wrap gap-1">
          {setting.overrides.map(override => (
            <Badge key={`${override.scope}:${override.role ?? ''}`} tone="info">
              {override.scope}{override.role ? ` ${override.role}` : ''}: {override.value}
            </Badge>
          ))}
          {setting.pendingRestart && <Badge tone="warn">restart pending</Badge>}
        </div>
      </td>
      <td>{setting.context === 'postmaster' ? <Badge>needs restart</Badge> : setting.scopes.includes('database') ? <Badge>per database</Badge> : <Badge>server-wide</Badge>}</td>
      <td className="text-right">
        <WriteButton capability="settings.write" className="btn btn-ghost" title={`Change ${setting.name}`} onClick={onEdit}>
          <Pencil size={12} />
        </WriteButton>
      </td>
    </tr>
  );
}

/**
 * Database > Settings: the Postgres parameters worth tuning, and where each
 * override lives. The same list and rules as `motherbase postgres-config`.
 */
export default function DatabaseSettings() {
  const configQuery = usePostgresConfig();
  const rolesQuery = useDatabaseRoles();
  const toast = useToast();
  const [editing, setEditing] = useState<PostgresSetting | null>(null);

  const apply = useCatalogWrite({
    run: (changes: ConfigChange[]) => catalogApi.updateConfig(changes),
    invalidate: [['db-config']],
    success: changes => (changes[0].value === null ? `Reset ${changes[0].name}` : `Set ${changes[0].name}`),
    failTitle: 'Setting not applied',
    onSuccess: result => {
      setEditing(null);
      if (result.restartRequired.length) {
        toast.push({ kind: 'info', title: 'Restart Postgres to apply', message: result.restartRequired.join(', ') });
      }
    },
  });

  // Roles a per-role override is meaningful for: not the predefined pg_* ones.
  const roles = (rolesQuery.data ?? []).map(role => role.name).filter(name => !name.startsWith('pg_'));

  return (
    <PageShell width="wide">
      <PageHeader title="Database Settings" subtitle="Postgres configuration, connection details, and what the SQL editor may run." />
      <QueryState query={configQuery} skeletonRows={8}>
        {config => (
          <>
            <ConnectionSection config={config} />
            <SettingsForm group="database.sqlEditor" />
            <Section
              title="Configuration"
              description={
                config.canAlterSystem
                  ? 'Session settings are pinned on this database by default; server-wide ones use ALTER SYSTEM and survive restarts.'
                  : 'The server does not connect as a superuser, so only per-database and per-role settings can be changed here.'
              }
              flush
            >
              <div className="overflow-x-auto">
                <table className="console">
                  <thead>
                    <tr>
                      <th>Parameter</th>
                      <th>Value</th>
                      <th>Overrides</th>
                      <th>Scope</th>
                      <th aria-label="Edit" />
                    </tr>
                  </thead>
                  <tbody>
                    {config.settings.map(setting => <ParameterRow key={setting.name} setting={setting} onEdit={() => setEditing(setting)} />)}
                  </tbody>
                </table>
              </div>
              {!config.systemOverridesReadable && (
                <p className="px-5 py-3 text-[11.5px]" style={{ color: 'var(--text-mute)' }}>
                  Server-wide overrides could not be read with this connection, so they are not listed.
                </p>
              )}
            </Section>

            {editing && (
              <PostgresSettingModal
                // Re-read the row so a reset inside the modal shows the new state.
                setting={config.settings.find(setting => setting.name === editing.name) ?? editing}
                roles={roles}
                canAlterSystem={config.canAlterSystem}
                saving={apply.isPending}
                onApply={changes => apply.mutate(changes)}
                onClose={() => setEditing(null)}
              />
            )}
          </>
        )}
      </QueryState>
    </PageShell>
  );
}
