import { useEffect, useState } from 'react'
import type { PostgresChangePayload } from '@motherbase/client'
import { useAuth } from '@motherbase/ui'
import type { Todo } from './types'

/**
 * Todos of the signed-in user: initial load, optimistic mutations and realtime
 * sync. Idle while signed out — RLS scopes every row to its owner.
 */
export function useTodos() {
  const { client, user } = useAuth()
  const userId = user?.id
  const [todos, setTodos] = useState<Todo[]>([])
  const [error, setError] = useState('')

  const table = () => client.from<Todo>('todo')

  useEffect(() => {
    if (!userId) return setTodos([])
    let cancelled = false
    client
      .from<Todo>('todo')
      .select('*')
      .order('created_at', { ascending: false })
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) setError(error.message)
        else setTodos(data ?? [])
      })
    return () => {
      cancelled = true
    }
  }, [client, userId])

  useEffect(() => {
    if (!userId) return
    const channel = client
      .channel('room-todo')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'todo' }, (payload: PostgresChangePayload) => {
        const row = (payload.eventType === 'DELETE' ? payload.old : payload.new) as unknown as Todo
        setTodos(prev => {
          if (payload.eventType === 'INSERT') return prev.some(t => t.id === row.id) ? prev : [row, ...prev]
          if (payload.eventType === 'UPDATE') return prev.map(t => (t.id === row.id ? row : t))
          return prev.filter(t => t.id !== row.id)
        })
      })
      .subscribe()
    return () => {
      void client.removeChannel(channel)
    }
  }, [client, userId])

  const add = async (title: string) => {
    setError('')
    // .select() asks for the row back: without it the write resolves data: null.
    const { data, error } = await table().insert({ title, done: false }).select()
    if (error) return setError(error.message)
    const created = data?.[0]
    if (created) setTodos(prev => (prev.some(t => t.id === created.id) ? prev : [created, ...prev]))
  }

  const toggle = async (todo: Todo) => {
    setTodos(prev => prev.map(t => (t.id === todo.id ? { ...t, done: !t.done } : t)))
    const { error } = await table().update({ done: !todo.done }).eq('id', todo.id)
    if (error) setTodos(prev => prev.map(t => (t.id === todo.id ? todo : t)))
  }

  const remove = async (id: string) => {
    const snapshot = todos
    setTodos(prev => prev.filter(t => t.id !== id))
    const { error } = await table().delete().eq('id', id)
    if (error) setTodos(snapshot)
  }

  return { todos, error, add, toggle, remove }
}
