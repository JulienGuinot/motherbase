/** A project name is also the Docker project name, so it stays URL-safe. */
export const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export const sanitizeProjectName = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9-]/g, '');

/**
 * True when a message looks like the source database was unreachable or the
 * credentials were rejected, that is, a connection-string problem worth
 * surfacing immediately rather than after a doomed import attempt.
 */
export function isConnectionError(message: string): boolean {
  return /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|getaddrinfo|timeout|timed out|password authentication failed|SASL|no pg_hba|SSL|self.signed|could not connect|connection refused/i.test(
    message
  );
}
