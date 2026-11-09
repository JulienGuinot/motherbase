// Response and routing helpers shared by every mock handler module.
import { http, HttpResponse, type HttpHandler, type HttpResponseResolver } from 'msw';

export const asJson = (value: unknown) => JSON.parse(JSON.stringify(value));
export const ok = (data: unknown) => HttpResponse.json(asJson({ data }));

export type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

// Register an admin handler under both the bare and project-scoped prefixes.
export function admin(method: Method, path: string, resolver: HttpResponseResolver): HttpHandler[] {
  return [
    http[method](`/api/admin${path}`, resolver),
    http[method](`/api/projects/:pid/admin${path}`, resolver),
  ];
}
