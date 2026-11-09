'use client';

import { tooltips } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { usePreferences } from '@/shared/lib/theme';

/**
 * Lives in its own module, away from `usePreferences`.
 *
 * It used to sit in `shared/lib/theme`, which the app shell imports on every
 * single route to read the light/dark preference, so `@codemirror/theme-one-dark`
 * and the `@codemirror/state` + `@codemirror/view` graph behind it were pulled
 * into the shared chunk and downloaded by someone who only ever opened the
 * Projects list. Nothing but a CodeMirror instance needs this, and every
 * CodeMirror instance already imports the editor itself.
 */
export function useCodeMirrorTheme() {
  const { resolvedTheme } = usePreferences();
  return resolvedTheme === 'dark' ? oneDark : 'light';
}

/**
 * Renders completion popups and hover tooltips on <body> instead of inside the
 * editor.
 *
 * Every editor here sits in a fixed-height box inside a pane with
 * `overflow: hidden`, under a `.rise` animation whose `both` fill-mode leaves a
 * transform on the ancestor. That transform makes CodeMirror fall back from
 * fixed to absolute positioning, and the panes then clip the popup: type far
 * enough down a long query and the autocomplete list is cut off by the bottom
 * of the editor. A body-level parent is outside every one of those clips.
 */
export const overlayTooltips: Extension = tooltips({
  parent: typeof document === 'undefined' ? undefined : document.body,
});
