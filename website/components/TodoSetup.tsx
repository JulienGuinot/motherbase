import { highlightCode } from '@/lib/code-theme'
import SetupTabsClient from './SetupTabsClient'

const TABS = [
  {
    label: 'table.sql',
    lang: 'sql',
    code: `-- Project Studio → SQL Editor

CREATE TABLE todo (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  done boolean NOT NULL DEFAULT false,
  user_id text NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE todo ENABLE ROW LEVEL SECURITY;

-- Every user can only see, modify, and delete their own rows.
-- No anon policy: signed-out requests match no policy and are blocked.
CREATE POLICY "todo owner access"
ON todo FOR ALL
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);
`,
  },

  {
    label: 'SDK',
    lang: 'typescript',
    code: `import { createClient, cookieStorage } from '@motherbase/client'

const client = createClient(
  process.env.NEXT_PUBLIC_MOTHERBASE_URL!,
  process.env.NEXT_PUBLIC_MOTHERBASE_KEY,
  { storage: cookieStorage() },
)

// Owner-scoped RLS: authenticate to read or write your rows.
await client.auth.signIn.email({ email, password })

const { data: todos } = await client
  .from('todo')
  .select('*')
  .order('created_at', { ascending: false })

await client.from('todo').insert({
  title: 'Buy milk',
  done: false,
})

// Or query the same table with Prisma-style methods:
const openTodos = await client.db.todo.findMany({ where: { done: false } })`,
  },
]

export default async function TodoSetup() {
  const tabs = await Promise.all(
    TABS.map(async (t) => ({
      label: t.label,
      code: t.code,
      html: await highlightCode(t.code, t.lang),
    })),
  )
  return <SetupTabsClient tabs={tabs} />
}
