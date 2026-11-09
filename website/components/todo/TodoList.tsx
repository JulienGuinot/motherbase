'use client'

import { useState } from 'react'
import Mascot from '../Mascot'
import type { Todo } from './types'
import styles from './todo.module.css'

interface TodoListProps {
  todos: Todo[]
  disabled: boolean
  onAdd: (title: string) => void
  onToggle: (todo: Todo) => void
  onRemove: (id: string) => void
}

/** Pure presentation: renders the add-form and list, holds no session/SDK state. */
export function TodoList({ todos, disabled, onAdd, onToggle, onRemove }: TodoListProps) {
  const [input, setInput] = useState('')

  function submit() {
    const title = input.trim()
    if (!title) return
    setInput('')
    onAdd(title)
  }

  return (
    <>
      <div className={styles.addRow}>
        <div className={styles.row}>
          <input
            className={styles.input}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && submit()}
            placeholder={disabled ? 'Sign in to add todos' : 'Add a todo…'}
            disabled={disabled}
          />
          <button className={`${styles.button} ${styles.buttonPrimary}`} onClick={submit} disabled={disabled}>
            Add
          </button>
        </div>
      </div>

      {disabled ? (
        <div className='flex flex-col items-center mt-10'>
          <Mascot name="shield-keylock" size={70} />

          <p className={styles.authPrompt}>
            Sign in above to view and manage your todos.
          </p>
        </div>
      ) : todos.length === 0 ? (

        <div className='flex flex-col items-center mt-10'>
          <Mascot name="drinking-coffee" size={70} />

          <p className={styles.authPrompt}>
            No todos yet, add one above.
          </p>
        </div>
       
      ) : (
        <>
        <ul className={styles.list}>
          {todos.map(todo => (
            <li key={todo.id} className={styles.item}>
              <button
                className={`${styles.checkbox} ${todo.done ? styles.checkboxChecked : ''}`}
                onClick={() => onToggle(todo)}
                aria-label={todo.done ? `Mark ${todo.title} as incomplete` : `Mark ${todo.title} as complete`}
              />
              <span className={`${styles.itemTitle} ${todo.done ? styles.itemTitleDone : ''}`}>{todo.title}</span>
              <button className={styles.deleteButton} onClick={() => onRemove(todo.id)} aria-label={`Delete ${todo.title}`}>
                ×
              </button>
            </li>
          ))}
        </ul>

        <div className={styles.footer}>
        <span>
          {todos.length} {todos.length === 1 ? 'item' : 'items'}
        </span>
      </div>
      </>
      )}

      
    </>
  )
}
