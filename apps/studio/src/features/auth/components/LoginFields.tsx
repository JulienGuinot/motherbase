'use client';

import type { ReactNode } from 'react';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[12px]" style={{ color: 'var(--text-dim)', fontWeight: 500 }}>
        {label}
      </div>
      {children}
    </div>
  );
}

export function CredentialFields({
  email,
  password,
  onEmail,
  onPassword,
}: {
  email: string;
  password: string;
  onEmail: (value: string) => void;
  onPassword: (value: string) => void;
}) {
  return (
    <div className="mt-7 space-y-4">
      <Field label="Email">
        <input
          className="input"
          type="email"
          autoComplete="username"
          value={email}
          onChange={e => onEmail(e.target.value)}
          placeholder="operator@example.com"
          required
          autoFocus
        />
      </Field>
      <Field label="Password">
        <input
          className="input"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={e => onPassword(e.target.value)}
          placeholder="••••••••••"
          required
        />
      </Field>
    </div>
  );
}

export function SecondFactorField({ code, onCode }: { code: string; onCode: (value: string) => void }) {
  return (
    <div className="mt-7">
      <Field label="Authentication code">
        <input
          className="input tracking-[0.4em]"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={e => onCode(e.target.value)}
          placeholder="123456"
          required
          autoFocus
        />
      </Field>
      <p className="mt-2 text-[11px]" style={{ color: 'var(--text-mute)' }}>
        Lost your device? Use a backup code.
      </p>
    </div>
  );
}

/** Inline notice above the submit button, in the given tone. */
export function LoginNotice({ tone, children }: { tone: 'amber' | 'red'; children: ReactNode }) {
  return (
    <div
      className="mt-4 border px-3 py-2 text-[12px]"
      style={{
        borderColor: `color-mix(in srgb, var(--${tone}) 30%, transparent)`,
        background: `color-mix(in srgb, var(--${tone}) 8%, transparent)`,
        color: `var(--${tone})`,
        borderRadius: 'var(--radius-sm)',
      }}
    >
      {children}
    </div>
  );
}
