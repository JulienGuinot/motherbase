'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Check } from 'lucide-react';
import { logsApi } from '@/features/logs/api/logs.api';
import { sqlApi } from '@/features/sql/api/sql.api';
import { getErrorMessage } from '@/shared/lib/errors';
import { useToast } from '@/shared/lib/toast';
import { CodeBlock } from '@/shared/ui/CodeBlock';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/shared/ui/Modal';
import { QueryState } from '@/shared/ui/QueryState';
import { WriteButton } from '@/shared/ui/WriteButton';
import type { IndexAdvice } from '@/features/logs/types';

const cost = (value: number | null) => (value == null ? '-' : value.toLocaleString(undefined, { maximumFractionDigits: 2 }));

function AdviceView({ advice, onCreate, creating }: { advice: IndexAdvice; onCreate: () => void; creating: boolean }) {
  if (advice.errors.length) {
    return (
      <div className="flex items-start gap-2 text-[12px]" style={{ color: 'var(--red)' }}>
        <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
        <span>The advisor could not plan this query: {advice.errors.join('; ')}</span>
      </div>
    );
  }
  if (!advice.indexStatements.length) {
    return (
      <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--green)' }}>
        <Check size={14} /> No index would make this query cheaper. It already uses the indexes it can.
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        {[
          ['Total cost now', cost(advice.totalCostBefore)],
          ['With the index', cost(advice.totalCostAfter)],
          ['Cheaper by', advice.improvementPct == null ? '-' : `${advice.improvementPct}%`],
        ].map(([label, value]) => (
          <div key={label} className="border hairline p-3" style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}>
            <div className="tabular-nums text-[18px]" style={{ fontWeight: 600 }}>{value}</div>
            <div className="label mt-1">{label}</div>
          </div>
        ))}
      </div>
      <CodeBlock value={advice.indexStatements.map(s => `${s};`).join('\n')} label="Suggested" language="sql" size="sm" />
      <p className="text-[11px]" style={{ color: 'var(--text-mute)' }}>
        Costs are the planner&apos;s estimate, measured over hypothetical indexes: nothing was built. Creating an index
        takes a lock that blocks writes to the table while it builds; on a large, busy table prefer running{' '}
        <span className="mono">CREATE INDEX CONCURRENTLY</span> from the SQL editor.
      </p>
      <div className="flex justify-end">
        <WriteButton className="btn btn-primary" onClick={onCreate} disabled={creating}>
          {creating ? 'Creating…' : advice.indexStatements.length === 1 ? 'Create index' : 'Create indexes'}
        </WriteButton>
      </div>
    </div>
  );
}

/**
 * Supabase's "Index advisor" for one query: what index would help it, and by
 * how much, from Supabase's own index_advisor running on hypopg.
 */
export function IndexAdvisorModal({ query, onClose }: { query: string; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const statusQ = useQuery({ queryKey: ['index-advisor-status'], queryFn: logsApi.indexAdvisorStatus });
  const installed = statusQ.data?.installed ?? false;
  // A POST, but a read: the query is only planned. Cached per query text so
  // reopening the same row does not plan it again.
  const adviceQ = useQuery({
    queryKey: ['index-advice', query],
    queryFn: () => logsApi.adviseIndexes(query),
    enabled: installed,
  });

  const enable = useMutation({
    mutationFn: logsApi.enableIndexAdvisor,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['index-advisor-status'] }),
    onError: e => toast.push({ kind: 'error', title: 'Could not enable the index advisor', message: getErrorMessage(e) }),
  });

  const create = useMutation({
    mutationFn: (statements: string[]) => sqlApi.run(statements.map(s => `${s};`).join('\n')),
    onSuccess: () => {
      toast.push({ kind: 'success', title: 'Index created' });
      void qc.invalidateQueries({ queryKey: ['index-advice'] });
      void qc.invalidateQueries({ queryKey: ['performance'] });
      void qc.invalidateQueries({ queryKey: ['shield'] });
    },
    onError: e => toast.push({ kind: 'error', title: 'Could not create the index', message: getErrorMessage(e) }),
  });

  return (
    <Modal onClose={onClose} width="680px">
      <ModalHeader title="Index advisor" description="Indexes that would lower this query's planned cost." />
      <ModalBody className="space-y-4">
        <CodeBlock value={query} label="Query" language="sql" size="sm" maxHeight={160} />
        <QueryState query={statusQ} errorTitle="Could not check the index advisor">
          {status =>
            !status.available ? (
              <div className="flex items-start gap-2 text-[12px]" style={{ color: 'var(--text-mute)' }}>
                <AlertCircle size={14} style={{ color: 'var(--amber)', flexShrink: 0, marginTop: 1 }} />
                <span>{status.hint}</span>
              </div>
            ) : !status.installed ? (
              <div className="space-y-2 text-[12px]" style={{ color: 'var(--text-mute)' }}>
                <p>The index advisor runs on the hypopg and index_advisor extensions, which are not enabled yet.</p>
                <WriteButton className="btn btn-primary" onClick={() => enable.mutate()} disabled={enable.isPending}>
                  {enable.isPending ? 'Enabling…' : 'Enable index advisor'}
                </WriteButton>
              </div>
            ) : (
              <QueryState query={adviceQ} errorTitle="Could not get advice for this query">
                {advice => (
                  <AdviceView advice={advice} creating={create.isPending} onCreate={() => create.mutate(advice.indexStatements)} />
                )}
              </QueryState>
            )
          }
        </QueryState>
      </ModalBody>
      <ModalFooter>
        <button onClick={onClose} className="btn">
          Close
        </button>
      </ModalFooter>
    </Modal>
  );
}
