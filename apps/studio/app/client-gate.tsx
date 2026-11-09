'use client';

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';

const MOCK = process.env.NEXT_PUBLIC_MOCK === '1';

const subscribe = () => () => {};

/** False while rendering on the server, true once hydrated. */
function useIsClient(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  );
}

/**
 * Nothing below this renders on the server. The studio is a browser
 * application: its providers read localStorage in their state initialisers, so
 * server rendering them would throw. Gating once here beats guarding every
 * provider, and the rendered result is the same empty shell the SPA shipped.
 *
 * In mock mode (npm run studio:mock) the gate also waits for MSW: a fake token
 * is seeded so the auth guards pass without a backend, and nothing renders
 * until the worker intercepts, otherwise the first queries escape the mock.
 */
export function ClientGate({ children }: { children: ReactNode }) {
  const isClient = useIsClient();
  const [mockReady, setMockReady] = useState(!MOCK);

  useEffect(() => {
    if (!MOCK) return;
    let cancelled = false;

    void (async () => {
      // MSW reuses any existing registration for this script URL and never
      // re-registers, so a browser that already ran mock mode would keep the
      // old /studio/ scope forever and the widening below would be a no-op.
      // Drop anything narrower than the origin first.
      const stale = await navigator.serviceWorker.getRegistrations();
      await Promise.all(
        stale.filter(reg => reg.scope !== `${location.origin}/`).map(reg => reg.unregister())
      );

      const { worker } = await import('@/mocks/browser');
      // The worker URL carries the basePath, like every other public asset. Its
      // scope has to be widened back to the origin: served from /studio/ it
      // would not even control /studio itself (no trailing slash), and the API
      // lives at /api, outside the studio mount. next.config sends the
      // Service-Worker-Allowed header that permits this.
      await worker.start({
        onUnhandledRequest: 'warn',
        serviceWorker: { url: '/studio/mockServiceWorker.js', options: { scope: '/' } },
      });
      if (!localStorage.getItem('console.accessToken')) {
        localStorage.setItem('console.accessToken', 'mock-access');
        localStorage.setItem('console.refreshToken', 'mock-refresh');
      }
      if (!cancelled) setMockReady(true);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return isClient && mockReady ? <>{children}</> : null;
}
