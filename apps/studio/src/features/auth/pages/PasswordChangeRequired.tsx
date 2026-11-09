import { useRouter } from 'next/navigation';
import { KeyRound } from 'lucide-react';
import { PasswordChangeForm } from '@/features/auth/components/PasswordChangeForm';
import { auth } from '@/shared/lib/auth';
import { useOrgs } from '@/shared/lib/org';

export function PasswordChangeRequired() {
  const navigate = useRouter();
  const { reload: reloadOrgs } = useOrgs();

  async function completeRotation(): Promise<void> {
    auth.completePasswordChange();
    await reloadOrgs();
    navigate.replace('/');
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6" style={{ background: 'var(--bg)' }}>
      <section className="card w-full max-w-md p-8" aria-labelledby="password-change-title">
        <div
          className="mb-5 flex size-10 items-center justify-center rounded-lg"
          style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
        >
          <KeyRound size={20} aria-hidden="true" />
        </div>
        <h1 id="password-change-title" className="text-[20px] leading-tight">
          Change your temporary password
        </h1>
        <p className="mb-7 mt-2 text-[13px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
          Choose a private password before accessing projects and organization data.
        </p>
        <PasswordChangeForm
          autoFocusCurrent
          onChanged={completeRotation}
          submitLabel="Change password and continue"
        />
      </section>
    </main>
  );
}
