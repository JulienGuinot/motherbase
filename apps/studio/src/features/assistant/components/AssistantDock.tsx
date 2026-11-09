'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useAssistant, type ChatEntry } from '@/features/assistant/hooks/useAssistant';
import { useAiModels } from '@/features/assistant/hooks/useAiModels';
import { useAssistantThreads } from '@/features/assistant/hooks/useAssistantThreads';
import { useDockResize } from '@/features/assistant/hooks/useDockResize';
import { getThread, type ThreadSummary } from '@/features/assistant/api/assistant.api';
import { pageContextFrom } from '@/features/assistant/lib/context';
import { DOCK_MAX_WIDTH, DOCK_MIN_WIDTH, loadDockState, saveDockState } from '@/features/assistant/lib/dock-state';
import { entriesFromMessages } from '@/features/assistant/lib/thread-entries';
import AiAssistantSettings from './AiAssistantSettings';
import { AssistantLauncher } from './AssistantLauncher';
import { Composer } from './Composer';
import { DockHeader } from './DockHeader';
import MessageList from './MessageList';
import { ModelPicker } from './ModelPicker';
import PendingWritesBar from './PendingWritesBar';
import ThreadList from './ThreadList';
import { EmptyState } from '@/shared/ui/EmptyState';
import { invalidateAfterArbitrarySql } from '@/shared/lib/invalidate';

type DockView = 'chat' | 'history' | 'settings';

/** How close to the bottom still counts as "following the answer". */
const STICK_TO_BOTTOM_PX = 80;

function DockBody({
  view,
  entries,
  streaming,
  notConfigured,
  threads,
  activeThreadId,
  onOpenThread,
  onRenameThread,
  onDeleteThread,
  onOpenSettings,
}: {
  view: DockView;
  entries: ChatEntry[];
  streaming: boolean;
  notConfigured: boolean;
  threads: ThreadSummary[];
  activeThreadId: string | undefined;
  onOpenThread: (id: string) => void;
  onRenameThread: (id: string, title: string) => void;
  onDeleteThread: (id: string) => void;
  onOpenSettings: () => void;
}) {
  if (view === 'settings') {
    return (
      <div className="p-3">
        <AiAssistantSettings />
      </div>
    );
  }
  if (view === 'history') {
    return (
      <ThreadList
        threads={threads}
        activeId={activeThreadId}
        onOpen={onOpenThread}
        onRename={onRenameThread}
        onDelete={onDeleteThread}
      />
    );
  }
  if (entries.length) return <MessageList entries={entries} streaming={streaming} />;
  if (notConfigured) {
    return (
      <EmptyState
        mascot="plug-cable"
        title="The assistant is not configured"
        description="Add a provider and an API key, then come back. The key stays on the server."
        action={
          <button type="button" className="btn btn-primary" onClick={onOpenSettings}>
            Open AI settings
          </button>
        }
      />
    );
  }
  return (
    <EmptyState
      mascot="idea"
      title="Ask about this project"
      description="The assistant can read your schema, run read-only SQL, and check your logs and advisor."
    />
  );
}

export default function AssistantDock({
  mobileNav,
}: {
  /** Small screens have one floating control, the navigation pill; the
   *  closed dock's launcher goes inside it rather than beside it. Not rendered
   *  while the dock is open, since the dock covers a phone's whole screen. */
  mobileNav?: (launcher: ReactNode) => ReactNode;
}) {
  const pathname = usePathname() ?? '';
  const qc = useQueryClient();
  // The assistant's tools run SQL and call admin routes, so what it created has
  // to appear on the page behind the dock without a reload.
  const refreshAfterTools = useCallback(() => void invalidateAfterArbitrarySql(qc), [qc]);
  const [dock, setDock] = useState(loadDockState);
  // Only ever one of the three bodies is on screen, so a single view flag
  // keeps them mutually exclusive by construction.
  const [view, setView] = useState<DockView>('chat');
  const [draft, setDraft] = useState('');
  const { entries, threadId, streaming, error, pendingWrites, send, resolveWrites, stop, reset, setThreadId, setEntries } =
    useAssistant({ onToolsRan: refreshAfterTools });
  const { startResize, handleResizeKeyDown } = useDockResize(setDock);
  const threads = useAssistantThreads({ enabled: dock.open, threadId, onDeletedCurrent: reset });
  const catalogue = useAiModels({}, dock.open);
  const scrollRef = useRef<HTMLDivElement>(null);
  const context = useMemo(() => pageContextFrom(pathname, {}), [pathname]);
  const model = dock.model || undefined;
  const toggleView = (target: DockView) => setView(v => (v === target ? 'chat' : target));

  useEffect(() => saveDockState(dock), [dock]);

  // Follow the answer as it streams, but only while the operator is already at
  // the bottom: scrolling up to re-read an earlier message must not be undone
  // by the next delta.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || view === 'history') return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance < STICK_TO_BOTTOM_PX) el.scrollTop = el.scrollHeight;
  }, [entries, view]);

  const submit = useCallback(() => {
    // The hook itself ignores a send while streaming, but it does so
    // silently; clearing the draft here regardless would make whatever the
    // operator typed vanish for nothing. Bail before touching the draft so a
    // second Enter mid-response is a no-op the user can see (the draft is
    // still there, still editable once the response lands).
    if (streaming || pendingWrites.length || !draft.trim()) return;
    setDraft('');
    void send(draft, context, model);
  }, [context, model, draft, pendingWrites.length, send, streaming]);

  const openThread = useCallback(
    (id: string) => {
      setView('chat');
      void getThread(id).then(thread => {
        if (!thread) return;
        setThreadId(id);
        const pendingCallIds = new Set<string>((thread.pending ?? []).map((c: { id: string }) => c.id));
        setEntries(entriesFromMessages(thread.messages ?? [], pendingCallIds));
      });
    },
    [setEntries, setThreadId],
  );

  if (!dock.open) {
    return <AssistantLauncher streaming={streaming} onOpen={() => setDock(d => ({ ...d, open: true }))} mobileNav={mobileNav} />;
  }

  return (
    <aside
      className="fixed right-[env(safe-area-inset-right)] top-0 z-40 flex h-full flex-col border-l"
      style={{ width: `min(${dock.width}px, 100vw)`, borderColor: 'var(--border)', background: 'var(--surface)' }}
    >
      <div
        role="slider"
        tabIndex={0}
        aria-label="Resize the assistant dock"
        aria-orientation="horizontal"
        aria-valuemin={DOCK_MIN_WIDTH}
        aria-valuemax={DOCK_MAX_WIDTH}
        aria-valuenow={dock.width}
        onPointerDown={startResize}
        onKeyDown={handleResizeKeyDown}
        className="absolute -left-1 top-0 h-full w-2 cursor-col-resize touch-none"
        style={{ touchAction: 'none' }}
      />

      <DockHeader
        streaming={streaming}
        onNewConversation={reset}
        onToggleHistory={() => toggleView('history')}
        onToggleSettings={() => toggleView('settings')}
        onClose={() => setDock(d => ({ ...d, open: false }))}
      />

      {view !== 'settings' && (
        <ModelPicker catalogue={catalogue.data} value={dock.model} onChange={next => setDock(d => ({ ...d, model: next }))} />
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <DockBody
          view={view}
          entries={entries}
          streaming={streaming}
          notConfigured={catalogue.data ? !catalogue.data.configured : false}
          threads={threads.threads}
          activeThreadId={threadId}
          onOpenThread={openThread}
          onRenameThread={threads.rename}
          onDeleteThread={id => void threads.remove(id)}
          onOpenSettings={() => setView('settings')}
        />
      </div>

      {error && (
        <p className="px-3 py-2 text-[11px]" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}

      {view !== 'history' && pendingWrites.length > 0 && (
        <PendingWritesBar
          // Re-keyed on the proposal set so a fresh batch always starts from a
          // blank slate instead of the previous batch's leftover decisions.
          key={pendingWrites.map(w => w.callId).join(',')}
          writes={pendingWrites}
          busy={streaming}
          onResolve={decisions => void resolveWrites(decisions, context, model)}
        />
      )}

      {view !== 'settings' && (
        <Composer
          draft={draft}
          onDraftChange={setDraft}
          onSubmit={submit}
          onStop={stop}
          streaming={streaming}
          locked={pendingWrites.length > 0}
        />
      )}
    </aside>
  );
}
