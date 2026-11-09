import { highlightCode } from '@/lib/code-theme'
import { DemoLayout } from './todo/DemoLayout'

const TAB_DEFS = [
  {
    label: 'Provider',
    lang: 'tsx',
    code: `'use client'
import { MotherbaseProvider } from '@motherbase/ui'
import { getBrowserClient } from '@/lib/motherbase/browser'

// One provider at the root: every component below reads the session from context.
export function Providers({ children }) {
  return <MotherbaseProvider client={getBrowserClient()}>{children}</MotherbaseProvider>
}

// Anywhere below — no props to pass down:
const user = useUser()`,
  },
  {
    label: 'Hook',
    lang: 'typescript',
    code: `import { useAuth } from '@motherbase/ui'

export function useTodos() {
  const { client, user } = useAuth()
  const [todos, setTodos] = useState<Todo[]>([])

  useEffect(() => {
    client.from<Todo>('todo').select('*').order('created_at', { ascending: false })
      .then(({ data }) => setTodos(data ?? []))
  }, [client, user?.id])

  const add = (title: string) => client.from<Todo>('todo').insert({ title, done: false })
  // ...toggle, remove, realtime: see Realtime tab
  return { todos, add }
}`,
  },
  {
    label: 'Auth',
    lang: 'typescript',
    code: `import { useAuth } from '@motherbase/ui'

const { client, user, signOut } = useAuth() // user is null when signed out

await client.auth.signUp.email({ email, password, name: email })
await client.auth.signIn.email({ email, password })
// The provider listens to onAuthStateChange: \`user\` updates on its own.

await signOut()`,
  },
  {
    label: 'Realtime',
    lang: 'typescript',
    code: `const channel = client
  .channel('room-todo')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'todo' }, (payload) => {
    if (payload.eventType === 'INSERT') setTodos(prev => [payload.new, ...prev])
    if (payload.eventType === 'UPDATE') setTodos(prev => prev.map(t => t.id === payload.new.id ? payload.new : t))
    if (payload.eventType === 'DELETE') setTodos(prev => prev.filter(t => t.id !== payload.old.id))
  })
  .subscribe()

// Later:
await client.removeChannel(channel)`,
  },
  {
    label: 'Middleware',
    lang: 'typescript',
    code: `// middleware.ts
import { updateSession } from '@motherbase/ssr'

export async function middleware(request) {
  // Revalidates the session against the backend and refreshes the
  // cookie on every navigation — Server Components never read a stale token.
  return updateSession(request, process.env.NEXT_PUBLIC_MOTHERBASE_URL!)
}

// runtime: 'nodejs' is required: the SDK's realtime module pulls in
// socket.io-client, which isn't Edge-runtime-safe.
export const config = {
  runtime: 'nodejs',
  matcher: ['/example/:path*'],
}`,
  },
]

export default async function TodoDemo() {
  const codeTabs = await Promise.all(
    TAB_DEFS.map(async t => ({
      label: t.label,
      code: t.code,
      html: await highlightCode(t.code, t.lang),
    })),
  )
  return <DemoLayout codeTabs={codeTabs} />
}
