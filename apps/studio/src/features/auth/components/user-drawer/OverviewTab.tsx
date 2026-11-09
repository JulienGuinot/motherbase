import { AuthProviderBadges } from '@/features/auth/components/AuthProviderLogo';
import type { UpdateUserPayload } from '@/features/auth/api/users.api';
import type { UserDetail } from '@/features/auth/types';
import { DetailField } from '@/shared/ui/DetailField';
import { UserProfileForm } from '../UserProfileForm';

export function OverviewTab({
  user,
  loading,
  loaded,
  canEdit,
  onUpdate,
}: {
  user: UserDetail;
  loading: boolean;
  /** The full detail arrived; the profile form must not edit the list row's partial copy. */
  loaded: boolean;
  canEdit: boolean;
  onUpdate: (payload: UpdateUserPayload) => Promise<boolean>;
}) {
  return (
    <>
      <DetailField label="ID" value={user.id} mono />
      {loading ? <div className="shimmer h-32" /> : loaded && <UserProfileForm user={user} disabled={!canEdit} onSave={onUpdate} />}
      <div className="grid grid-cols-2 gap-4">
        <DetailField label="Role" value={user.role} />
        <DetailField label="Status" value={user.status} />
        <DetailField label="Email verified" value={user.emailVerified ? 'Yes' : 'No'} />
        {user.createdAt && <DetailField label="Created" value={new Date(user.createdAt).toLocaleString()} />}
      </div>
      <div>
        <div className="label mb-2">Providers</div>
        <div className="flex flex-wrap gap-1.5">
          <AuthProviderBadges ids={user.providers ?? []} empty="-" />
        </div>
      </div>
    </>
  );
}
