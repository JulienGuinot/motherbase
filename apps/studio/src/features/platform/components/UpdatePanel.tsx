import { useQuery } from '@tanstack/react-query';
import { RefreshCw, ArrowUpCircle, CheckCircle2, AlertTriangle, PackageSearch, Terminal } from 'lucide-react';
import { platform } from '@/shared/lib/api';
import { CodeBlock } from '@/shared/ui/CodeBlock';

// Console self-update: CHECK view. Shows the running version and whether a newer
// one is published on the release channel (UPDATE_CHECK_URL). Read-only for now;
// applying an update is a separate, gated action.
export function UpdatePanel() {
  const q = useQuery({
    queryKey: ['platform-version'],
    queryFn: platform.version,
    staleTime: 60_000,
  });

  const v = q.data;

  const planQ = useQuery({
    queryKey: ['platform-update-plan'],
    queryFn: platform.updatePlan,
    enabled: !!v?.updateAvailable,
    staleTime: 60_000,
  });

  const tone =
    !v ? 'muted'
    : !v.configured ? 'muted'
    : v.error ? 'warn'
    : v.updateAvailable ? 'update'
    : 'ok';

  const color =
    tone === 'ok' ? 'var(--green)'
    : tone === 'update' ? 'var(--accent)'
    : tone === 'warn' ? 'var(--amber)'
    : 'var(--text-mute)';

  const Icon =
    tone === 'ok' ? CheckCircle2
    : tone === 'update' ? ArrowUpCircle
    : tone === 'warn' ? AlertTriangle
    : PackageSearch;

  return (
    <div className="card p-6 space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-[13px]" style={{ fontWeight: 600 }}>Console version</span>
        <button
          onClick={() => q.refetch()}
          disabled={q.isFetching}
          className="btn btn-ghost"
          title="Check the release channel now"
        >
          <RefreshCw size={12} className={q.isFetching ? 'animate-spin' : undefined} /> Check
        </button>
      </div>

      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border hairline" style={{ background: 'var(--surface-2)' }}>
          <Icon size={18} style={{ color }} />
        </span>
        <div className="min-w-0">
          {q.isLoading ? (
            <div className="shimmer h-5 w-40" />
          ) : (
            <>
              <div className="text-[15px]" style={{ color, fontWeight: 600, letterSpacing: '-0.01em' }}>
                {tone === 'update' ? `Update available, v${v!.latest}`
                  : tone === 'ok' ? 'Up to date'
                  : tone === 'warn' ? 'Could not check for updates'
                  : 'Update checks not configured'}
              </div>
              <div className="mt-0.5 text-[12px]" style={{ color: 'var(--text-mute)' }}>
                Running <span className="mono">v{v?.current ?? '—'}</span>
                {v?.configured && v?.latest && !v.updateAvailable && <> · latest <span className="mono">v{v.latest}</span></>}
                {v?.error && <> · {v.error}</>}
              </div>
            </>
          )}
        </div>
      </div>

      {v && !v.configured && (
        <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-mute)' }}>
          Set <span className="mono">UPDATE_CHECK_URL</span> on the console to a URL that returns the newest published
          version: a manifest <span className="mono">{'{ "version": "1.2.3" }'}</span>, a tag list
          <span className="mono"> {'{ "tags": [...] }'}</span>, or your registry's tags endpoint. The console then
          surfaces new releases here.
        </p>
      )}

      {v?.updateAvailable && (
        <div className="rounded-lg border hairline p-3 text-[12px] space-y-3" style={{ background: 'var(--surface-1)', color: 'var(--text-dim)' }}>
          <div className="flex items-center gap-2" style={{ color: 'var(--text)', fontWeight: 600 }}>
            <Terminal size={13} /> Update on the host
          </div>
          <p className="leading-relaxed">
            Run these on the host where the console stack lives. They pull and recreate only the
            motherbase services, then apply migrations against the new image.
          </p>
          {planQ.data?.commands?.length ? (
            <CodeBlock
              value={planQ.data.commands.join('\n')}
              label="Shell"
              language="bash"
              size="sm"
              maxHeight={240}
            />
          ) : (
            <div className="shimmer h-16 w-full" />
          )}
          {planQ.data?.notes?.map((n, i) => (
            <p key={i} className="text-[11px] leading-relaxed" style={{ color: 'var(--text-mute)' }}>{n}</p>
          ))}
        </div>
      )}
    </div>
  );
}
