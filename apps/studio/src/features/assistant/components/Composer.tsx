import { useRef } from 'react';
import { SendHorizontal, Square } from 'lucide-react';

export function Composer({
  draft,
  onDraftChange,
  onSubmit,
  onStop,
  streaming,
  locked,
}: {
  draft: string;
  onDraftChange: (draft: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  streaming: boolean;
  /** Writes are waiting for approval: nothing new can be asked until they are resolved. */
  locked: boolean;
}) {
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const disabled = streaming || locked;

  return (
    <div className="border-t p-2" style={{ borderColor: 'var(--border)' }}>
      {streaming && (
        <div className="flex items-center gap-2 pb-1">
          <p className="flex-1 text-[11px]" style={{ color: 'var(--text-mute)' }}>
            The assistant is answering. Your next message will send once it finishes.
          </p>
          <button
            type="button"
            className="btn"
            aria-label="Stop the answer"
            onClick={() => {
              onStop();
              composerRef.current?.focus();
            }}
          >
            <Square size={11} /> Stop
          </button>
        </div>
      )}
      <div className="flex items-end gap-2">
        <textarea
          ref={composerRef}
          aria-label="Ask the assistant"
          value={draft}
          disabled={disabled}
          onChange={e => onDraftChange(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
          placeholder="Ask about your schema, data or logs"
          rows={2}
          className="w-full flex-1 resize-none rounded-md border bg-transparent px-2 py-1.5 text-[12px] disabled:opacity-60"
          style={{ borderColor: 'var(--border)' }}
        />
        <button
          type="button"
          className="btn btn-primary"
          aria-label="Send"
          title="Send (Enter)"
          onClick={onSubmit}
          disabled={disabled || !draft.trim()}
        >
          <SendHorizontal size={13} />
        </button>
      </div>
    </div>
  );
}
