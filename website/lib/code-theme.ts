import { codeToHtml } from 'shiki'

export const codeThemes = {
  light: 'github-light',
  dark: 'one-dark-pro',
} as const

export const codeThemeOptions = {
  themes: codeThemes,
  defaultColor: false,
} as const

export function highlightCode(code: string, lang = 'bash') {
  return codeToHtml(code, {
    lang,
    ...codeThemeOptions,
  })
}
