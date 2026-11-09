'use client';

import { useQuery } from '@tanstack/react-query';
import { platform } from '@/shared/lib/api';
import { describeError } from '@/shared/lib/errors';
import { useProjectId } from '@/shared/hooks/useRouteParam';

/**
 * One answer to "can we talk to this project", for everything that needs it:
 * the shell gate that holds pages closed, and the health indicators on Overview
 * and Connect.
 *
 * There used to be a second, separate probe for the indicators (
 * `GET /api/health-check`) which was never rewritten to the project by the api
 * client (the interceptor only rewrites `/admin` and `/rest/v1`) and which the
 * console server does not implement. It answered 404 on every poll, forever.
 * Connect read that as "API offline" and always showed a red dot; Overview
 * treated the resulting `undefined` as healthy and always showed a green one.
 * Two indicators, both structurally incapable of being right.
 *
 * The console's readiness probe subsumes it: it requires a 2xx from the
 * project's own `/api/health-check`, which returns 503 when the database is
 * unreachable. So `ready` already means "API answered and its database is up".
 */
export function useProjectReadiness({ poll = true }: { poll?: boolean } = {}) {
  const id = useProjectId();

  const query = useQuery({
    queryKey: ['project-ready', id],
    queryFn: () => platform.projectReady(id!),
    enabled: Boolean(id),
    // A project that is still booting is the expected case, not a failure.
    retry: false,
    // A 4xx (no access, no such project) will not change by asking again, and
    // each repeat would be one more error toast.
    refetchInterval: query => {
      const status = query.state.error ? describeError(query.state.error).status : undefined;
      if (status !== undefined && status < 500) return false;
      return poll || !query.state.data?.ready ? 2000 : false;
    },
  });

  return {
    data: query.data,
    isError: query.isError,
    errorStatus: query.error ? describeError(query.error).status : undefined,
  };
}
