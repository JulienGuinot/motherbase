import CodeMirror from '@uiw/react-codemirror';
import { javascript as javascriptLanguage } from '@codemirror/lang-javascript';
import { Clock, Globe, Lock, Play, Trash2 } from 'lucide-react';
import CronScheduleField from '@/features/api-tools/components/CronScheduleField';
import { FUNCTION_TEMPLATES, renderFunctionTemplate } from '@/features/api-tools/lib/function-templates';
import type { EdgeFn, FnLog, InvokeResult } from '@/features/api-tools/types';
import { useCodeMirrorTheme, overlayTooltips } from '@/shared/lib/codemirror-theme';
import { Skeleton } from '@/shared/ui/Skeleton';
import { EmptyState } from '@/shared/ui/EmptyState';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';
import { CodeBlock } from '@/shared/ui/CodeBlock';

export type EdgeFunctionTab = 'editor' | 'invoke' | 'logs';

interface EdgeFunctionWorkspaceProps {
  selected: EdgeFn | null;
  isNew: boolean;
  newName: string;
  newRoute: string;
  schedule: string;
  code: string;
  activeTab: EdgeFunctionTab;
  invokeBody: string;
  invokeResult: InvokeResult | null;
  logs: FnLog[] | undefined;
  logsLoading: boolean;
  creating: boolean;
  saving: boolean;
  deleting: boolean;
  invoking: boolean;
  togglingPublic: boolean;
  onNewNameChange: (value: string) => void;
  onNewRouteChange: (value: string) => void;
  onScheduleChange: (value: string) => void;
  onCodeChange: (value: string) => void;
  onTabChange: (tab: EdgeFunctionTab) => void;
  onInvokeBodyChange: (value: string) => void;
  onCreate: () => void;
  onSave: () => void;
  onDelete: () => void;
  onInvoke: () => void;
  onTogglePublic: () => void;
}

export function EdgeFunctionWorkspace({
  selected,
  isNew,
  newName,
  newRoute,
  schedule,
  code,
  activeTab,
  invokeBody,
  invokeResult,
  logs,
  logsLoading,
  creating,
  saving,
  deleting,
  invoking,
  togglingPublic,
  onNewNameChange,
  onNewRouteChange,
  onScheduleChange,
  onCodeChange,
  onTabChange,
  onInvokeBodyChange,
  onCreate,
  onSave,
  onDelete,
  onInvoke,
  onTogglePublic,
}: EdgeFunctionWorkspaceProps) {
  const codeMirrorTheme = useCodeMirrorTheme();

  return (
    <div className="flex min-h-[420px] flex-1 flex-col overflow-hidden md:min-h-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-3 hairline sm:px-5">
        <div>
          {isNew ? (
            <div className="flex items-center gap-2 sm:gap-3">
              <input value={newName} onChange={event => onNewNameChange(event.target.value)} placeholder="function-name" className="input w-full sm:w-40" />
              <span style={{ color: 'var(--text-mute)' }}>/</span>
              <input value={newRoute} onChange={event => onNewRouteChange(event.target.value)} placeholder="route-slug" className="input w-full sm:w-40" />
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <span className="text-[13px]" style={{ fontWeight: 600 }}>{selected?.name}</span>
              <span className="chip mono text-[11px]">{selected?.route}</span>
              <CronScheduleField value={schedule} onChange={onScheduleChange} />
              <button
                type="button"
                className="chip"
                onClick={onTogglePublic}
                disabled={togglingPublic}
                title={selected?.isPublic ? 'Anyone can call this route. Click to require auth again.' : 'Callers need a session or the invoke token. Click to make it public.'}
                style={{ color: selected?.isPublic ? 'var(--amber)' : 'var(--text-mute)' }}
              >
                {selected?.isPublic ? <><Globe size={11} className="mr-1 inline" />Public</> : <><Lock size={11} className="mr-1 inline" />Requires auth</>}
              </button>
            </div>
          )}
        </div>
        <div className="flex gap-2">
          {selected && !isNew && (
            <>
              <button
                onClick={async () => { if (await confirmDialog({ title: `Delete "${selected.name}"?`, description: 'Every caller of its route starts getting 404s.', confirmLabel: 'Delete function', tone: 'danger' })) onDelete(); }}
                className="btn btn-ghost"
                style={{ color: 'var(--danger)' }}
                disabled={deleting}
              >
                <Trash2 size={13} /> Delete
              </button>
              <button onClick={onSave} className="btn" disabled={saving}>Save</button>
            </>
          )}
          {isNew && (
            <button onClick={onCreate} disabled={creating || !newName.trim() || !newRoute.trim()} className="btn btn-primary">Deploy</button>
          )}
        </div>
      </div>

      {isNew && (
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 hairline sm:px-5">
          <span className="label">Template</span>
          {FUNCTION_TEMPLATES.map(template => (
            <button
              key={template.id}
              className="chip"
              title={template.description}
              onClick={() => onCodeChange(renderFunctionTemplate(template, newName))}
            >
              {template.label}
            </button>
          ))}
        </div>
      )}

      {!isNew && (
        <div className="flex gap-0 border-b hairline px-5">
          {(['editor', 'invoke', 'logs'] as EdgeFunctionTab[]).map(tab => (
            <button
              key={tab}
              onClick={() => onTabChange(tab)}
              className="px-4 py-2 text-[12px] capitalize"
              style={{
                color: activeTab === tab ? 'var(--text)' : 'var(--text-mute)',
                borderBottom: activeTab === tab ? '2px solid var(--accent)' : '2px solid transparent',
                marginBottom: -1,
              }}
            >
              {tab === 'invoke' ? <><Play size={11} className="mr-1 inline" />Invoke</> : tab === 'logs' ? <><Clock size={11} className="mr-1 inline" />Logs</> : tab}
            </button>
          ))}
        </div>
      )}

      {(activeTab === 'editor' || isNew) && (
        <div className="flex-1 overflow-hidden">
          <CodeMirror
            value={code}
            height="100%"
            theme={codeMirrorTheme}
            onChange={onCodeChange}
            extensions={[javascriptLanguage(), overlayTooltips]}
            style={{ height: '100%', fontSize: 13 }}
          />
        </div>
      )}

      {activeTab === 'invoke' && selected && (
        <div className="flex flex-1 flex-col overflow-auto md:flex-row md:overflow-hidden">
          <div className="flex min-h-[300px] w-full flex-col border-b hairline md:min-h-0 md:w-1/2 md:border-b-0 md:border-r">
            <div className="border-b hairline px-4 py-2 text-[12px]" style={{ fontWeight: 600 }}>Input (JSON)</div>
            <div className="flex-1 overflow-hidden">
              <CodeMirror value={invokeBody} height="100%" theme={codeMirrorTheme} onChange={onInvokeBodyChange} style={{ height: '100%', fontSize: 12 }} />
            </div>
            <div className="border-t hairline p-3">
              <button onClick={onInvoke} disabled={invoking} className="btn btn-primary w-full justify-center">
                <Play size={13} /> {invoking ? 'Running...' : 'Run function'}
              </button>
            </div>
          </div>
          <div className="flex min-h-[300px] w-full flex-col md:min-h-0 md:w-1/2">
            <div className="flex items-center gap-3 border-b hairline px-4 py-2 text-[12px]" style={{ fontWeight: 600 }}>
              Output
              {invokeResult && (
                <>
                  <span className="chip" style={{ color: invokeResult.error ? 'var(--danger)' : 'var(--green)' }}>{invokeResult.error ? 'Error' : 'OK'}</span>
                  <span className="chip tabular-nums">{invokeResult.durationMs}ms</span>
                </>
              )}
            </div>
            <div className="flex-1 space-y-4 overflow-auto p-4">
              {invokeResult ? (
                <>
                  {invokeResult.stdout && <OutputBlock label="Stdout" value={invokeResult.stdout} />}
                  {invokeResult.error && <OutputBlock label="Error" value={invokeResult.error} error />}
                  {!invokeResult.error && (
                    <CodeBlock value={invokeResult.value} label="Return value" tone="success" maxHeight={320} wrap />
                  )}
                </>
              ) : (
                <p className="text-[12px]" style={{ color: 'var(--text-mute)' }}>Run the function to see output</p>
              )}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'logs' && selected && (
        <div className="flex-1 overflow-auto">
          <table className="console w-full">
            <thead><tr><th>Time</th><th>Status</th><th>Duration</th><th>Output</th></tr></thead>
            <tbody>
              {logsLoading && !logs
                ? Array.from({ length: 6 }).map((_, index) => (
                    <tr key={index}>
                      {[70, 40, 50, 220].map(width => <td key={width}><Skeleton style={{ height: 12, width }} /></td>)}
                    </tr>
                  ))
                : logs?.map(log => (
                    <tr key={log.id}>
                      <td className="tabular-nums text-[11px]">{new Date(log.invokedAt).toLocaleString()}</td>
                      <td><span className="chip tabular-nums" style={{ color: log.status >= 400 ? 'var(--danger)' : 'var(--green)' }}>{log.status}</span></td>
                      <td className="tabular-nums text-[11px]">{log.durationMs}ms</td>
                      <td className="mono max-w-xs truncate text-[11px]" style={{ color: 'var(--text-mute)' }}>{log.errorMessage ?? log.stdout}</td>
                    </tr>
                  ))}
            </tbody>
          </table>
          {!logsLoading && logs?.length === 0 && <EmptyState mascot="deploy" title="No invocations yet" description="Invoke the function, or call its route, and the log fills in here." />}
        </div>
      )}
    </div>
  );
}

interface OutputBlockProps {
  label: string;
  value: string;
  error?: boolean;
}

function OutputBlock({ label, value, error = false }: OutputBlockProps) {
  return <CodeBlock value={value} label={label} tone={error ? 'danger' : 'default'} maxHeight={260} wrap />;
}
