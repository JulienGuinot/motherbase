'use client'

import { useState } from 'react'
import CustomFigure from './CustomFigure'
import styles from './SprawlCompare.module.css'

/** Copied stacks against one Motherbase rack, for as many projects as the slider says. */
export default function SprawlCompare() {
  const [projects, setProjects] = useState(3)

  return (
    <figure className={styles.figure}>
      <div className={styles.heads} aria-hidden>
        <span>Self-hosted Supabase</span>
        <span className={styles.accent}>Motherbase</span>
      </div>

      <div className="hairline-themed">
        <CustomFigure
          name="sprawl"
          value={projects}
          label={`${projects} projects: ${projects} copied stacks each wired to the operator, against one rack behind one console`}
        />
      </div>

      <label className={styles.slider}>
        <span>Projects</span>
        <input
          type="range"
          min={1}
          max={6}
          step={1}
          value={projects}
          onChange={(e) => setProjects(Number(e.target.value))}
        />
        <output className={styles.count}>{projects}</output>
      </label>
    </figure>
  )
}
