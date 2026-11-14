/**
 * The loopback URL a dev-mode project's API is published on, or null outside
 * dev mode. Only deploy/docker-compose.dev-multi.yml sets API_PORT: there the
 * project's own domain is `<name>.localhost`, which Node cannot resolve, so
 * this is the URL that works from both a browser and server-side code.
 */
export function localApiUrl(rawPort: string | undefined): string | null {
  const port = Number((rawPort ?? '').trim());
  return Number.isInteger(port) && port > 0 && port < 65536 ? `http://localhost:${port}` : null;
}
