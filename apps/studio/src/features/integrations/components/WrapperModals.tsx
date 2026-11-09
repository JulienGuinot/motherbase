'use client';

import { useState } from 'react';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/shared/ui/Modal';
import { Field } from '@/shared/ui/Field';
import Select from '@/shared/ui/Select';
import { WriteButton } from '@/shared/ui/WriteButton';
import type {
  CreateForeignTableInput,
  CreateServerInput,
  ForeignServer,
  ImportSchemaInput,
  WrapperName,
} from '@/features/integrations/api/wrappers.api';

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const isIdentifier = (value: string) => IDENTIFIER_RE.test(value);

/** `id int`, one column per line, into the server's column list. Blank lines are skipped. */
export function parseColumns(text: string): Array<{ name: string; type: string }> | null {
  const columns = text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const at = line.search(/\s/);
      return at < 0 ? { name: line, type: '' } : { name: line.slice(0, at), type: line.slice(at).trim() };
    });
  return columns.length && columns.every(c => isIdentifier(c.name) && c.type) ? columns : null;
}

function Footer({ onClose, onSubmit, disabled, saving, label }: {
  onClose: () => void;
  onSubmit: () => void;
  disabled: boolean;
  saving: boolean;
  label: string;
}) {
  return (
    <ModalFooter>
      <button onClick={onClose} className="btn">
        Cancel
      </button>
      <WriteButton capability="secrets.manage" onClick={onSubmit} className="btn btn-primary" disabled={disabled || saving}>
        {saving ? 'Saving…' : label}
      </WriteButton>
    </ModalFooter>
  );
}

export function CreateServerModal({ wrappers, saving, onClose, onCreate }: {
  wrappers: WrapperName[];
  saving: boolean;
  onClose: () => void;
  onCreate: (input: CreateServerInput) => void;
}) {
  const [name, setName] = useState('');
  const [wrapper, setWrapper] = useState<WrapperName>(wrappers[0] ?? 'postgres_fdw');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('5432');
  const [dbname, setDbname] = useState('postgres');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const remote = wrapper === 'postgres_fdw';
  const complete = isIdentifier(name) && (!remote || Boolean(host && dbname && user && password));

  return (
    <Modal onClose={onClose} width="560px">
      <ModalHeader
        title="Add foreign server"
        description={remote ? 'Another Postgres database, reached as local tables.' : 'Files on the database server, read as tables.'}
      />
      <ModalBody className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Server name" required>
            <input value={name} onChange={e => setName(e.target.value)} className="input mono" placeholder="analytics_db" autoFocus />
          </Field>
          <Field label="Wrapper">
            <Select value={wrapper} onChange={v => setWrapper(v as WrapperName)} options={wrappers.map(w => ({ value: w, label: w }))} />
          </Field>
        </div>
        {remote && (
          <>
            <div className="grid gap-3 sm:grid-cols-[1fr_90px_1fr]">
              <Field label="Host" required>
                <input value={host} onChange={e => setHost(e.target.value)} className="input mono" placeholder="db.example.com" />
              </Field>
              <Field label="Port">
                <input value={port} onChange={e => setPort(e.target.value)} className="input mono" />
              </Field>
              <Field label="Database" required>
                <input value={dbname} onChange={e => setDbname(e.target.value)} className="input mono" />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="User" required>
                <input value={user} onChange={e => setUser(e.target.value)} className="input mono" autoComplete="off" />
              </Field>
              <Field label="Password" required hint="Stored in the Vault as fdw_<server>.">
                <input type="password" value={password} onChange={e => setPassword(e.target.value)} className="input mono" autoComplete="new-password" />
              </Field>
            </div>
          </>
        )}
      </ModalBody>
      <Footer
        onClose={onClose}
        saving={saving}
        disabled={!complete}
        label="Create server"
        onSubmit={() =>
          onCreate(remote ? { name, wrapper, options: { host, port, dbname }, user, password } : { name, wrapper, options: {} })
        }
      />
    </Modal>
  );
}

export function CredentialsModal({ server, saving, onClose, onSave }: {
  server: ForeignServer;
  saving: boolean;
  onClose: () => void;
  onSave: (credentials: { user: string; password: string }) => void;
}) {
  const [user, setUser] = useState(server.remoteUser ?? '');
  const [password, setPassword] = useState('');
  return (
    <Modal onClose={onClose} width="460px">
      <ModalHeader title={`Credentials for ${server.name}`} description="Updates the user mapping and the Vault secret together." />
      <ModalBody className="space-y-4">
        <Field label="User">
          <input value={user} onChange={e => setUser(e.target.value)} className="input mono" autoComplete="off" />
        </Field>
        <Field label="New password">
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} className="input mono" autoComplete="new-password" />
        </Field>
      </ModalBody>
      <Footer onClose={onClose} saving={saving} disabled={!user || !password} label="Save" onSubmit={() => onSave({ user, password })} />
    </Modal>
  );
}

export function ImportSchemaModal({ server, saving, onClose, onImport }: {
  server: ForeignServer;
  saving: boolean;
  onClose: () => void;
  onImport: (input: ImportSchemaInput) => void;
}) {
  const [remoteSchema, setRemoteSchema] = useState('public');
  const [localSchema, setLocalSchema] = useState(server.name);
  const [tables, setTables] = useState('');
  const limitTo = tables.split(',').map(t => t.trim()).filter(Boolean);
  const valid = isIdentifier(remoteSchema) && isIdentifier(localSchema) && limitTo.every(isIdentifier);

  return (
    <Modal onClose={onClose} width="520px">
      <ModalHeader title={`Import from ${server.name}`} description="IMPORT FOREIGN SCHEMA: one local foreign table per remote table." />
      <ModalBody className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Remote schema">
            <input value={remoteSchema} onChange={e => setRemoteSchema(e.target.value)} className="input mono" />
          </Field>
          <Field
            label="Into local schema"
            hint={localSchema === 'public' ? 'Foreign tables cannot have RLS; a separate schema keeps them off the API.' : undefined}
          >
            <input value={localSchema} onChange={e => setLocalSchema(e.target.value)} className="input mono" />
          </Field>
        </div>
        <Field label="Only these tables" hint="Comma-separated. Empty imports every table in the remote schema.">
          <input value={tables} onChange={e => setTables(e.target.value)} className="input mono" placeholder="orders, customers" />
        </Field>
      </ModalBody>
      <Footer
        onClose={onClose}
        saving={saving}
        disabled={!valid}
        label="Import"
        onSubmit={() => onImport({ remoteSchema, localSchema, tables: limitTo.length ? limitTo : undefined })}
      />
    </Modal>
  );
}

export function FileTableModal({ server, saving, onClose, onCreate }: {
  server: ForeignServer;
  saving: boolean;
  onClose: () => void;
  onCreate: (input: CreateForeignTableInput) => void;
}) {
  const [schema, setSchema] = useState(server.name);
  const [name, setName] = useState('');
  const [filename, setFilename] = useState('');
  const [format, setFormat] = useState('csv');
  const [header, setHeader] = useState(true);
  const [columnsText, setColumnsText] = useState('id int\nlabel text');
  const columns = parseColumns(columnsText);
  const valid = isIdentifier(schema) && isIdentifier(name) && filename.startsWith('/') && columns !== null;

  return (
    <Modal onClose={onClose} width="560px">
      <ModalHeader title="Add file table" description={`A file on the database server, read through ${server.name}.`} />
      <ModalBody className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Schema">
            <input value={schema} onChange={e => setSchema(e.target.value)} className="input mono" />
          </Field>
          <Field label="Table name" required>
            <input value={name} onChange={e => setName(e.target.value)} className="input mono" />
          </Field>
        </div>
        <Field label="File path" required hint="Absolute, on the database server's filesystem.">
          <input value={filename} onChange={e => setFilename(e.target.value)} className="input mono" placeholder="/var/lib/postgresql/import/orders.csv" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Format">
            <Select value={format} onChange={setFormat} options={[{ value: 'csv', label: 'CSV' }, { value: 'text', label: 'Text' }]} />
          </Field>
          <Field label="Header row">
            <Select value={header ? 'true' : 'false'} onChange={v => setHeader(v === 'true')} options={[{ value: 'true', label: 'First line is a header' }, { value: 'false', label: 'No header' }]} />
          </Field>
        </div>
        <Field label="Columns" error={columns ? undefined : 'One "name type" per line.'}>
          <textarea value={columnsText} onChange={e => setColumnsText(e.target.value)} rows={4} className="input mono w-full" style={{ fontSize: 12 }} />
        </Field>
      </ModalBody>
      <Footer
        onClose={onClose}
        saving={saving}
        disabled={!valid}
        label="Create table"
        onSubmit={() =>
          columns &&
          onCreate({
            server: server.name,
            schema,
            name,
            columns,
            // `header` is a CSV-only option; file_fdw rejects it on text.
            options: format === 'csv' ? { filename, format, header: String(header) } : { filename, format },
          })
        }
      />
    </Modal>
  );
}
