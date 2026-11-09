'use client'

import { useUser } from '@motherbase/ui'
import { AuthPanel } from './AuthPanel'
import { TodoList } from './TodoList'
import { useTodos } from './useTodos'
import styles from './todo.module.css'

/** Demo shell: session from `@motherbase/ui`, todo state and sync from `useTodos`. */
export function TodoApp() {
  const user = useUser()
  const { todos, error, add, toggle, remove } = useTodos()

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className="label">Todo App</span>
      </div>

      <AuthPanel />

      <TodoList todos={todos} disabled={!user} onAdd={add} onToggle={toggle} onRemove={remove} />

      {error && <p className={styles.appError}>{error}</p>}
    </div>
  )
}
