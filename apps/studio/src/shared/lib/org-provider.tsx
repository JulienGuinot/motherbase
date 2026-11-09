import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { orgsApi, type Org } from '@/features/platform/api/orgs.api';
import { auth } from '@/shared/lib/auth';
import { activeOrg, OrgContext } from '@/shared/lib/org';

export function OrgProvider({ children }: { children: ReactNode }) {
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [activeId, setActiveId] = useState<string | null>(activeOrg.get());
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!auth.isAuthed() || auth.mustChangePassword()) {
      setOrgs([]);
      setLoading(false);
      return;
    }
    try {
      const list = await orgsApi.list();
      setOrgs(list);
      const stored = activeOrg.get();
      const valid = stored && list.some(org => org.id === stored) ? stored : (list[0]?.id ?? null);
      activeOrg.set(valid);
      setActiveId(valid);
    } catch {
      setOrgs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => { void reload(); }, 0);
    return () => window.clearTimeout(timeout);
  }, [reload]);

  const setActiveOrg = useCallback((id: string) => {
    activeOrg.set(id);
    setActiveId(id);
  }, []);

  const active = orgs.find(org => org.id === activeId) ?? null;

  return (
    <OrgContext.Provider value={{ orgs, activeOrgId: activeId, active, loading, setActiveOrg, reload }}>
      {children}
    </OrgContext.Provider>
  );
}
