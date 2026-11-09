'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { getErrorMessage } from '@/shared/lib/errors';
import { sendTestPush } from '@/shared/lib/settings';
import { useToast } from '@/shared/lib/toast';
import { Field } from '@/shared/ui/Field';
import Select from '@/shared/ui/Select';

/** Sends one push straight to a device token, to verify FCM/APNs credentials without a real app install. */
export function PushTestPanel() {
  const toast = useToast();
  const [token, setToken] = useState('');
  const [platform, setPlatform] = useState<'ios' | 'android' | 'web'>('android');

  const test = useMutation({
    mutationFn: () => sendTestPush(token, platform),
    onSuccess: () => toast.push({ kind: 'success', title: 'Test push sent' }),
    onError: (e: unknown) => toast.push({ kind: 'error', title: 'Test failed', message: getErrorMessage(e) }),
  });

  return (
    <div className="card space-y-4 p-5">
      <div>
        <div className="text-[14px] font-medium">Send a test push</div>
        <p className="mt-0.5 text-[12px]" style={{ color: 'var(--text-mute)' }}>
          Sends directly to a device token, bypassing the devices table. Useful to confirm the
          credentials above actually work.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
        <Field label="Device token">
          <input className="input" value={token} onChange={e => setToken(e.target.value)} placeholder="FCM or APNs device token" />
        </Field>
        <Field label="Platform">
          <Select
            value={platform}
            onChange={v => setPlatform(v as typeof platform)}
            options={[
              { value: 'android', label: 'Android (FCM)' },
              { value: 'ios', label: 'iOS (APNs)' },
              { value: 'web', label: 'Web (FCM)' },
            ]}
            ariaLabel="Platform"
          />
        </Field>
      </div>
      <div className="flex justify-end">
        <button className="btn btn-primary" disabled={!token || test.isPending} onClick={() => test.mutate()}>
          {test.isPending ? 'Sending…' : 'Send test push'}
        </button>
      </div>
    </div>
  );
}
