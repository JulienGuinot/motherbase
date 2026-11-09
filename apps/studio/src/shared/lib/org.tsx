import { createContext, useContext } from 'react';
import type { Org } from '@/features/platform/api/orgs.api';

const STORAGE_KEY = 'console.activeOrg';
let activeOrgId: string | null = (() => {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
})();

export const activeOrg = {
  get: () => activeOrgId,
  set: (id: string | null) => {
    activeOrgId = id;
    try {
      if (id) localStorage.setItem(STORAGE_KEY, id);
      else localStorage.removeItem(STORAGE_KEY);
    } catch { /* ignore */ }
  },
};

export interface OrgContextValue {
  orgs: Org[];
  activeOrgId: string | null;
  active: Org | null;
  loading: boolean;
  setActiveOrg: (id: string) => void;
  reload: () => Promise<void>;
}

export const OrgContext = createContext<OrgContextValue>({
  orgs: [], activeOrgId: null, active: null, loading: true,
  setActiveOrg: () => {}, reload: async () => {},
});

export const useOrgs = () => useContext(OrgContext);
