import { useMemo, useState } from 'react';
import { Download, FileJson, FileSpreadsheet } from 'lucide-react';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/shared/ui/Modal';
import { downloadCSV, downloadJSON } from '@/shared/lib/export';

type ExportFormat = 'csv' | 'json';

interface ExportColumn {
  /** Property key on each row. */
  key: string;
  /** Human label shown in the picker + CSV header. Defaults to key. */
  label?: string;
}

interface ExportButtonProps {
  /** Base filename without extension (e.g. "users" → users.csv). */
  filename: string;
  columns: ExportColumn[];
  rows: object[];
  /** Offered formats. Default: both. */
  formats?: ExportFormat[];
  /** Trigger button label. Default: "Export". */
  label?: string;
  /** Trigger button class. Default: "btn". */
  className?: string;
  disabled?: boolean;
}

/**
 * One consistent "Export" affordance across the studio: a single button that
 * opens a modal to choose the format and which columns to include, then streams
 * the download. Replaces ad-hoc, glued-together CSV/JSON button pairs. Reused by
 * the table editor and the logs viewer.
 */
export default function ExportButton({
  filename,
  columns,
  rows,
  formats = ['csv', 'json'],
  label = 'Export',
  className = 'btn',
  disabled,
}: ExportButtonProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={className}
        disabled={disabled || rows.length === 0}
        title={rows.length === 0 ? 'Nothing to export' : 'Export data'}
      >
        <Download size={14} /> {label}
      </button>
      {open && (
        <ExportModal
          filename={filename}
          columns={columns}
          rows={rows}
          formats={formats}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ExportModal({
  filename,
  columns,
  rows,
  formats,
  onClose,
}: {
  filename: string;
  columns: ExportColumn[];
  rows: object[];
  formats: ExportFormat[];
  onClose: () => void;
}) {
  const [format, setFormat] = useState<ExportFormat>(formats[0]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(columns.map(c => c.key)));

  const chosen = useMemo(() => columns.filter(c => selected.has(c.key)), [columns, selected]);
  const allOn = selected.size === columns.length;

  function toggle(key: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function run() {
    const keys = chosen.map(c => c.key);
    if (format === 'json') {
      const projected = keys.length === columns.length
        ? rows
        : rows.map(row => {
          const record = row as Record<string, unknown>;
          return Object.fromEntries(keys.map(key => [key, record[key]]));
        });
      downloadJSON(`${filename}.json`, projected);
    } else {
      downloadCSV(`${filename}.csv`, keys, rows);
    }
    onClose();
  }

  return (
    <Modal onClose={onClose} width="480px">
      <ModalHeader title="Export data" description={`${rows.length.toLocaleString()} row${rows.length === 1 ? '' : 's'} ready to export.`} />
      <ModalBody className="space-y-5">
        <div>
          <span className="label">Format</span>
          <div className="mt-2 flex gap-2">
            {formats.map(f => {
              const on = format === f;
              return (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFormat(f)}
                  className="btn flex-1 justify-center"
                  style={{
                    borderColor: on ? 'var(--accent)' : undefined,
                    color: on ? 'var(--accent)' : undefined,
                    background: on ? 'var(--accent-soft)' : undefined,
                  }}
                >
                  {f === 'csv' ? <FileSpreadsheet size={14} /> : <FileJson size={14} />}
                  {f.toUpperCase()}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between">
            <span className="label">Columns</span>
            <button
              type="button"
              className="text-[11px]"
              style={{ color: 'var(--accent)' }}
              onClick={() => setSelected(allOn ? new Set() : new Set(columns.map(c => c.key)))}
            >
              {allOn ? 'Deselect all' : 'Select all'}
            </button>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-1.5" style={{ maxHeight: 220, overflowY: 'auto' }}>
            {columns.map(c => (
              <label key={c.key} className="flex items-center gap-2 text-[12px]" style={{ cursor: 'pointer' }}>
                <input type="checkbox" checked={selected.has(c.key)} onChange={() => toggle(c.key)} />
                <span className="truncate">{c.label ?? c.key}</span>
              </label>
            ))}
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        <button type="button" onClick={onClose} className="btn btn-ghost">Cancel</button>
        <button type="button" onClick={run} disabled={chosen.length === 0} className="btn btn-primary">
          <Download size={14} /> Export {format.toUpperCase()}
        </button>
      </ModalFooter>
    </Modal>
  );
}
