import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, XCircle } from 'lucide-react';
import { platform, type DnsCheck } from '@/shared/lib/api';
import { SettingRow } from '@/shared/ui/Row';
import { Section } from '@/shared/ui/Section';
import { SkeletonList } from '@/shared/ui/Skeleton';

function DnsCheckRow({ check }: { check: DnsCheck }) {
  return (
    <SettingRow label={check.name} hint={check.target}>
      <span className="flex items-center gap-2 text-[12px]" style={{ color: check.ok ? 'var(--green)' : 'var(--red)' }}>
        {check.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
        {check.message}
      </span>
    </SettingRow>
  );
}

export function DnsChecksSection({ pid }: { pid: string }) {
  const dnsQ = useQuery({
    queryKey: ['platform-project-dns', pid],
    queryFn: async () => (await platform.projectDns(pid)).checks,
  });
  const checks = dnsQ.data ?? [];

  return (
    <Section bodyClassName="space-y-3" title="DNS checks">
      {dnsQ.isLoading && <SkeletonList rows={2} height={32} />}
      {checks.map(check => <DnsCheckRow key={`${check.name}-${check.target}`} check={check} />)}
      {!dnsQ.isLoading && !checks.length && (
        <p className="text-[12px]" style={{ color: 'var(--text-mute)' }}>No DNS result yet.</p>
      )}
    </Section>
  );
}
