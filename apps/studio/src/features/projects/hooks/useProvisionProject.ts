'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { platform, type SupabaseImportBody, type SupabaseImportPreview, type SupabaseImportSummary } from '@/shared/lib/api';
import { getErrorMessage } from '@/shared/lib/errors';
import { project } from '@/shared/lib/project';
import { isConnectionError } from '@/features/projects/lib/blueprint';
import type { ProvisionPhase } from '@/features/projects/components/ProvisionProgressPanel';

/**
 * Poll the freshly-provisioned project's admin API until it answers. A cold
 * container needs a bit to migrate and boot, so the window is generous.
 */
async function waitForProjectReady(id: string, attempts = 40, delayMs = 1500): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await platform.projectAdminReady(id)) return true;
    await new Promise(r => setTimeout(r, delayMs));
  }
  return false;
}

export interface ProvisionInput {
  name: string;
  domain?: string;
  storageDomain?: string;
  corsOrigins?: string;
  orgId?: string;
  /** Supabase import, run inside the new container once its API answers. */
  import?: SupabaseImportBody;
}

/**
 * The blocking flow behind the submit button: provision, wait for the new
 * container's API, seed operator defaults, then optionally preview and run the
 * Supabase import. The import only becomes possible after the project exists,
 * because it runs inside that container.
 */
export function useProvisionProject() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<ProvisionPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [preview, setPreview] = useState<SupabaseImportPreview | null>(null);
  const [summary, setSummary] = useState<SupabaseImportSummary | null>(null);

  const provision = async (input: ProvisionInput) => {
    setBusy(true);
    setError(null);
    setWarning(null);
    setPreview(null);
    setSummary(null);

    const importing = input.import;

    try {
      setPhase('provisioning');
      await platform.create({
        name: input.name,
        domain: input.domain,
        storageDomain: input.storageDomain,
        corsOrigins: input.corsOrigins,
        orgId: input.orgId,
      });

      // Fetch the operator defaults first, so the common no-import,
      // no-defaults path navigates away instantly.
      const { defaults } = await platform
        .getProjectDefaults()
        .catch(() => ({ defaults: {} as Record<string, Record<string, unknown>> }));
      const hasDefaults = Object.keys(defaults).length > 0;

      if (!importing && !hasDefaults) {
        router.push('/');
        return;
      }

      setPhase('waiting');
      if (!(await waitForProjectReady(input.name))) {
        // The project exists; only the follow-up steps could not start. Keep it
        // and let the user retry from inside the project.
        setWarning(
          importing
            ? 'Project created, but its API did not come online in time to import. Open the project and retry the Supabase import from there.'
            : 'Project created, but its API did not come online in time to apply the org defaults. Set them from the project settings.'
        );
        setPhase('done');
        return;
      }

      // Best-effort and isolated: a failing group never fails project creation.
      for (const [group, values] of Object.entries(defaults)) {
        try {
          await platform.applyProjectDefault(input.name, group, values);
        } catch {
          /* leave the group at its env fallback; the project still works */
        }
      }

      if (!importing) {
        setPhase('done');
        router.push('/');
        return;
      }

      // A preview failure is usually a bad connection string. Surface that now
      // rather than after a long import that fails the same way. Other preview
      // errors stay non-fatal, since the import step reports the real ones.
      setPhase('previewing');
      try {
        setPreview(await platform.importSupabasePreview(input.name, importing));
      } catch (previewError) {
        const message = getErrorMessage(previewError);
        if (isConnectionError(message)) {
          setError(`Couldn't reach the Supabase database: ${message}`);
          setWarning(
            'Project was created, but the Supabase import did not run. Check the connection string, then retry the import from the project.'
          );
          setPhase('idle');
          setBusy(false);
          return;
        }
      }

      setPhase('importing');
      setSummary(await platform.importSupabase(input.name, importing));
      setPhase('done');
    } catch (err) {
      setError(getErrorMessage(err));
      setPhase('idle');
      setBusy(false);
      return;
    }

    // On the import happy path we stay on the summary panel and let the user
    // click through. The non-import path has already navigated.
    setBusy(false);
  };

  return {
    provision,
    busy,
    phase,
    error,
    warning,
    preview,
    summary,
    openProject: (name: string) => {
      project.set(name);
      router.push(`/p/${encodeURIComponent(name)}/overview`);
    },
    cancel: () => router.push('/'),
  };
}
