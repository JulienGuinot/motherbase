'use client';

import { useState } from 'react';
import { KeyRound, Plus, RotateCw, Trash2, Upload } from 'lucide-react';
import { Badge, type Tone } from '@/shared/ui/Badge';
import CopyButton from '@/shared/ui/CopyButton';
import { Field } from '@/shared/ui/Field';
import { Note } from '@/shared/ui/Row';
import { Section } from '@/shared/ui/Section';
import Select from '@/shared/ui/Select';
import { Skeleton } from '@/shared/ui/Skeleton';
import { WriteButton } from '@/shared/ui/WriteButton';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';
import { QueryFailure } from '@/shared/ui/QueryState';
import { formatRelativeTime } from '@/shared/lib/format';
import { useSigningKeys } from '@/features/projects/hooks/useInfrastructure';
import type { SigningAlgorithm, SigningKey, SigningKeyStatus } from '@/features/projects/api/infrastructure.api';

const STATUS: Record<SigningKeyStatus, { label: string; tone: Tone }> = {
  in_use: { label: 'current', tone: 'success' },
  standby: { label: 'standby', tone: 'info' },
  previously_used: { label: 'previously used', tone: 'warn' },
  revoked: { label: 'revoked', tone: 'danger' },
};

// Most useful first: the key signing now, the one lined up next, then history.
const ORDER: SigningKeyStatus[] = ['in_use', 'standby', 'previously_used', 'revoked'];

const ALGORITHMS = [
  { value: 'ES256', label: 'ES256 · ECC P-256 (recommended)' },
  { value: 'RS256', label: 'RS256 · RSA 2048' },
  { value: 'EdDSA', label: 'EdDSA · Ed25519' },
];

function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function KeyRow({ signingKey, busy, keys }: { signingKey: SigningKey; busy: boolean; keys: ReturnType<typeof useSigningKeys> }) {
  const { label, tone } = STATUS[signingKey.status];
  const act = async (action: 'rotate' | 'revoke' | 'remove') => {
    const copy = {
      rotate: ['Rotate to this key?', 'New access tokens are signed with it. Tokens signed by the current key keep verifying until you revoke it.', 'Rotate'],
      revoke: ['Revoke this key?', 'Every token it signed stops verifying immediately: users holding one are signed out of anything checking it.', 'Revoke'],
      remove: ['Delete this key?', 'It is removed from the key set for good.', 'Delete'],
    }[action];
    if (await confirmDialog({ title: copy[0], description: copy[1], confirmLabel: copy[2], tone: action === 'rotate' ? 'default' : 'danger' })) {
      keys[action].mutate(signingKey.id);
    }
  };
  return (
    <div className="row-host flex items-center gap-3 px-5 py-3" style={{ opacity: signingKey.status === 'revoked' ? 0.55 : 1 }}>
      <KeyRound size={14} style={{ color: 'var(--text-mute)', flexShrink: 0 }} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="mono truncate text-[12px]" style={{ color: 'var(--text)' }}>{signingKey.id}</span>
          <Badge tone={tone} dot>{label}</Badge>
          <Badge>{signingKey.algorithm}</Badge>
        </div>
        <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-mute)' }}>created {formatRelativeTime(signingKey.createdAt)}</div>
      </div>
      <CopyButton value={JSON.stringify(signingKey.publicJwk, null, 2)} label="Public JWK" />
      {signingKey.status === 'standby' && (
        <WriteButton capability="secrets.manage" className="btn" disabled={busy} onClick={() => void act('rotate')}>
          <RotateCw size={13} /> Rotate
        </WriteButton>
      )}
      {signingKey.status === 'previously_used' && (
        <WriteButton capability="secrets.manage" className="btn btn-ghost" disabled={busy} onClick={() => void act('revoke')}>Revoke</WriteButton>
      )}
      {(signingKey.status === 'standby' || signingKey.status === 'revoked') && (
        <WriteButton capability="secrets.manage" className="btn btn-ghost" disabled={busy} title="Delete" onClick={() => void act('remove')}>
          <Trash2 size={13} />
        </WriteButton>
      )}
    </div>
  );
}

/**
 * Project Settings > JWT Keys: the asymmetric keys access tokens are signed
 * with, and their rotation (standby → current → previously used → revoked).
 */
export default function JwtKeysPanel() {
  const keys = useSigningKeys();
  const [algorithm, setAlgorithm] = useState<SigningAlgorithm>('ES256');
  const [imported, setImported] = useState('');
  const data = keys.query.data;
  const busy = keys.rotate.isPending || keys.revoke.isPending || keys.remove.isPending;

  if (keys.query.isLoading) return <Skeleton style={{ height: 160 }} />;
  if (!data) return <QueryFailure title="Could not load signing keys" error={keys.query.error} onRetry={() => void keys.query.refetch()} />;

  const jwksUrl = `${data.issuer}${data.jwksPath}`;
  const sorted = [...data.keys].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
  // The button stays disabled until the text parses, so the parse below cannot throw.
  const importError = imported.trim() && !parsesAsJson(imported) ? 'Not valid JSON' : null;
  const importKey = () =>
    keys.create.mutate({ privateKey: JSON.parse(imported) }, { onSuccess: () => setImported('') });

  return (
    <div className="space-y-6">
      <Note>
        Access tokens (<span className="mono">/api/auth/token</span>) are signed with the <strong>current</strong> key and carry
        its id as <span className="mono">kid</span>. Anything verifying them should read the public keys from the JWKS
        endpoint below. To rotate: create a standby key, give verifiers time to cache it, rotate, and revoke the previous
        key once the tokens it signed have expired.
      </Note>

      <Section title="JWKS endpoint">
        <div className="flex items-center gap-2">
          <code className="mono flex-1 truncate rounded px-3 py-2 text-[12px]" style={{ background: 'var(--code-bg)', color: 'var(--text)' }}>{jwksUrl}</code>
          <CopyButton value={jwksUrl} label="Copy" />
        </div>
        <div className="mt-2 text-[11px]" style={{ color: 'var(--text-mute)' }}>
          Tokens are issued with <span className="mono">iss</span> and <span className="mono">aud</span> set to <span className="mono">{data.issuer}</span>.
        </div>
      </Section>

      <Section title="Signing keys" flush bodyClassName="divide-y">
        <div className="divide-y">
          {sorted.map(k => <KeyRow key={k.id} signingKey={k} busy={busy} keys={keys} />)}
          {!sorted.length && (
            <div className="px-5 py-4 text-[12px]" style={{ color: 'var(--text-mute)' }}>
              No key yet: the first token request creates one.
            </div>
          )}
        </div>
      </Section>

      <Section title="Add a standby key">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field label="Algorithm">
            <Select value={algorithm} onChange={v => setAlgorithm(v as SigningAlgorithm)} options={ALGORITHMS} ariaLabel="Algorithm" />
          </Field>
          <WriteButton capability="secrets.manage" className="btn btn-primary" disabled={keys.create.isPending} onClick={() => keys.create.mutate({ algorithm })}>
            <Plus size={13} /> Create key
          </WriteButton>
        </div>
        <Field className="mt-4" label="Or import a private key" error={importError}
          hint={<>A private JWK, e.g. from <span className="mono">motherbase gen signing-key</span>. Its <span className="mono">kid</span> is kept.</>}>
          <textarea className="input mono w-full" rows={4} value={imported} onChange={e => setImported(e.target.value)} placeholder='{"kty":"EC","crv":"P-256","d":"…","x":"…","y":"…","kid":"…"}' />
        </Field>
        <div className="mt-2 flex justify-end">
          <WriteButton capability="secrets.manage" className="btn" disabled={!imported.trim() || Boolean(importError) || keys.create.isPending} onClick={importKey}>
            <Upload size={13} /> Import
          </WriteButton>
        </div>
      </Section>

      <Section title="Legacy JWT secret" description="The symmetric secret (JWT_SECRET) this project was created with.">
        <div className="space-y-2 text-[12px]" style={{ color: 'var(--text-dim)' }}>
          <div>Fingerprint <span className="mono">{data.legacy.fingerprint}</span> · {data.legacy.algorithm}</div>
          <div>
            It signs {data.legacy.usedFor.join(', ')}. No access token here is HS256, so there is nothing signed with it for
            a verifier to trust or to revoke. Rotating it signs every user out, which is why it is changed in the
            project&apos;s environment and not here.
          </div>
        </div>
      </Section>
    </div>
  );
}
