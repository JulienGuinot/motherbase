import { UsersTab } from '@/features/platform/components/UsersTab';
import { PageHeader, PageShell } from '@/shared/ui/PageHeader';

// Org > Team: console members and their roles. Wraps the existing users admin.
export default function Team() {
  return (
    <PageShell>
      <PageHeader
        size="md"
        title="Team"
        subtitle="People who can access this console and the projects they manage."
      />
      <UsersTab />
    </PageShell>
  );
}
