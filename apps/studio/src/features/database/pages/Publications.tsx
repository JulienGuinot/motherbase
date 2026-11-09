'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Plug, Plus, Table2, Trash2 } from 'lucide-react';
import { PageHeader, PageShell } from '@/shared/ui/PageHeader';
import SchemaSelect from '@/shared/ui/SchemaSelect';
import { QueryState } from '@/shared/ui/QueryState';
import { EmptyState } from '@/shared/ui/EmptyState';
import { Section } from '@/shared/ui/Section';
import { Badge } from '@/shared/ui/Badge';
import { Note } from '@/shared/ui/Row';
import { CodeBlock } from '@/shared/ui/CodeBlock';
import { Checkbox, Field } from '@/shared/ui/Field';
import { Toggle } from '@/shared/ui/Toggle';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/shared/ui/Modal';
import { WriteButton } from '@/shared/ui/WriteButton';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';
import { useSchema } from '@/shared/lib/schema';
import { projectPath } from '@/shared/lib/project';
import { useTableStats, useCatalogWrite, usePostgresConfig, usePublications } from '@/features/database/hooks/useCatalog';
import { catalogApi, type PostgresConfig, type Publication, type PublicationUpdate, type PublishActions, type TableRef } from '@/features/database/api/catalog.api';

const ACTIONS: Array<keyof PublishActions> = ['insert', 'update', 'delete', 'truncate'];

/**
 * On Supabase, `supabase_realtime` is the switch that makes a table realtime,
 * and people arriving from there reach for it. Here it switches nothing: say
 * so before the edit, not after the operator wonders why nothing broadcasts.
 */
async function confirmRealtimeEdit(publication: Publication): Promise<boolean> {
  if (!publication.supabaseRealtime) return true;
  return confirmDialog({
    title: 'This publication does not drive Motherbase Realtime',
    description:
      'supabase_realtime came with your Supabase import. Motherbase Realtime broadcasts the tables chosen under Realtime settings, ' +
      'whatever this publication contains. Edit it only if an external subscriber still reads it.',
    confirmLabel: 'Edit anyway',
  });
}

type NewPublication = PublishActions & { name: string; allTables: boolean; tables: TableRef[] };

/**
 * A publication is three choices, and all three are made here: its name (what
 * a subscriber asks for), which changes leave, and which tables they come from.
 * It used to ask for the name alone, which read as if that were the whole thing.
 */
function NewPublicationModal({ schema, saving, onSave, onClose }: {
  schema: string;
  saving: boolean;
  onSave: (body: NewPublication) => void;
  onClose: () => void;
}) {
  const tablesQuery = useTableStats(schema);
  const [name, setName] = useState('');
  const [allTables, setAllTables] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [actions, setActions] = useState<PublishActions>({ insert: true, update: true, delete: true, truncate: true });
  const toggle = (table: string, include: boolean) =>
    setPicked(current => (include ? [...current, table] : current.filter(t => t !== table)));

  return (
    <Modal onClose={onClose}>
      <ModalHeader
        title="New publication"
        description="Choose which row changes leave this database. Nothing is sent until a subscriber connects and asks for this publication by name."
      />
      <ModalBody className="space-y-4">
        <Field label="Name" hint="The subscriber names it in CREATE SUBSCRIPTION … PUBLICATION <name>.">
          <input className="input mono w-full" value={name} placeholder="warehouse_feed" onChange={event => setName(event.target.value)} autoFocus />
        </Field>
        <Field label="Changes to send">
          <div className="flex flex-wrap gap-4">
            {ACTIONS.map(action => (
              <Checkbox key={action} checked={actions[action]} onChange={value => setActions(current => ({ ...current, [action]: value }))} label={action} />
            ))}
          </div>
        </Field>
        <Field label="Tables">
          <div className="space-y-2">
            <Checkbox checked={allTables} onChange={setAllTables} label="Every table, including ones created later (needs superuser)" />
            {!allTables && (
              <QueryState query={tablesQuery} skeletonRows={3} empty={<p className="text-[12px]" style={{ color: 'var(--text-mute)' }}>No tables in {schema}.</p>}>
                {tables => (
                  <div className="max-h-56 overflow-y-auto rounded-md border hairline px-3 py-1">
                    {/* Views cannot be published. */}
                    {tables.filter(t => t.kind === 'table' || t.kind === 'partitioned').map(table => (
                      <div key={table.name} className="py-1.5">
                        <Checkbox checked={picked.includes(table.name)} onChange={include => toggle(table.name, include)} label={<span className="mono">{schema}.{table.name}</span>} />
                      </div>
                    ))}
                  </div>
                )}
              </QueryState>
            )}
          </div>
        </Field>
      </ModalBody>
      <ModalFooter>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button
          className="btn btn-primary"
          disabled={saving || !name.trim() || !ACTIONS.some(a => actions[a])}
          onClick={() => onSave({ name: name.trim(), allTables, tables: allTables ? [] : picked.map(table => ({ schema, table })), ...actions })}
        >
          Create publication
        </button>
      </ModalFooter>
    </Modal>
  );
}

/**
 * The other half of a publication, which this page used to leave out: what the
 * subscriber runs. Built from this project's real connection details, so the
 * operator copies a command rather than guesses at one.
 */
function SubscribeModal({ publication, connection, onClose }: {
  publication: Publication;
  connection: PostgresConfig['connection'] | undefined;
  onClose: () => void;
}) {
  const port = connection?.hostPort;
  const sql = [
    '-- On the subscriber: another Postgres, where the same tables already exist.',
    `CREATE SUBSCRIPTION ${publication.name}_sub`,
    `  CONNECTION 'host=<server-address> port=${port ?? '<port>'} dbname=${connection?.database ?? 'postgres'} user=${connection?.user ?? 'postgres'} password=<password>'`,
    `  PUBLICATION ${publication.name};`,
  ].join('\n');

  return (
    <Modal onClose={onClose} width="680px">
      <ModalHeader eyebrow={publication.name} title="Connect a subscriber" description="Postgres streams the changes over a replication connection the subscriber opens. This database does not push them anywhere itself." />
      <ModalBody className="space-y-4 text-[12px]">
        <ol className="list-decimal space-y-1.5 pl-5" style={{ color: 'var(--text-dim)' }}>
          <li>The subscriber needs a network path to Postgres. {port ? <>It is published on port <span className="mono">{port}</span> of this server.</> : <>Postgres is not published outside the project network yet: open a port under <Link href={projectPath('/settings#database-access')} className="underline" style={{ color: 'var(--accent)' }}>Settings › Database access</Link>.</>}</li>
          <li>It signs in as a role allowed to replicate. The password is on the <Link href={projectPath('/connect')} className="underline" style={{ color: 'var(--accent)' }}>Connect</Link> page.</li>
          <li>It names this publication. From then on Postgres keeps a replication slot for it and sends every committed change it covers.</li>
        </ol>
        <CodeBlock value={sql} language="sql" label="subscriber" wrap />
        <p style={{ color: 'var(--text-mute)' }}>
          Debezium, Airbyte or a warehouse loader takes the same three things: host and port, the role, and{' '}
          <span className="mono">publication.name = {publication.name}</span>. Dropping the subscription on the subscriber
          also drops its slot here; a slot left behind keeps WAL on this disk until it is dropped.
        </p>
      </ModalBody>
      <ModalFooter>
        <button className="btn btn-primary" onClick={onClose}>Done</button>
      </ModalFooter>
    </Modal>
  );
}

/** Which tables of the selected schema a publication includes, one switch each. */
function PublicationTablesModal({ publication, schema, saving, onToggle, onClose }: {
  publication: Publication;
  schema: string;
  saving: boolean;
  onToggle: (table: string, include: boolean) => void;
  onClose: () => void;
}) {
  const tablesQuery = useTableStats(schema);
  const included = new Set(publication.tables.filter(t => t.schema === schema).map(t => t.table));

  return (
    <Modal onClose={onClose}>
      <ModalHeader eyebrow={schema} title={`Tables in ${publication.name}`} />
      <ModalBody>
        <QueryState query={tablesQuery} empty={<EmptyState title={`No tables in ${schema}`} />}>
          {tables => (
            <div>
              {/* Views cannot be published. */}
              {tables.filter(t => t.kind === 'table' || t.kind === 'partitioned').map(table => (
                <div key={table.name} className="flex items-center justify-between border-t hairline py-2.5 first:border-t-0">
                  <span className="mono text-[12.5px]">{table.name}</span>
                  <Toggle checked={included.has(table.name)} disabled={saving} onChange={include => onToggle(table.name, include)} ariaLabel={`Publish ${table.name}`} />
                </div>
              ))}
            </div>
          )}
        </QueryState>
      </ModalBody>
      <ModalFooter>
        <button className="btn btn-primary" onClick={onClose}>Done</button>
      </ModalFooter>
    </Modal>
  );
}

/** Database > Publications: logical-replication feeds for external subscribers. */
export default function Publications() {
  const { schema } = useSchema();
  const overviewQuery = usePublications();
  const configQuery = usePostgresConfig();
  const [creating, setCreating] = useState(false);
  const [tablesOf, setTablesOf] = useState<string | null>(null);
  const [subscribingTo, setSubscribingTo] = useState<string | null>(null);

  const create = useCatalogWrite({
    run: (body: NewPublication) => catalogApi.createPublication(body),
    invalidate: 'schema.changed',
    success: body => `Created ${body.name}`,
    failTitle: 'Create failed',
    onSuccess: () => setCreating(false),
  });
  const update = useCatalogWrite({
    run: ({ name, body }: { name: string; body: PublicationUpdate }) => catalogApi.updatePublication(name, body),
    invalidate: 'schema.changed',
    success: ({ name }) => `Updated ${name}`,
    failTitle: 'Update failed',
  });
  const drop = useCatalogWrite({
    run: (publication: Publication) => catalogApi.dropPublication(publication.name),
    invalidate: 'schema.changed',
    success: publication => `Dropped ${publication.name}`,
    failTitle: 'Drop failed',
  });

  const edit = async (publication: Publication, body: PublicationUpdate) => {
    if (await confirmRealtimeEdit(publication)) update.mutate({ name: publication.name, body });
  };
  const confirmDrop = async (publication: Publication) => {
    const ok = await confirmDialog({
      title: `Drop publication "${publication.name}"?`,
      description: 'Subscribers reading it stop receiving changes, and their replication slot keeps WAL until it is dropped too.',
      confirmLabel: 'Drop publication',
      tone: 'danger',
    });
    if (ok && (await confirmRealtimeEdit(publication))) drop.mutate(publication);
  };

  const shown = overviewQuery.data?.publications.find(p => p.name === tablesOf);
  const subscribing = overviewQuery.data?.publications.find(p => p.name === subscribingTo);

  return (
    <PageShell width="wide">
      <PageHeader
        title="Publications"
        subtitle="Choose which row changes another system may read from this database: a replica, a warehouse, Debezium."
        actions={
          <>
            <SchemaSelect />
            <WriteButton className="btn btn-primary" onClick={() => setCreating(true)}>
              <Plus size={12} /> New publication
            </WriteButton>
          </>
        }
      />

      <Note>
        A publication is a list: these tables, these kinds of change. It sends nothing by itself. A subscriber (another
        Postgres, Debezium, a warehouse loader) connects to this database, names the publication, and from then on receives
        every change it covers as it commits. Each publication's <span className="mono">Connect</span> button shows the command.
        Motherbase Realtime does not read publications: which tables broadcast is chosen under{' '}
        <Link href={projectPath('/realtime')} className="underline" style={{ color: 'var(--accent)' }}>Realtime</Link>.
        Nothing on this page can turn Realtime on or off.
      </Note>

      {overviewQuery.data && overviewQuery.data.walLevel !== 'logical' && (
        <div className="card flex items-start gap-3 p-4 text-[12px]" style={{ color: 'var(--amber)' }}>
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            <span className="mono">wal_level</span> is <span className="mono">{overviewQuery.data.walLevel}</span>. Publications can be
            defined, but stream nothing until Postgres runs with <span className="mono">wal_level = logical</span>, which needs a restart.
          </span>
        </div>
      )}

      <QueryState
        query={overviewQuery}
        isEmpty={overview => overview.publications.length === 0}
        empty={<div className="card"><EmptyState size="md" mascot="plug-cable" title="No publications" description="Create one when an external subscriber needs this database's changes." /></div>}
      >
        {overview => (
          <div className="grid gap-3">
            {overview.publications.map(publication => (
              <Section
                key={publication.name}
                title={
                  <span className="flex items-center gap-2">
                    <span className="mono">{publication.name}</span>
                    {publication.supabaseRealtime && <Badge tone="warn">from Supabase import</Badge>}
                  </span>
                }
                description={
                  publication.allTables
                    ? 'Every table, including ones created later.'
                    : publication.tables.length
                      ? publication.tables.map(t => `${t.schema}.${t.table}`).join(', ')
                      : 'No tables yet.'
                }
                actions={
                  <>
                    <button className="btn btn-ghost" onClick={() => setSubscribingTo(publication.name)}>
                      <Plug size={12} /> Connect
                    </button>
                    {!publication.allTables && (
                      <WriteButton className="btn btn-ghost" onClick={() => setTablesOf(publication.name)}>
                        <Table2 size={12} /> Tables · {publication.tables.length}
                      </WriteButton>
                    )}
                    <WriteButton className="btn btn-ghost" style={{ color: 'var(--danger)' }} title="Drop publication" onClick={() => confirmDrop(publication)}>
                      <Trash2 size={12} />
                    </WriteButton>
                  </>
                }
              >
                <div className="flex flex-wrap gap-6">
                  {ACTIONS.map(action => (
                    <label key={action} className="flex items-center gap-2 text-[12px]">
                      <Toggle
                        checked={publication[action]}
                        disabled={update.isPending}
                        onChange={value => edit(publication, { [action]: value })}
                        ariaLabel={`Publish ${action}`}
                      />
                      {action}
                    </label>
                  ))}
                </div>
              </Section>
            ))}
          </div>
        )}
      </QueryState>

      {creating && <NewPublicationModal schema={schema} saving={create.isPending} onSave={body => create.mutate(body)} onClose={() => setCreating(false)} />}
      {subscribing && <SubscribeModal publication={subscribing} connection={configQuery.data?.connection} onClose={() => setSubscribingTo(null)} />}
      {shown && (
        <PublicationTablesModal
          publication={shown}
          schema={schema}
          saving={update.isPending}
          onToggle={(table, include) => edit(shown, include ? { addTables: [{ schema, table }] } : { dropTables: [{ schema, table }] })}
          onClose={() => setTablesOf(null)}
        />
      )}
    </PageShell>
  );
}
