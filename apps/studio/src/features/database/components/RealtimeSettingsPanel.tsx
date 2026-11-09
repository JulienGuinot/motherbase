'use client';

import SettingsForm from '@/shared/ui/SettingsForm';

/** Subscribe-time constraints and outbox retention, both config-driven. */
export function RealtimeSettingsPanel() {
  return (
    <div className="space-y-6">
      <SettingsForm
        group="realtime.limits"
        description="Checked when a client subscribes. With private channels only, every channel is authorized by the policies in the Policies tab."
      />
      <SettingsForm
        group="realtime.retention"
        description="Prunes delivered and failed outbox events. Pending events are never removed."
      />
    </div>
  );
}
