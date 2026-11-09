'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Extension } from '@codemirror/state';
import CodeMirror from '@uiw/react-codemirror';
import { Download, Play, Plus, Save, WandSparkles, X } from 'lucide-react';
import { Cell } from '@/features/sql/components/Cell';
import type { SqlTab } from '@/features/sql/types';
import { downloadCSV, downloadJSON } from '@/shared/lib/export';
import { CodeBlock } from '@/shared/ui/CodeBlock';
import { SqlModeBadge } from '@/features/sql/components/SqlModeBadge';

const EDITOR_HEIGHT_KEY = 'mb.sql.editorHeight';
const MIN_EDITOR = 96;
const MIN_RESULTS = 140;

/**
 * Height of the editor pane, in px, dragged by the divider and remembered.
 *
 * It has to be a real pixel height rather than a flex-basis: the editor is a
 * flex item, flex items default to `min-height: auto`, and a query longer than
 * the pane then grew the pane instead of scrolling inside it. Pushing the
 * results grid out of the clipped `overflow-hidden` column entirely. That is
 * the "layout breaks on a long query" bug. A fixed height plus `min-h-0` on
 * both panes keeps the split stable at any query length.
 */
function useEditorHeight() {
  const [height, setHeight] = useState(240);
  // Mirrors `height` so the pointerup handler can persist the final value
  // without reading it out of a setState updater: React may run an updater
  // twice under StrictMode, and an updater with a side effect in it is not pure.
  const heightRef = useRef(240);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  // The tallest the editor may be and still leave the divider, the status bar
  // and at least MIN_RESULTS of grid visible. Measured from the pane's own top,
  // so it tracks the real window: a height saved on a tall screen (or grown by
  // the keyboard) must not push the results and status bar off the bottom on a
  // shorter one, which is what made the whole page scroll instead of the grid.
  const maxHeight = useCallback(() => {
    const pane = editorRef.current;
    if (!pane) return Number.POSITIVE_INFINITY;
    const top = pane.getBoundingClientRect().top;
    return Math.max(window.innerHeight - top - MIN_RESULTS, MIN_EDITOR);
  }, []);

  // One way in: clamps to [MIN_EDITOR, maxHeight] and keeps the ref and the
  // state in step, so the drag, keyboard, restore and resize paths can't set a
  // height that overflows the viewport.
  const applyHeight = useCallback((next: number) => {
    const clamped = Math.min(Math.max(next, MIN_EDITOR), maxHeight());
    heightRef.current = clamped;
    setHeight(clamped);
  }, [maxHeight]);

  // Read after mount, not in a lazy initialiser: this component is server-
  // rendered, and a height that differs between the server pass and the client
  // pass is a hydration mismatch on the inline style.
  useEffect(() => {
    const saved = Number(localStorage.getItem(EDITOR_HEIGHT_KEY));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- restoring persisted UI state on mount is the one render this can cost.
    if (saved >= MIN_EDITOR) applyHeight(saved);
  }, [applyHeight]);

  // Re-clamp when the window shrinks: without this a comfortable height set on
  // a large window keeps overflowing after the window is made shorter.
  useEffect(() => {
    const onResize = () => applyHeight(heightRef.current);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [applyHeight]);

  // Unmounting mid-drag (tab switch, navigation) would leave the window
  // listeners and the body's row-resize cursor / no-select behind.
  useEffect(() => () => dragCleanupRef.current?.(), []);

  const persistHeight = useCallback(() => {
    localStorage.setItem(EDITOR_HEIGHT_KEY, String(heightRef.current));
  }, []);

  const onDragStart = useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    const pane = editorRef.current;
    if (!pane) return;
    const top = pane.getBoundingClientRect().top;
    const cap = maxHeight();

    const move = (moveEvent: PointerEvent) => {
      applyHeight(Math.round(Math.min(Math.max(moveEvent.clientY - top, MIN_EDITOR), cap)));
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      dragCleanupRef.current = null;
    };
    const up = () => {
      stop();
      persistHeight();
    };
    dragCleanupRef.current = stop;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [applyHeight, persistHeight, maxHeight]);

  return { height, applyHeight, persistHeight, editorRef, onDragStart };
}

interface SqlWorkspaceProps {
  tabs: SqlTab[];
  active: SqlTab;
  activeId: string;
  running: boolean;
  editorExtensions: Extension[];
  editorTheme: Extension | 'light' | 'dark';
  onActiveChange: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: () => void;
  onFormat: () => void;
  onSaveSnippet: () => void;
  onRun: () => void;
  onSqlChange: (value: string) => void;
}

export function SqlWorkspace({
  tabs, active, activeId, running, editorExtensions, editorTheme,
  onActiveChange, onCloseTab, onNewTab,
  onFormat, onSaveSnippet, onRun, onSqlChange,
}: SqlWorkspaceProps) {
  const { height, applyHeight, persistHeight, editorRef, onDragStart } = useEditorHeight();

  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center border-b hairline pt-5">
        <div className="flex flex-1 min-w-0 overflow-x-auto overflow-y-hidden">
          {tabs.map(tab => (
            <div
              key={tab.id}
              onClick={() => onActiveChange(tab.id)}
              className="group flex shrink-0 cursor-pointer items-center gap-2 border-r hairline px-3 py-2 text-[12px]"
              style={{ background: tab.id === activeId ? 'var(--ink-2)' : 'transparent', borderBottom: `2px solid ${tab.id === activeId ? 'var(--accent)' : 'transparent'}` }}
            >
              <span className="max-w-[160px] truncate" title={tab.title}>{tab.title}</span>
              <button onClick={event => { event.stopPropagation(); onCloseTab(tab.id); }} className="opacity-40 hover:opacity-100" aria-label={`Close ${tab.title}`}><X size={10} /></button>
            </div>
          ))}
          <button onClick={onNewTab} className="p-2" aria-label="New query"><Plus size={12} /></button>
        </div>
        <div className="flex shrink-0 items-center gap-1 px-1 sm:gap-2 sm:px-3">
          <SqlModeBadge />
          <button onClick={onFormat} className="btn btn-ghost" title="Format SQL (⇧⌘F)"><WandSparkles size={14} /></button>
          <button onClick={onSaveSnippet} className="btn btn-ghost" title="Save as snippet"><Save size={14} /></button>
          <button onClick={onRun} disabled={running} className="btn btn-primary">
            <Play size={12} /> {running ? 'Running…' : 'Run'} <kbd style={{ background: 'rgba(0,0,0,0.18)', border: 'none', color: 'var(--accent-fg)' }}>⌘↵</kbd>
          </button>
        </div>
      </div>

      <div ref={editorRef} className="min-h-0 shrink-0 overflow-hidden" style={{ height }}>
        <CodeMirror value={active.sql} onChange={onSqlChange} theme={editorTheme} extensions={editorExtensions} height="100%" basicSetup={{ lineNumbers: true, highlightActiveLine: true }} style={{ height: '100%' }} />
      </div>

      {/* Drag to resize; double-click to reset. Keyboard users get the arrow keys. */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize editor"
        tabIndex={0}
        onPointerDown={onDragStart}
        onDoubleClick={() => { applyHeight(240); persistHeight(); }}
        onKeyDown={event => {
          if (event.key === 'ArrowUp') applyHeight(Math.max(height - 24, MIN_EDITOR));
          else if (event.key === 'ArrowDown') applyHeight(height + 24);
          else return;
          persistHeight();
          event.preventDefault();
        }}
        className="group relative h-[7px] shrink-0 cursor-row-resize border-y hairline"
        style={{ background: 'var(--surface-2)' }}
        title="Drag to resize · double-click to reset"
      >
        <span
          className="pointer-events-none absolute left-1/2 top-1/2 h-[3px] w-9 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors group-hover:bg-[var(--accent)]"
          style={{ background: 'var(--border-strong)' }}
        />
      </div>

      <div className="flex shrink-0 items-center gap-3 border-b hairline px-4 py-2 text-[11px]" style={{ color: 'var(--paper-mute)' }}>
        {active.error ? (
          // Only the first line here: the full text (often a multi-line Postgres
          // error with a HINT block) goes in the panel below, where it can wrap.
          <span className="mono min-w-0 truncate" style={{ color: 'var(--danger)' }} title={active.error}>
            ✕ {active.error.split('\n')[0]}
          </span>
        ) : active.result ? (
          <>
            <span className="tabular-nums">
              <span className="dot dot-live mr-2" />
              {active.result.kind === 'read' ? `${active.result.rows?.length ?? 0} rows` : active.result.kind === 'write' ? `${active.result.rowsAffected ?? 0} affected` : 'no result'}
            </span>
            {active.durationMs != null && <span className="tabular-nums">· {active.durationMs}ms</span>}
            <span className="hidden sm:inline">· kind: {active.result.kind}</span>
            {active.result.kind === 'read' && active.result.columns && (
              <span className="hidden tabular-nums md:inline">· {active.result.columns.length} cols</span>
            )}
            {active.result.kind === 'read' && active.result.rows && active.result.rows.length > 0 && (
              <div className="ml-auto flex shrink-0 gap-1">
                <button onClick={() => downloadCSV('query.csv', active.result?.columns ?? [], active.result?.rows ?? [])} className="btn btn-ghost"><Download size={11} /> CSV</button>
                <button onClick={() => downloadJSON('query.json', active.result?.rows)} className="btn btn-ghost"><Download size={11} /> JSON</button>
              </div>
            )}
          </>
        ) : <span>Press ⌘↵ to execute</span>}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {active.error && (
          <div className="p-4">
            <CodeBlock value={active.error} label="Postgres error" tone="danger" maxHeight={400} wrap />
          </div>
        )}
        {active.result?.kind === 'read' && (
          <table className="console" style={{ width: 'max-content', minWidth: '100%' }}>
            <thead>
              <tr>
                <th className="tabular-nums" style={{ width: 1, textAlign: 'right' }} />
                {active.result.columns?.map(column => <th key={column}>{column}</th>)}
              </tr>
            </thead>
            <tbody>
              {active.result.rows?.map((row, index) => (
                <tr key={index}>
                  <td className="tabular-nums select-none" style={{ color: 'var(--text-mute)', textAlign: 'right', fontSize: 11 }}>{index + 1}</td>
                  {active.result?.columns?.map(column => <td key={column} className="max-w-xs truncate"><Cell v={row[column]} /></td>)}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {active.result?.kind === 'write' && (
          <div className="flex flex-col items-center justify-center gap-2 p-12">
            <h1 className="text-[36px]" style={{ color: 'var(--text)', fontWeight: 600, letterSpacing: '-0.01em' }}>{active.result.rowsAffected ?? 0}</h1>
            <div className="label">row{active.result.rowsAffected === 1 ? '' : 's'} affected</div>
          </div>
        )}
        {!active.result && !active.error && !running && (
          <div className="flex flex-col items-center justify-center gap-3 p-16 text-center" style={{ color: 'var(--paper-mute)' }}>
            <span className="text-[22px]" style={{ fontWeight: 600, letterSpacing: '-0.01em' }}>Ready.</span>
            <p className="text-[12px]">Write SQL above and press <kbd>⌘</kbd> <kbd>↵</kbd> · or browse the library on the left.</p>
          </div>
        )}
      </div>
    </section>
  );
}
