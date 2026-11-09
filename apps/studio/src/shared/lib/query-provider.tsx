import { useState, type ReactNode } from 'react';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describeError, getErrorMessage } from '@/shared/lib/errors';
import { useToast } from '@/shared/lib/toast';

// Most pages render a query's data and nothing else, so a failed fetch would
// look exactly like "there is nothing here". This wires one toast to every
// query failure, so a request that did not come back always says so.
//
// Mutations mostly report through their own onError at the call site; the
// mutation cache below only covers the ones that declare none, so a failed
// write is never silent and a handled one is never toasted twice.

/** Failures the user should not be toasted about. */
function isSilent(info: ReturnType<typeof describeError>): boolean {
  // 401 is the token-refresh path in shared/lib/api: it either retries
  // transparently or bounces to the login screen, which is its own message.
  if (info.status === 401) return true;
  // A cancelled request is a navigation or a superseded fetch, not a failure.
  return info.message === 'The request was cancelled.';
}

export function QueryProvider({ children }: { children: ReactNode }) {
  const toast = useToast();

  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 10_000,
            refetchOnWindowFocus: false,
            // A dropped connection deserves a retry; a 4xx will not change.
            retry: (failureCount, error) => {
              const info = describeError(error);
              if (info.status !== undefined && info.status < 500) return false;
              return failureCount < 2;
            },
          },
        },
        queryCache: new QueryCache({
          onError: (error, query) => {
            const info = describeError(error);
            if (isSilent(info)) return;
            // A background refetch of data already on screen must not interrupt.
            if (query.state.data !== undefined) return;
            toast.push({
              kind: 'error',
              title: describeQuery(query.queryKey),
              // Same wording rule as every hand-written onError in the app.
              message: getErrorMessage(error),
            });
          },
        }),
        mutationCache: new MutationCache({
          onError: (error, _variables, _context, mutation) => {
            if (mutation.options.onError) return;
            const info = describeError(error);
            if (isSilent(info)) return;
            toast.push({
              kind: 'error',
              title: 'That action failed',
              // Same wording rule as every hand-written onError in the app.
              message: getErrorMessage(error),
            });
          },
        }),
      })
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** Name the thing that failed to load, using the query key's leading segment. */
function describeQuery(key: readonly unknown[]): string {
  const head = key.find(part => typeof part === 'string' && part.trim());
  if (typeof head !== 'string') return 'Could not load this page';
  const label = head
    .replace(/[-_.]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();
  return `Could not load ${label}`;
}
