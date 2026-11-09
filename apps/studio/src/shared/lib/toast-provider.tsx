import { useCallback, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from 'lucide-react';
import { ToastCtx, type Toast } from '@/shared/lib/toast';

const icons = {
  success: <CheckCircle2 size={14} className="shrink-0" style={{ color: 'var(--green)' }} />,
  error: <XCircle size={14} className="shrink-0" style={{ color: 'var(--red)' }} />,
  warn: <AlertTriangle size={14} className="shrink-0" style={{ color: 'var(--amber)' }} />,
  info: <Info size={14} className="shrink-0" style={{ color: 'var(--blue)' }} />,
};

// An error is the one toast a user actually has to read (and often copy), so it
// stays up long enough to do that. Everything else is an acknowledgement.
const DURATIONS: Record<Toast['kind'], number> = {
  success: 4000,
  info: 4000,
  warn: 7000,
  error: 10000,
};

/** Window in which an identical toast is treated as a repeat, not a new event. */
const DEDUPE_MS = 3000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const recent = useRef(new Map<string, number>());

  const push = useCallback((toast: Omit<Toast, 'id'>) => {
    // Several widgets failing on the same request (a page that fires four
    // queries against a stopped project) must not stack four identical toasts.
    const key = `${toast.kind}|${toast.title}|${toast.message ?? ''}`;
    const now = Date.now();
    const lastSeen = recent.current.get(key);
    if (lastSeen !== undefined && now - lastSeen < DEDUPE_MS) return;
    recent.current.set(key, now);
    for (const [seenKey, at] of recent.current) {
      if (now - at > DEDUPE_MS) recent.current.delete(seenKey);
    }

    const id = now + Math.random();
    setItems(current => [...current, { ...toast, id }]);
    window.setTimeout(
      () => setItems(current => current.filter(item => item.id !== id)),
      DURATIONS[toast.kind] ?? 4000
    );
  }, []);

  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="pointer-events-none fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] left-3 right-3 md:bottom-6 z-[100] flex w-auto flex-col gap-2 sm:left-auto sm:right-6 sm:w-80">
        {items.map(toast => (
          <div key={toast.id} className="card pointer-events-auto rise flex items-start gap-3 p-3" style={{ background: 'var(--ink-2)' }}>
            <div className="mt-0.5">{icons[toast.kind]}</div>
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-semibold tracking-tight">{toast.title}</div>
              {toast.message && <div className="mt-0.5 text-[11px]" style={{ color: 'var(--paper-mute)' }}>{toast.message}</div>}
            </div>
            <button onClick={() => setItems(current => current.filter(item => item.id !== toast.id))} className="text-current opacity-50 hover:opacity-100" aria-label="dismiss">
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
