/**
 * Web storage that never throws. Storage is absent during SSR and can throw in
 * private windows or with site data blocked; a preference that cannot be
 * remembered must not take the page down with it.
 */
function safe(area: 'localStorage' | 'sessionStorage') {
  return {
    get(key: string): string | null {
      try { return globalThis[area].getItem(key); } catch { return null; }
    },
    set(key: string, value: string): void {
      try { globalThis[area].setItem(key, value); } catch { /* not remembered */ }
    },
  };
}

export const safeStorage = safe('localStorage');
export const safeSessionStorage = safe('sessionStorage');
