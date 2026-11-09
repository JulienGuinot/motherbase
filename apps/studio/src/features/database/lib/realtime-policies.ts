// Realtime Authorization policies: pure helpers, no React, unit-tested.
//
// A private channel is authorized by the RLS policies on `realtime.messages`:
// SELECT decides who may receive, INSERT who may send (broadcast) or track
// (presence). Policies read the channel being joined with `realtime.topic()`
// and the feature with the `extension` column.

export type RealtimePolicyCommand = 'SELECT' | 'INSERT' | 'ALL';

/** Mirrors `realtimePolicySchema` in admin-security.controller. */
export interface RealtimePolicyDraft {
  name: string;
  command: RealtimePolicyCommand;
  role: 'anon' | 'authenticated';
  using?: string;
  check?: string;
}

export interface RealtimePolicyTemplate {
  id: string;
  label: string;
  description: string;
  draft: RealtimePolicyDraft;
}

/** The expression that restricts a policy to one topic, or to topics sharing a prefix. */
export function topicCondition(topic: string): string {
  const quoted = topic.replace(/'/g, "''");
  return topic.endsWith('*')
    ? `realtime.topic() LIKE '${quoted.slice(0, -1)}%'`
    : `realtime.topic() = '${quoted}'`;
}

/** The same starting points Supabase's Realtime Policies screen offers. */
export const REALTIME_POLICY_TEMPLATES: RealtimePolicyTemplate[] = [
  {
    id: 'listen-broadcast',
    label: 'Receive broadcasts (signed in)',
    description: 'Signed-in users may join private channels and receive broadcast messages.',
    draft: { name: 'authenticated can receive broadcasts', command: 'SELECT', role: 'authenticated', using: "extension = 'broadcast'" },
  },
  {
    id: 'send-broadcast',
    label: 'Send broadcasts (signed in)',
    description: 'Signed-in users may send broadcast messages on private channels.',
    draft: { name: 'authenticated can send broadcasts', command: 'INSERT', role: 'authenticated', check: "extension = 'broadcast'" },
  },
  {
    id: 'listen-presence',
    label: 'See presence (signed in)',
    description: 'Signed-in users may join private channels and receive presence state.',
    draft: { name: 'authenticated can see presence', command: 'SELECT', role: 'authenticated', using: "extension = 'presence'" },
  },
  {
    id: 'track-presence',
    label: 'Track presence (signed in)',
    description: 'Signed-in users may announce their own presence on private channels.',
    draft: { name: 'authenticated can track presence', command: 'INSERT', role: 'authenticated', check: "extension = 'presence'" },
  },
  {
    id: 'own-topic',
    label: "A user's own topic",
    description: 'Each signed-in user may use only the private channel named after their id, e.g. user:<id>.',
    draft: {
      name: 'users use their own topic',
      command: 'ALL',
      role: 'authenticated',
      using: "realtime.topic() = 'user:' || auth.uid()",
      check: "realtime.topic() = 'user:' || auth.uid()",
    },
  },
];

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** What the server will run for a draft: shown under the form so nothing is a surprise. */
export function realtimePolicySql(draft: RealtimePolicyDraft): string {
  const lines = [
    `CREATE POLICY ${quoteIdent(draft.name)} ON realtime.messages`,
    `  FOR ${draft.command}`,
    `  TO ${draft.role}`,
  ];
  const using = draft.using?.trim();
  const check = draft.check?.trim();
  if (using && draft.command !== 'INSERT') lines.push(`  USING ( ${using} )`);
  if (check && draft.command !== 'SELECT') lines.push(`  WITH CHECK ( ${check} )`);
  return lines.join('\n') + ';';
}

/**
 * The draft as it should be sent: USING means nothing on INSERT and WITH CHECK
 * nothing on SELECT, and Postgres refuses the policy outright if they are there.
 */
export function normalizeRealtimeDraft(draft: RealtimePolicyDraft): RealtimePolicyDraft {
  return {
    name: draft.name.trim(),
    command: draft.command,
    role: draft.role,
    using: draft.command !== 'INSERT' && draft.using?.trim() ? draft.using.trim() : undefined,
    check: draft.command !== 'SELECT' && draft.check?.trim() ? draft.check.trim() : undefined,
  };
}
