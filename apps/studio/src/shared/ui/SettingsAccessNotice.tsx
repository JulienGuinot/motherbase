export function SettingsAccessNotice({
  editable,
  pending,
  className = 'mt-4',
}: {
  editable: boolean;
  pending: boolean;
  className?: string;
}) {
  if (editable || pending) return null;

  return (
    <p className={`${className} text-[11px]`} role="status" style={{ color: 'var(--text-mute)' }}>
      Read-only: your console role cannot change these settings.
    </p>
  );
}
