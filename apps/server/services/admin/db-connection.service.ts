import BaseContext from '../../context/base-context';
import { env } from '../../config/env';

export interface DbConnectionInfo {
  /** Postgres user, database and password, as configured for this project. */
  user: string;
  database: string;
  password: string;
  /** Hostname other containers on the project network use. */
  internalHost: string;
  internalPort: number;
  /** Host port the database is published on, when one was allocated. */
  hostPort: number | null;
  /** Interface that port is bound to. `127.0.0.1` means tunnel-only. */
  bind: string;
  /** True when `bind` makes the port reachable from outside the host. */
  publiclyBound: boolean;
  /** Ready-to-paste URI for a tool running inside the project network. */
  internalUri: string;
}

/**
 * How to reach this project's PostgreSQL with something that is not the REST
 * API: an ORM, psql, a migration tool, a BI client.
 *
 * Everything here is derived from the server's own environment rather than
 * stored, so it cannot drift from what the container is actually connected to.
 * The password is included on purpose: the route is admin-only and mapped to the
 * `secrets.manage` capability, and a connection string without it is a riddle,
 * not a connection string.
 */
export class DbConnectionService extends BaseContext {
  get(): DbConnectionInfo {
    const url = new URL(env.DATABASE_URL);
    const hostPort = this.parsePort(process.env.DB_PORT);
    const bind = (process.env.DB_BIND || '').trim() || '127.0.0.1';
    const user = decodeURIComponent(url.username || 'postgres');
    const password = decodeURIComponent(url.password || '');
    const database = url.pathname.replace(/^\//, '') || 'app';
    const internalHost = url.hostname;
    const internalPort = Number(url.port) || 5432;

    return {
      user,
      database,
      password,
      internalHost,
      internalPort,
      hostPort,
      bind,
      // Anything that is not a loopback address exposes the port beyond this
      // machine. Treated as a spectrum of one: if it is not localhost, warn.
      publiclyBound: hostPort !== null && bind !== '127.0.0.1' && bind !== 'localhost' && bind !== '::1',
      internalUri: `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${internalHost}:${internalPort}/${database}`,
    };
  }

  private parsePort(raw: string | undefined): number | null {
    const port = Number((raw ?? '').trim());
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  }
}
