'use client';

import { Copy, Play, ShieldCheck } from 'lucide-react';
import JsonView from '@/shared/ui/JsonView';
import { useCopy } from '@/shared/hooks/useCopy';
import { RlsStateBadge } from '@/features/database/components/rls/RlsStateBadge';
import { METHOD_COLOR, type Endpoint } from '@/features/api-tools/lib/endpoints';
import type { RlsTable } from '@/features/database/lib/rls-api';
import { CodeBlock, CodeText } from '@/shared/ui/CodeBlock';

function ResponseBody({ value, failed }: { value: unknown; failed: boolean }) {
  if (value == null || value === '') {
    return <CodeText value="// Send a request to see the response." style={{ color: 'var(--text-mute)' }} />;
  }
  if (failed) {
    return (
      <CodeBlock
        value={value}
        label="Error response"
        tone="danger"
        maxHeight={360}
        wrap
      />
    );
  }
  return <JsonView value={value} />;
}

/** The selected route: editable path, optional JSON body, and the response. */
export function RequestPanel({
  endpoint,
  path,
  onPathChange,
  body,
  onBodyChange,
  onSend,
  sending,
  status,
  failed,
  response,
  rlsTable,
  onManageRls,
}: {
  endpoint: Endpoint;
  path: string;
  onPathChange: (value: string) => void;
  body: string;
  onBodyChange: (value: string) => void;
  onSend: () => void;
  sending: boolean;
  status?: number;
  failed: boolean;
  response: unknown;
  rlsTable?: RlsTable;
  onManageRls: () => void;
}) {
  const copy = useCopy();
  const hasBody = endpoint.method === 'POST' || endpoint.method === 'PATCH';

  return (
    <section className="flex min-h-[420px] flex-1 flex-col overflow-hidden md:min-h-0">
      <div className="border-b px-3 py-3 hairline sm:px-5 sm:py-4 sm:pt-5">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <span
            className="mono px-2 py-1 text-[11px] font-semibold"
            style={{ background: METHOD_COLOR[endpoint.method], color: '#fff', borderRadius: 'var(--radius-sm)' }}
          >
            {endpoint.method}
          </span>
          <input
            value={path}
            onChange={e => onPathChange(e.target.value)}
            className="input mono min-w-[180px] flex-1 text-[12px]"
          />
          <button onClick={onSend} disabled={sending} className="btn btn-primary">
            <Play size={12} /> {sending ? 'Sending…' : 'Send'}
          </button>
        </div>

        <p className="mt-2 text-[12px]" style={{ color: 'var(--text-mute)' }}>
          {endpoint.desc}
        </p>

        {rlsTable && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <RlsStateBadge table={rlsTable} />
            <button onClick={onManageRls} className="btn btn-ghost">
              <ShieldCheck size={12} /> Manage RLS
            </button>
          </div>
        )}
      </div>

      {hasBody && (
        <div className="border-b hairline">
          <div className="label px-5 pt-3">Request body · JSON</div>
          <textarea
            value={body}
            onChange={e => onBodyChange(e.target.value)}
            spellCheck={false}
            className="mono block w-full resize-y bg-transparent px-5 py-3 text-[12px] outline-none"
            style={{ minHeight: 120, color: 'var(--text-dim)' }}
          />
        </div>
      )}

      <div className="flex items-center justify-between border-b hairline px-5 py-2">
        <div className="flex items-center gap-3 text-[11px]" style={{ color: 'var(--text-mute)' }}>
          <span>Response</span>
          {status != null && !failed && (
            <span className="mono" style={{ color: 'var(--green)' }}>
              {status} OK
            </span>
          )}
          {failed && (
            <span className="mono" style={{ color: 'var(--danger)' }}>
              Error
            </span>
          )}
        </div>
        {response != null && response !== '' && (
          <button onClick={() => copy(JSON.stringify(response, null, 2), 'Copied response')} className="btn btn-ghost">
            <Copy size={11} /> Copy
          </button>
        )}
      </div>

      <div className="flex-1 overflow-auto p-5" style={{ background: 'var(--code-bg)' }}>
        <ResponseBody value={response} failed={failed} />
      </div>
    </section>
  );
}
