'use client'

import { useState } from 'react'
import CustomFigure from './CustomFigure'
import styles from './UseCaseRack.module.css'

type UseCase = { step: string; desc: string }

/** The use cases as a list beside the VPS rack: the row in focus slides its project's unit out. */
export default function UseCaseRack({ items }: { items: UseCase[] }) {
  const [active, setActive] = useState(0)

  return (
    <div className={styles.wrap}>
      <ol className={styles.list}>
        {items.map(({ step, desc }, i) => (
          <li key={step}>
            <button
              type="button"
              className={styles.row}
              aria-pressed={active === i}
              onPointerEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
              onClick={() => setActive(i)}
            >
              <span className={styles.index}>{String(i + 1).padStart(2, '0')}</span>
              <span>
                <span className={styles.title}>{step}</span>
                <span className={styles.desc}>{desc}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>

      <div className={`${styles.figure} hairline-themed`}>
        <CustomFigure
          name="rack"
          value={active}
          label="One VPS as a server rack with one unit per project; the selected project's unit slides out"
        />
      </div>
    </div>
  )
}
