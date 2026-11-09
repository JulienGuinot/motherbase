'use client';

import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { MotherbaseError } from '@motherbase/client';

export type AuthClassNames = Partial<Record<'root' | 'card' | 'logo' | 'header' | 'title' | 'description' | 'form' | 'field' | 'input' | 'button' | 'secondaryButton' | 'message' | 'footer', string>>;

/** Content placed above the title and below the form. */
export interface AuthSlots {
  logo?: ReactNode;
  footer?: ReactNode;
}

export function classes(...names: Array<string | undefined | false>): string {
  return names.filter(Boolean).join(' ');
}

export function FormShell({
  title,
  description,
  leading,
  children,
  footer,
  className,
  classNames,
}: {
  title: ReactNode;
  description?: ReactNode;
  leading?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  classNames?: AuthClassNames;
}) {
  return (
    <section className={classes('mbui mbui-card', className, classNames?.root, classNames?.card)}>
      {leading && <div className={classes('mbui-logo', classNames?.logo)}>{leading}</div>}
      <header className={classes('mbui-header', classNames?.header)}>
        <h1 className={classes('mbui-title', classNames?.title)}>{title}</h1>
        {description && <p className={classes('mbui-description', classNames?.description)}>{description}</p>}
      </header>
      {children}
      {footer && <div className={classes('mbui-footer', classNames?.footer)}>{footer}</div>}
    </section>
  );
}

export function Field({ label, name, type = 'text', value, onChange, autoComplete, classNames, required = true }: {
  label: string;
  name: string;
  type?: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  classNames?: AuthClassNames;
  required?: boolean;
}) {
  return (
    <label className={classes('mbui-field', classNames?.field)}>
      <span>{label}</span>
      <input
        name={name}
        type={type}
        value={value}
        onChange={event => onChange(event.target.value)}
        autoComplete={autoComplete}
        required={required}
        className={classes('mbui-input', classNames?.input)}
      />
    </label>
  );
}

export function Notice({ children, error = false, className }: { children?: ReactNode; error?: boolean; className?: string }) {
  if (!children) return null;
  return <p className={classes('mbui-notice', error && 'mbui-notice-error', className)} role={error ? 'alert' : 'status'}>{children}</p>;
}

/** Expected SDK failures and thrown callbacks share one form state. */
export function useFormAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Takes both error shapes: the SDK's, and Better Auth's (`client.auth`), where `message` is optional. */
  async function run<T extends { error: Pick<MotherbaseError, 'status'> & { message?: string; statusText?: string } | null }>(
    action: () => Promise<T>,
  ): Promise<T | null> {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (result.error) {
        setError(result.error.message || result.error.statusText || 'The request could not be completed.');
        return null;
      }
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request could not be completed.');
      return null;
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, setError, run };
}

export type SubmitEvent = FormEvent<HTMLFormElement>;
