import { highlightCode } from '@/lib/code-theme'
import SdkTabsClient from './SdkTabsClient'
import { CLIENT_PACKAGE } from '@/lib/site'

const PKG = CLIENT_PACKAGE

const TAB_DEFS = [
  {
    label: 'REST',
    lang: 'typescript',
    code: `import { createClient } from '${PKG}'

const client = createClient('https://your-project.example.com')

// Fetch todos
const { data: todos } = await client
  .from('todo')
  .select('*')
  .order('created_at', { ascending: false })

// Create a todo
await client.from('todo').insert({ title: 'Buy milk' })

// Or use Prisma-style methods for the same table and RLS:
const openTodos = await client.db.todo.findMany({
  where: { done: false },
  orderBy: { created_at: 'desc' },
  take: 20,
})
// Prisma-style methods return rows directly and throw on error.`,
  },
  {
    label: 'Realtime',
    lang: 'typescript',
    code: `const channel = client
  .channel('room-todo')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'todo' }, (payload) => {
    console.log(payload.eventType, payload.new, payload.old)
  })
  .subscribe()

// when you are done listening
await client.removeChannel(channel)`,
  },
  {
    label: 'Auth',
    lang: 'typescript',
    code: `const { data, error } = await client.auth.signIn.email({
  email: 'user@example.com',
  password: 'your-password',
})

const { data: current } = await client.auth.getSession()
// current: { session, user } or null`,
  },
]

export default async function SdkTabs({ children }: { children: React.ReactNode }) {
  const tabs = await Promise.all(
    TAB_DEFS.map(async (t) => ({
      label: t.label,
      code: t.code,
      html: await highlightCode(t.code, t.lang),
    }))
  )
  return <SdkTabsClient tabs={tabs}>{children}</SdkTabsClient>
}
