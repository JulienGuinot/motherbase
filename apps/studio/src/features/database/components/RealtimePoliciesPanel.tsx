'use client';

import { useState } from 'react';
import { Lock, Plus, Trash2 } from 'lucide-react';
import Select from '@/shared/ui/Select';
import { Field } from '@/shared/ui/Field';
import { EmptyState } from '@/shared/ui/EmptyState';
import { CodeBlock } from '@/shared/ui/CodeBlock';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';
import { useRealtimePolicies } from '@/features/database/hooks/useRealtime';
import {
  REALTIME_POLICY_TEMPLATES,
  normalizeRealtimeDraft,
  realtimePolicySql,
  topicCondition,
  type RealtimePolicyCommand,
  type RealtimePolicyDraft,
} from '@/features/database/lib/realtime-policies';
import { SkeletonList } from '@/shared/ui/Skeleton';

const COMMANDS: RealtimePolicyCommand[] = ['SELECT', 'INSERT', 'ALL'];
const COMMAND_HINT: Record<RealtimePolicyCommand, string> = {
  SELECT: 'Receive: join the channel and get broadcast or presence messages.',
  INSERT: 'Send: broadcast messages or track presence.',
  ALL: 'Both receive and send.',
};

const EMPTY_DRAFT: RealtimePolicyDraft = { name: '', command: 'SELECT', role: 'authenticated', using: '', check: '' };

/** AND a topic restriction into an expression, leaving an empty one as just the topic. */
function scoped(expression: string | undefined, topic: string): string {
  const condition = topicCondition(topic);
  return expression?.trim() ? `${condition} AND (${expression.trim()})` : condition;
}

/**
 * Realtime Authorization, the Supabase "Policies" tab of the Realtime page:
 * who may join private channels (`config: { private: true }`) and what they
 * may do there. Public channels are not affected by any of these.
 */
export function RealtimePoliciesPanel() {
  const { list, create, drop } = useRealtimePolicies();
  const [draft, setDraft] = useState<RealtimePolicyDraft>(EMPTY_DRAFT);
  const [topic, setTopic] = useState('');

  const policies = list.data ?? [];
  const final = normalizeRealtimeDraft(
    topic.trim()
      ? { ...draft, using: scoped(draft.using, topic.trim()), check: scoped(draft.check, topic.trim()) }
      : draft
  );

  const submit = () =>
    create.mutate(final, {
      onSuccess: () => {
        setDraft(EMPTY_DRAFT);
        setTopic('');
      },
    });

  const confirmDrop = async (name: string) => {
    const confirmed = await confirmDialog({
      title: `Delete policy "${name}"?`,
      description: 'Clients relying on it are refused the next time they join a private channel.',
      confirmLabel: 'Delete policy',
      tone: 'danger',
    });
    if (confirmed) drop.mutate(name);
  };

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <section className="card min-w-0 overflow-hidden">
        <header className="flex items-center justify-between border-b hairline px-4 py-3">
          <div>
            <h3 className="text-[13px]" style={{ fontWeight: 600 }}>Policies on realtime.messages</h3>
            <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-mute)' }}>
              Checked when a client joins a private channel. With no policy, every private join is refused.
            </p>
          </div>
          <span className="label">{policies.length} {policies.length === 1 ? 'policy' : 'policies'}</span>
        </header>
        {list.isLoading ? (
          <SkeletonList rows={3} height={48} className="p-4" />
        ) : policies.length === 0 ? (
          <EmptyState
            mascot="shield-keylock"
            title="No realtime policies yet"
            description={<>Private channels are closed until a policy opens them. Start from a template on the right.</>}
          />
        ) : (
          <ul className="divide-y divide-[var(--hairline)]">
            {policies.map(policy => (
              <li key={policy.name} className="row-host flex items-center gap-3 px-4 py-2.5">
                <span className="chip mono w-[64px] justify-center text-[10px]">{policy.command}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px]">{policy.name}</span>
                    {policy.roles.map(role => <span key={role} className="chip" style={{ fontSize: 9 }}>{role}</span>)}
                  </div>
                  {(policy.using || policy.withCheck) && (
                    <code className="mono mt-0.5 block truncate text-[11px]" style={{ color: 'var(--paper-mute)' }}>
                      {policy.using ? `USING (${policy.using})` : ''}
                      {policy.using && policy.withCheck ? '  ·  ' : ''}
                      {policy.withCheck ? `CHECK (${policy.withCheck})` : ''}
                    </code>
                  )}
                </div>
                <button
                  className="btn btn-ghost row-actions"
                  style={{ color: 'var(--danger)' }}
                  onClick={() => confirmDrop(policy.name)}
                  aria-label={`Delete ${policy.name}`}
                >
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card space-y-3 p-4">
        <h3 className="flex items-center gap-2 text-[13px]" style={{ fontWeight: 600 }}><Lock size={13} /> New policy</h3>
        <div className="flex flex-wrap gap-2">
          {REALTIME_POLICY_TEMPLATES.map(template => (
            <button key={template.id} className="chip" title={template.description} onClick={() => setDraft({ ...EMPTY_DRAFT, ...template.draft })}>
              {template.label}
            </button>
          ))}
        </div>
        <Field label="Policy name">
          <input className="input mono w-full" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} />
        </Field>
        <div className="flex gap-2">
          <label className="flex-1">
            <span className="label mb-1 block">Command</span>
            <Select
              value={draft.command}
              onChange={value => setDraft({ ...draft, command: value as RealtimePolicyCommand })}
              ariaLabel="Command"
              style={{ width: '100%' }}
              options={COMMANDS.map(command => ({ value: command, label: command }))}
            />
          </label>
          <label className="flex-1">
            <span className="label mb-1 block">Role</span>
            <Select
              value={draft.role}
              onChange={value => setDraft({ ...draft, role: value as RealtimePolicyDraft['role'] })}
              ariaLabel="Role"
              style={{ width: '100%' }}
              options={[{ value: 'authenticated', label: 'authenticated' }, { value: 'anon', label: 'anon' }]}
            />
          </label>
        </div>
        <p className="text-[11px]" style={{ color: 'var(--text-mute)' }}>{COMMAND_HINT[draft.command]}</p>
        <Field label="Limit to topic" hint="Optional. Exact name, or a prefix ending in *, e.g. room:*">
          <input className="input mono w-full" value={topic} placeholder="room:*" onChange={e => setTopic(e.target.value)} />
        </Field>
        {draft.command !== 'INSERT' && (
          <Field label="USING">
            <textarea className="input mono w-full" rows={2} value={draft.using} onChange={e => setDraft({ ...draft, using: e.target.value })} />
          </Field>
        )}
        {draft.command !== 'SELECT' && (
          <Field label="WITH CHECK">
            <textarea className="input mono w-full" rows={2} value={draft.check} onChange={e => setDraft({ ...draft, check: e.target.value })} />
          </Field>
        )}
        <CodeBlock value={realtimePolicySql(final)} label="SQL" maxHeight={180} wrap />
        <button className="btn btn-primary w-full justify-center" disabled={!final.name || create.isPending} onClick={submit}>
          <Plus size={13} /> {create.isPending ? 'Creating…' : 'Create policy'}
        </button>
      </section>
    </div>
  );
}
