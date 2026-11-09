'use client';

import { useState } from 'react';
import { inspectSupabaseConn, supabaseConnIsUsable } from '@/features/projects/supabase-conn';

const ALL_SECTIONS = {
  schema: true,
  data: true,
  auth: true,
  storage: true,
  edgeFunctions: true,
  secrets: true,
};

/**
 * The optional "import from Supabase" section of the new-project form. A URI
 * that cannot work (direct IPv6-only host, transaction pooler port) blocks the
 * flow here, rather than letting provisioning finish and the import fail.
 *
 * The two extra credentials are NOT blocking: storage objects, edge functions
 * and secrets live outside the database, and a section whose credential is
 * missing reports what it could not read instead of failing the import.
 */
export function useSupabaseImportOption() {
  const [enabled, setEnabled] = useState(false);
  const [connectionString, setConnectionString] = useState('');
  const [serviceRoleKey, setServiceRoleKey] = useState('');
  const [managementToken, setManagementToken] = useState('');
  const [include, setInclude] = useState({ ...ALL_SECTIONS });

  const connectionUsable = supabaseConnIsUsable(connectionString);
  const active = enabled && connectionUsable;
  const noneSelected = active && !Object.values(include).some(Boolean);

  return {
    enabled,
    setEnabled,
    connectionString,
    setConnectionString,
    serviceRoleKey,
    setServiceRoleKey,
    managementToken,
    setManagementToken,
    connectionUsable,
    issues: inspectSupabaseConn(connectionString),
    include,
    setIncludeKey: (key: keyof typeof include, value: boolean) =>
      setInclude(current => ({ ...current, [key]: value })),
    active,
    noneSelected,
    invalid: enabled && (!connectionUsable || noneSelected),
    /** The payload the provisioning flow needs, or undefined when not importing. */
    payload: active
      ? {
          connectionString: connectionString.trim(),
          include,
          serviceRoleKey: serviceRoleKey.trim() || undefined,
          managementToken: managementToken.trim() || undefined,
        }
      : undefined,
  };
}

export type SupabaseImportOption = ReturnType<typeof useSupabaseImportOption>;
