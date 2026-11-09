'use client';

import CodeMirror from '@uiw/react-codemirror';
import { sql as sqlLang } from '@codemirror/lang-sql';
import { Trash2 } from 'lucide-react';
import { useCodeMirrorTheme, overlayTooltips } from '@/shared/lib/codemirror-theme';
import { WriteButton } from '@/shared/ui/WriteButton';
import type { FnInfo } from '@/features/database/types';

export function FunctionEditorPane({
  selected,
  isNew,
  code,
  onChange,
  onSave,
  saving,
  onDrop,
  dropping,
}: {
  selected: FnInfo | null;
  isNew: boolean;
  code: string;
  onChange: (value: string) => void;
  onSave: () => void;
  saving: boolean;
  onDrop: (fn: FnInfo) => void;
  dropping: boolean;
}) {
  const theme = useCodeMirrorTheme();

  if (!selected && !isNew) {
    return (
      <div className="flex min-h-[420px] flex-1 items-center justify-center md:min-h-0" style={{ color: 'var(--text-mute)' }}>
        <span className="text-[13px]">Select a SQL function or create a new one</span>
      </div>
    );
  }

  return (
    <div className="flex min-h-[420px] flex-1 flex-col overflow-hidden md:min-h-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-3 hairline sm:px-5">
        <div className="flex min-w-0 flex-wrap items-center">
          {isNew ? (
            <span className="text-[13px]" style={{ color: 'var(--text)', fontWeight: 600 }}>
              New function
            </span>
          ) : (
            <span className="mono text-[13px]" style={{ color: 'var(--text)', fontWeight: 600 }}>
              {selected && `${selected.name}(${selected.args})`}
            </span>
          )}
          {selected && (
            <span className="chip ml-3">
              {selected.language} / returns {selected.returnType}
            </span>
          )}
        </div>

        <div className="flex gap-2">
          {selected && (
            <button
              onClick={() => onDrop(selected)}
              className="btn btn-ghost"
              style={{ color: 'var(--danger)' }}
              disabled={dropping}
            >
              <Trash2 size={13} /> Drop
            </button>
          )}
          <WriteButton onClick={onSave} className="btn btn-primary" disabled={saving}>
            Save
          </WriteButton>
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        <CodeMirror
          value={code}
          height="100%"
          extensions={[sqlLang(), overlayTooltips]}
          theme={theme}
          onChange={onChange}
          style={{ height: '100%', fontSize: 13 }}
        />
      </div>
    </div>
  );
}
