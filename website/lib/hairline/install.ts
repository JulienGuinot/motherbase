// The figures in ./figures are written in hairline-create's format: they read
// the engine from a global `HL` and declare themselves through a global
// `hairline(...)`. This module provides both, so it must be imported before
// any figure (see ./index.ts).
import kernel from './kernel.js'

type Read = { textContent: string | null }
export type CustomFigureDef = {
  name: string
  means: string
  range: [number, number, number]
  mount: (host: { stage: HTMLElement; svg: SVGSVGElement; read: Read }, value: number) => {
    set(value: number): void
    destroy(): void
  }
}

export const HL = kernel as any
export const FIGURES: Record<string, CustomFigureDef> = {}

const g = globalThis as { HL?: unknown; hairline?: (def: CustomFigureDef) => void }
g.HL = HL
g.hairline = (def) => {
  FIGURES[def.name] = def
}
