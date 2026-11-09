'use client';

import { useLayoutEffect, type ReactNode } from 'react';
import { guardAutofill } from '@/shared/lib/autofill';
import { QueryProvider } from '@/shared/lib/query-provider';
import { ProjectCacheScope } from '@/shared/lib/project-cache-scope';
import { ErrorBoundary } from '@/shared/ui/ErrorBoundary';
import { ThemeProvider } from '@/shared/lib/theme-provider';
import { SidebarProvider } from '@/shared/lib/sidebar-provider';
import { SchemaProvider } from '@/shared/lib/schema-provider';
import { ToastProvider } from '@/shared/lib/toast-provider';
import { OrgProvider } from '@/shared/lib/org-provider';
import { ConfirmHost } from '@/shared/ui/ConfirmDialog';
import { ClientGate } from './client-gate';

export function Providers({ children }: { children: ReactNode }) {
  // Layout effect: marks the first inputs before the browser gets to fill them.
  useLayoutEffect(() => guardAutofill(document.body), []);

  return (
    <ClientGate>
      <ThemeProvider>
        <SidebarProvider>
          <SchemaProvider>
            <ToastProvider>
              {/* Inside ToastProvider: query failures are reported as toasts. */}
              <QueryProvider>
                {/* Inside QueryProvider, above everything that reads the cache:
                    the cache is dropped when the project changes. */}
                <ProjectCacheScope>
                  <OrgProvider>
                    <ErrorBoundary>{children}</ErrorBoundary>
                    {/* Single host for every confirmDialog() call in the app. */}
                    <ConfirmHost />
                  </OrgProvider>
                </ProjectCacheScope>
              </QueryProvider>
            </ToastProvider>
          </SchemaProvider>
        </SidebarProvider>
      </ThemeProvider>
    </ClientGate>
  );
}
