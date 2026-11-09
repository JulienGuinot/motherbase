'use client';

import { Copy } from 'lucide-react';
import { useCopy } from '@/shared/hooks/useCopy';
import { ThinkingOrb } from '@/shared/ui/ThinkingOrb';
import Markdown from './Markdown';
import ToolCallCard from './ToolCallCard';
import type { ChatEntry } from '@/features/assistant/hooks/useAssistant';

// A user's own message is what they typed, so it is shown as typed. Only the
// model's answers, fenced code included, go through the markdown renderer.

export default function MessageList({ entries, streaming }: { entries: ChatEntry[]; streaming?: boolean }) {
  const copy = useCopy();
  const lastIndex = entries.length - 1;

  return (
    <div className="flex flex-col gap-5 p-3">
      {entries.map((entry, index) => {
        // The final assistant entry is the one still being written while a
        // response streams; its copy button would copy half an answer.
        const pending = Boolean(streaming) && index === lastIndex;

        return (
          <div key={entry.id} className="group flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-mute)' }}>
                {entry.role === 'user' ? 'You' : 'Assistant'}
              </span>
              {entry.model && (
                <span className="chip font-mono" style={{ fontSize: 9 }} title="Model that answered">
                  {entry.model}
                </span>
              )}
              {entry.role === 'assistant' && entry.text && !pending && (
                <button
                  type="button"
                  aria-label="Copy this answer"
                  title="Copy this answer"
                  onClick={() => copy(entry.text, 'Answer copied')}
                  className="ml-auto opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                  style={{ color: 'var(--text-mute)' }}
                >
                  <Copy size={12} />
                </button>
              )}
            </div>

            {entry.tools.map(t => (
              <ToolCallCard key={t.callId} trace={t} />
            ))}

            {entry.text &&
              (entry.role === 'user' ? (
                // The question sits in its own tinted block. Without it the two
                // roles are one unbroken column of text and a long answer reads
                // as though it had swallowed the next question.
                <p
                  className="whitespace-pre-wrap rounded-md px-3 py-2 text-[12.5px] leading-relaxed"
                  style={{ background: 'var(--surface-2)', color: 'var(--text)' }}
                >
                  {entry.text}
                </p>
              ) : (
                <Markdown>{entry.text}</Markdown>
              ))}

            {pending && !entry.text && !entry.tools.length && (
              <span className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-mute)' }}>
                <ThinkingOrb size={13} />
                Thinking…
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
