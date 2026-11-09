import { AxiosError, AxiosHeaders } from 'axios';
import { describe, expect, it } from 'vitest';
import { describeError, getErrorMessage } from '@/shared/lib/errors';

function httpError(status: number, data: unknown, headers: Record<string, string> = {}): AxiosError {
  const error = new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_RESPONSE');
  error.response = {
    status,
    statusText: '',
    data,
    headers: new AxiosHeaders(headers),
    config: { headers: new AxiosHeaders() } as never,
  };
  return error;
}

function networkError(code: string, message = 'Network Error'): AxiosError {
  return new AxiosError(message, code);
}

describe('getErrorMessage', () => {
  it('prefers the server envelope message', () => {
    const error = httpError(400, { status: 0, code: 'BAD_REQUEST', message: 'Table name already taken' });

    expect(getErrorMessage(error)).toBe('Table name already taken');
  });

  it('never leaks the axios status string when the body has no message', () => {
    const error = httpError(502, '');

    const message = getErrorMessage(error);
    expect(message).not.toContain('status code');
    expect(message).toContain('The project API did not respond.');
    expect(message).toContain('Check that the project is running');
  });

  it('ignores a proxy HTML error page', () => {
    const error = httpError(502, '<html><body><h1>502 Bad Gateway</h1></body></html>');

    expect(getErrorMessage(error)).not.toContain('<');
  });

  it('explains a connection failure instead of saying Network Error', () => {
    expect(getErrorMessage(networkError('ERR_NETWORK'))).toBe(
      'Could not reach the server. Check your connection and that the backend is running, then retry.'
    );
  });

  it('distinguishes a timeout from an unreachable server', () => {
    expect(getErrorMessage(networkError('ECONNABORTED', 'timeout of 5000ms exceeded'))).toContain(
      'did not respond in time'
    );
  });

  it('reports a cancelled request as cancelled', () => {
    expect(getErrorMessage(networkError('ERR_CANCELED', 'canceled'))).toBe('The request was cancelled.');
  });

  it('joins validation error lists so no field is hidden', () => {
    const error = httpError(422, { errors: [{ message: 'email is required' }, 'password is too short'] });

    expect(getErrorMessage(error)).toBe('email is required. password is too short');
  });

  it('reads a nested error object', () => {
    const error = httpError(500, { error: { message: 'relation "users" does not exist' } });

    expect(getErrorMessage(error)).toBe('relation "users" does not exist');
  });

  it('truncates a dumped stack trace rather than filling a toast', () => {
    const error = httpError(500, { message: 'x'.repeat(900) });

    const message = getErrorMessage(error);
    expect(message.length).toBeLessThanOrEqual(403);
    expect(message.endsWith('...')).toBe(true);
  });

  it('falls back to the caller message for a non-axios throw', () => {
    expect(getErrorMessage(null, 'Could not save the policy')).toBe('Could not save the policy');
    expect(getErrorMessage(new Error('boom'))).toBe('boom');
  });
});

describe('describeError', () => {
  it('surfaces code, status and hint separately', () => {
    const error = httpError(403, { code: 'PASSWORD_CHANGE_REQUIRED', message: 'Password change required' });

    expect(describeError(error)).toMatchObject({
      status: 403,
      code: 'PASSWORD_CHANGE_REQUIRED',
      message: 'Password change required',
      hint: 'You must set a new password before continuing.',
      offline: false,
    });
  });

  it('turns Retry-After into a concrete wait', () => {
    const error = httpError(429, {}, { 'retry-after': '30' });

    expect(describeError(error)).toMatchObject({
      retryAfterSeconds: 30,
      hint: 'Retry in 30 seconds.',
    });
  });

  it('flags responseless failures as offline', () => {
    expect(describeError(networkError('ERR_NETWORK')).offline).toBe(true);
    expect(describeError(httpError(500, {})).offline).toBe(false);
  });
});
