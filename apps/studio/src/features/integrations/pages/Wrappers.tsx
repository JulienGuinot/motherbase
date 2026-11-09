'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Cable, Download, FileText, KeyRound, Plus, Trash2 } from 'lucide-react';
import { useProjectId } from '@/shared/hooks/useRouteParam';
import { PageHeader, PageShell } from '@/shared/ui/PageHeader';
import { Badge } from '@/shared/ui/Badge';
import { EmptyState } from '@/shared/ui/EmptyState';
import { QueryState } from '@/shared/ui/QueryState';
import { Section } from '@/shared/ui/Section';
import { WriteButton } from '@/shared/ui/WriteButton';
import { useWrappers, useWrappersAdmin } from '@/features/integrations/hooks/useWrappers';
import {
  CreateServerModal,
  CredentialsModal,
  FileTableModal,
  ImportSchemaModal,
} from '@/features/integrations/components/WrapperModals';
import type { ForeignServer, WrapperInfo } from '@/features/integrations/api/wrappers.api';

const WRAPPER_BLURB: Record<string, string> = {
  postgres_fdw: 'Query tables in another Postgres database as if they were local.',
  file_fdw: 'Read CSV and text files on the database server as tables.',
};

type Dialog =
  | { kind: 'server' }
  | { kind: 'credentials' | 'import' | 'file'; server: ForeignServer };

function WrapperCard({ wrapper, onEnable, enabling }: { wrapper: WrapperInfo; onEnable: () => void; enabling: boolean }) {
  return (
    <div className="card flex items-start gap-3 p-4">
      <Cable size={16} style={{ color: 'var(--text-mute)', marginTop: 2 }} />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <span className="mono text-[13px]" style={{ fontWeight: 600 }}>{wrapper.name}</span>
          {wrapper.installed ? <Badge tone="success" dot>enabled</Badge> : !wrapper.available && <Badge>not in image</Badge>}
        </div>
        <p className="text-[12px]" style={{ color: 'var(--text-mute)' }}>{WRAPPER_BLURB[wrapper.name]}</p>
      </div>
      {!wrapper.installed && wrapper.available && (
        <WriteButton capability="secrets.manage" className="btn" onClick={onEnable} disabled={enabling}>
          Enable
        </WriteButton>
      )}
    </div>
  );
}

export default function Wrappers() {
  const projectId = useProjectId();
  const query = useWrappers();
  const admin = useWrappersAdmin();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const close = () => setDialog(null);
  const closeOnSuccess = { onSuccess: close };

  return (
    <>
      <PageShell width="wide">
        <PageHeader
          title="Wrappers"
          subtitle="Foreign data wrappers: reach another Postgres or a file on the database server as tables. Credentials are kept in the Vault."
          actions={
            <WriteButton capability="secrets.manage" className="btn btn-primary" onClick={() => setDialog({ kind: 'server' })}>
              <Plus size={12} /> Add server
            </WriteButton>
          }
        />

        <QueryState query={query} errorTitle="Could not load wrappers" isEmpty={() => false}>
          {data => (
            <div className="space-y-5">
              <div className="grid gap-3 md:grid-cols-2">
                {data.wrappers.map(wrapper => (
                  <WrapperCard
                    key={wrapper.name}
                    wrapper={wrapper}
                    enabling={admin.enable.isPending}
                    onEnable={() => admin.enable.mutate(wrapper.name)}
                  />
                ))}
              </div>

              <Section title="Servers" flush>
                {data.servers.length === 0 ? (
                  <EmptyState title="No foreign servers" description="Add a server to connect a remote database or a file." />
                ) : (
                  <table className="console w-full">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Wrapper</th>
                        <th>Target</th>
                        <th>Credential</th>
                        <th className="text-right">Tables</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {data.servers.map(server => (
                        <tr key={server.name} className="row-host">
                          <td className="mono">{server.name}</td>
                          <td><Badge>{server.wrapper}</Badge></td>
                          <td className="mono text-[11px]">
                            {server.options.host
                              ? `${server.remoteUser ?? '?'}@${server.options.host}:${server.options.port ?? 5432}/${server.options.dbname ?? ''}`
                              : 'database server filesystem'}
                          </td>
                          <td>
                            {server.vaultSecretId ? (
                              <Link href={`/p/${projectId}/integrations/vault`} className="inline-flex items-center gap-1 text-[11px]" style={{ color: 'var(--accent)' }}>
                                <KeyRound size={11} /> in Vault
                              </Link>
                            ) : (
                              <span className="text-[11px]" style={{ color: 'var(--text-mute)' }}>none</span>
                            )}
                          </td>
                          <td className="text-right tabular-nums">{server.foreignTables}</td>
                          <td className="text-right">
                            <span className="row-actions inline-flex gap-1">
                              {server.wrapper === 'postgres_fdw' ? (
                                <>
                                  <WriteButton capability="secrets.manage" className="btn btn-ghost" title="Import foreign schema" onClick={() => setDialog({ kind: 'import', server })}>
                                    <Download size={12} />
                                  </WriteButton>
                                  <WriteButton capability="secrets.manage" className="btn btn-ghost" title="Credentials" onClick={() => setDialog({ kind: 'credentials', server })}>
                                    <KeyRound size={12} />
                                  </WriteButton>
                                </>
                              ) : (
                                <WriteButton capability="secrets.manage" className="btn btn-ghost" title="Add file table" onClick={() => setDialog({ kind: 'file', server })}>
                                  <FileText size={12} />
                                </WriteButton>
                              )}
                              <WriteButton capability="secrets.manage" className="btn btn-ghost" title="Delete server" style={{ color: 'var(--red)' }} onClick={() => admin.confirmDropServer(server)}>
                                <Trash2 size={12} />
                              </WriteButton>
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Section>

              <Section
                title="Foreign tables"
                description="Foreign tables carry no row level security, so the REST API never serves them. Query them from SQL."
                flush
              >
                {data.tables.length === 0 ? (
                  <EmptyState title="No foreign tables" description="Import a schema from a server, or add a file table." />
                ) : (
                  <table className="console w-full">
                    <thead>
                      <tr>
                        <th>Table</th>
                        <th>Server</th>
                        <th className="text-right">Columns</th>
                        <th>Options</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {data.tables.map(table => (
                        <tr key={`${table.schema}.${table.name}`} className="row-host">
                          <td className="mono">{table.schema}.{table.name}</td>
                          <td className="mono">{table.server}</td>
                          <td className="text-right tabular-nums">{table.columns}</td>
                          <td className="mono text-[11px]">
                            {Object.entries(table.options).map(([k, v]) => `${k}=${v}`).join(' ')}
                          </td>
                          <td className="text-right">
                            <span className="row-actions">
                              <WriteButton capability="secrets.manage" className="btn btn-ghost" title="Delete foreign table" style={{ color: 'var(--red)' }} onClick={() => admin.confirmDropTable(table)}>
                                <Trash2 size={12} />
                              </WriteButton>
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Section>
            </div>
          )}
        </QueryState>
      </PageShell>

      {dialog?.kind === 'server' && (
        <CreateServerModal
          wrappers={(query.data?.wrappers ?? []).filter(w => w.available).map(w => w.name)}
          saving={admin.createServer.isPending}
          onClose={close}
          onCreate={input => admin.createServer.mutate(input, closeOnSuccess)}
        />
      )}
      {dialog?.kind === 'credentials' && (
        <CredentialsModal
          server={dialog.server}
          saving={admin.setCredentials.isPending}
          onClose={close}
          onSave={credentials => admin.setCredentials.mutate({ name: dialog.server.name, ...credentials }, closeOnSuccess)}
        />
      )}
      {dialog?.kind === 'import' && (
        <ImportSchemaModal
          server={dialog.server}
          saving={admin.importSchema.isPending}
          onClose={close}
          onImport={input => admin.importSchema.mutate({ name: dialog.server.name, input }, closeOnSuccess)}
        />
      )}
      {dialog?.kind === 'file' && (
        <FileTableModal
          server={dialog.server}
          saving={admin.createTable.isPending}
          onClose={close}
          onCreate={input => admin.createTable.mutate(input, closeOnSuccess)}
        />
      )}
    </>
  );
}
