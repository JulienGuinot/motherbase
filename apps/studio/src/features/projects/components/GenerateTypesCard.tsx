'use client';

import { useState } from 'react';
import { Database, Download, FileCode2 } from 'lucide-react';
import { useSchemas } from '@/shared/hooks/useSchemas';
import { api } from '@/shared/lib/api';
import { useToast } from '@/shared/lib/toast';
import { CodeBlock } from '@/shared/ui/CodeBlock';
import Select from '@/shared/ui/Select';

const TYPES_FILENAME = 'database.types.ts';

/**
 * Downloads the generated TypeScript definitions for one schema. The file comes
 * from the same endpoint and the same emitter the CLI uses, so the download and
 * `motherbase gen types typescript` are byte-identical for a given schema.
 */
export function GenerateTypesCard() {
  const { push } = useToast();
  const [schema, setSchema] = useState('public');
  const [busy, setBusy] = useState(false);

  const schemasQ = useSchemas();
  const schemas = schemasQ.data?.length ? schemasQ.data : ['public'];
  const command = `motherbase gen types typescript --schema ${schema} --output ${TYPES_FILENAME}`;

  async function download() {
    setBusy(true);
    try {
      const { data } = await api.get('/admin/schema/types', { params: { schema } });
      const types = data?.data?.types as string | undefined;
      if (!types) throw new Error('The server returned no types.');

      // Blob download rather than a link to the endpoint: the request needs the
      // bearer token the axios interceptor attaches, which a plain <a href>
      // cannot carry.
      const url = URL.createObjectURL(new Blob([types], { type: 'text/plain;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = TYPES_FILENAME;
      anchor.click();
      URL.revokeObjectURL(url);
      push({ kind: 'success', title: `Downloaded ${TYPES_FILENAME}`, message: `${schema} schema` });
    } catch (error) {
      push({
        kind: 'error',
        title: 'Could not generate types',
        message: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-center gap-3">
        <FileCode2 size={14} style={{ color: 'var(--text-mute)' }} />
        <div>
          <div className="text-[13px]" style={{ fontWeight: 600 }}>Generate types</div>
          <div className="text-[12px]" style={{ color: 'var(--text-mute)' }}>
            Typed rows, inserts and RPC calls for the SDK. Re-run after every schema change.
          </div>
        </div>
        {/* Wraps and shrinks: the schema picker beside a button labelled with
            the whole filename is 274px, which does not fit a 320px phone. */}
        <div className="flex min-w-0 flex-wrap items-center gap-2 sm:ml-auto">
          <Select
            value={schema}
            onChange={setSchema}
            options={schemas.map(s => ({ value: s, label: s }))}
            label="schema"
            ariaLabel="Schema to generate types for"
            leadingIcon={<Database size={12} />}
          />
          <button className="btn btn-primary min-w-0" onClick={download} disabled={busy}>
            <Download size={12} className="shrink-0" />
            <span className="truncate">{busy ? 'Generating...' : `Download ${TYPES_FILENAME}`}</span>
          </button>
        </div>
      </div>

      <CodeBlock value={command} label="CLI" language="bash" size="sm" maxHeight={120} className="mt-3" />
    </div>
  );
}
