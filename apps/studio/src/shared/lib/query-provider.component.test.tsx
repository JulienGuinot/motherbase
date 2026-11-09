import { AxiosError, AxiosHeaders } from 'axios';
import { useQuery } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { QueryProvider } from '@/shared/lib/query-provider';
import { ToastProvider } from '@/shared/lib/toast-provider';

function failing(status: number, data: unknown = {}): AxiosError {
  const error = new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_RESPONSE');
  error.response = {
    status,
    statusText: '',
    data,
    headers: new AxiosHeaders(),
    config: { headers: new AxiosHeaders() } as never,
  };
  return error;
}

function Probe({ error, queryKey }: { error: unknown; queryKey: string }) {
  const query = useQuery({
    queryKey: [queryKey],
    queryFn: () => Promise.reject(error),
    retry: false,
  });
  // A page that renders only its data: on failure it shows nothing at all,
  // which is exactly the case the toast has to cover.
  return <div>{query.data ? 'loaded' : ''}</div>;
}

function renderProbe(error: unknown, queryKey = 'bucket-tokens') {
  return render(
    <ToastProvider>
      <QueryProvider>
        <Probe error={error} queryKey={queryKey} />
      </QueryProvider>
    </ToastProvider>,
  );
}

describe('QueryProvider error reporting', () => {
  it('names the failed query and explains a server-side failure', async () => {
    renderProbe(failing(502));

    expect(await screen.findByText('Could not load bucket tokens')).toBeInTheDocument();
    expect(screen.getByText(/The project API did not respond/)).toBeInTheDocument();
  });

  it('shows the server message when there is one', async () => {
    renderProbe(failing(403, { message: 'Your role cannot read storage buckets' }));

    expect(await screen.findByText('Your role cannot read storage buckets')).toBeInTheDocument();
  });

  it('stays quiet on a 401, which the auth interceptor already handles', async () => {
    renderProbe(failing(401));

    await waitFor(() => expect(screen.queryByText(/Could not load/)).not.toBeInTheDocument());
  });
});
