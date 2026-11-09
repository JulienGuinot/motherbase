'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/shared/ui/Badge';
import { Field } from '@/shared/ui/Field';
import { ListInput } from '@/shared/ui/ListInput';
import { Note } from '@/shared/ui/Row';
import { Section } from '@/shared/ui/Section';
import { Skeleton } from '@/shared/ui/Skeleton';
import { ToggleRow } from '@/shared/ui/Toggle';
import { WriteButton } from '@/shared/ui/WriteButton';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';
import { QueryFailure } from '@/shared/ui/QueryState';
import { useDatabaseAccess } from '@/features/projects/hooks/useInfrastructure';
import type { DatabaseExposure } from '@/features/projects/api/infrastructure.api';

const EXPOSURE_NOTE: Record<DatabaseExposure, string> = {
  unpublished: 'The database port is not published, so only this project\'s own services reach it. These settings take effect once it is.',
  loopback: 'The database port is bound to the server\'s loopback (DB_BIND=127.0.0.1): only SSH tunnels reach it, and those always pass. These settings take effect once it is bound publicly.',
  public: 'The database port is reachable from the internet. These rules decide who gets to try a password.',
};

/**
 * Project Settings > Database access: Supabase's Network Restrictions and SSL
 * Enforcement for direct Postgres connections. The project's own services
 * (API, cron, SSH tunnels through the host) are never restricted.
 */
export default function DatabaseAccessPanel() {
  const access = useDatabaseAccess();
  const network = access.network.data;
  const ssl = access.ssl.data;
  const [v4, setV4] = useState<string[]>([]);
  const [v6, setV6] = useState<string[]>([]);

  // Seed the editors from the server, and again after each save lands.
  useEffect(() => {
    if (!network) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- form state mirrors the fetched rules
    setV4(network.dbAllowedCidrs);
    setV6(network.dbAllowedCidrsV6);
  }, [network]);

  if (access.network.isLoading || access.ssl.isLoading) return <Skeleton style={{ height: 160 }} />;
  if (!network || !ssl) {
    return <QueryFailure title="Could not load database access" error={access.network.error ?? access.ssl.error} onRetry={() => { void access.network.refetch(); void access.ssl.refetch(); }} />;
  }

  const dirty = v4.join() !== network.dbAllowedCidrs.join() || v6.join() !== network.dbAllowedCidrsV6.join();
  const save = async () => {
    if (!v4.length && !v6.length && !(await confirmDialog({
      title: 'Block every external connection?',
      description: 'With no range allowed, only this project\'s own services and SSH tunnels can reach the database.',
      confirmLabel: 'Block all', tone: 'danger',
    }))) return;
    access.updateNetwork.mutate({ dbAllowedCidrs: v4, dbAllowedCidrsV6: v6 });
  };

  return (
    <div className="space-y-6">
      <Note>{EXPOSURE_NOTE[network.exposure]}</Note>
      {network.status === 'stored' && (
        <Note>This API does not manage its database&apos;s access rules (it is not a Console stack), so these settings are saved but not enforced.</Note>
      )}

      <Section
        title="Network restrictions"
        description={<>Ranges allowed to connect directly. <span className="mono">0.0.0.0/0</span> and <span className="mono">::/0</span> allow everyone; an empty list allows no one.</>}
        footer={
          <div className="flex justify-end">
            <WriteButton capability="settings.write" className="btn btn-primary" disabled={!dirty || access.updateNetwork.isPending} onClick={() => void save()}>
              Save restrictions
            </WriteButton>
          </div>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="IPv4 ranges" htmlFor="db-cidrs-v4"><ListInput id="db-cidrs-v4" value={v4} onChange={setV4} placeholder="203.0.113.0/24" mono /></Field>
          <Field label="IPv6 ranges" htmlFor="db-cidrs-v6"><ListInput id="db-cidrs-v6" value={v6} onChange={setV6} placeholder="2001:db8::/32" mono /></Field>
        </div>
      </Section>

      <Section title="SSL enforcement" actions={<Badge tone={ssl.sslActive ? 'success' : 'neutral'} dot>{ssl.sslActive ? 'TLS available' : 'TLS off'}</Badge>}>
        <ToggleRow
          label="Require SSL for external connections"
          hint="Clients must connect with sslmode=require. The certificate is self-signed and generated for this project on first use, so clients cannot verify it against a CA."
          checked={ssl.enforced}
          disabled={access.updateSsl.isPending}
          onChange={enforced => access.updateSsl.mutate(enforced)}
        />
      </Section>
    </div>
  );
}
