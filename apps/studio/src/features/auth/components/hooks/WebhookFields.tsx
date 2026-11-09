'use client';

import { SECRET_SENTINEL } from '@/shared/lib/settings';

/** URL plus signing secret, the pair every webhook-backed hook needs. */
export function WebhookFields({
  url,
  secret,
  onUrl,
  onSecret,
  disabled,
  urlLabel = 'Webhook URL',
  urlPlaceholder = 'https://…',
  secretLabel = 'Signing secret',
}: {
  url: string;
  secret: string;
  onUrl: (v: string) => void;
  onSecret: (v: string) => void;
  disabled: boolean;
  urlLabel?: string;
  urlPlaceholder?: string;
  secretLabel?: string;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="block">
        <span className="label">{urlLabel}</span>
        <input
          disabled={disabled}
          className="input mt-1 w-full"
          value={url}
          placeholder={urlPlaceholder}
          onChange={e => onUrl(e.target.value)}
        />
      </label>
      <label className="block">
        <span className="label">{secretLabel}</span>
        <input
          className="input mt-1 w-full"
          type="password"
          disabled={disabled}
          value={secret === SECRET_SENTINEL ? '' : secret}
          placeholder={secret === SECRET_SENTINEL ? '•••••• stored. Leave blank to keep' : 'HMAC secret'}
          onChange={e => onSecret(e.target.value)}
        />
      </label>
    </div>
  );
}
