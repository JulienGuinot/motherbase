import crypto from 'crypto';

/**
 * Identity of this API process, and the boundary that makes it matter.
 *
 * Motherbase runs one API container per project, that is the deployment
 * everything here is written for, and it is why several subsystems keep their
 * state in memory rather than in a shared store.
 *
 * The schedulers are already safe across replicas: the realtime outbox and the
 * bucket-deletion queue both take database leases, so two processes cannot run
 * the same job twice. These do NOT have an equivalent, and are per-process:
 *
 *   - rate limiting          middlewares/rate-limit.ts (express-rate-limit MemoryStore)
 *   - custom rate-limit rules middlewares/custom-rate-limit.ts (FixedWindowStore)
 *   - the log buffer          lib/log-buffer.ts
 *   - request metrics + shield telemetry  lib/shield-telemetry.ts
 *   - realtime presence       services/realtime/*
 *
 * Run two replicas of one project and each enforces its own share of every
 * limit, holds a different slice of the logs, and sees a different presence set.
 * Nothing corrupts; the numbers just quietly stop meaning what they say.
 *
 * Rather than add Redis to a product whose whole premise is one VPS and no
 * moving parts, the constraint is made *observable*: every connection is tagged
 * with this id, so `countApiInstances()` can report when more than one process
 * is attached to the same database and the Shield screen can say so out loud.
 */

/** Short, per-process, regenerated on every boot. Not a secret. */
export const INSTANCE_ID = crypto.randomBytes(4).toString('hex');

/** Postgres `application_name` for this process. 63-byte limit, well clear of it. */
export const APPLICATION_NAME = `motherbase-api:${INSTANCE_ID}`;

/** Prefix shared by every API instance, used to find siblings. */
export const APPLICATION_NAME_PREFIX = 'motherbase-api:';

/** Subsystems whose state lives in this process and nowhere else. */
export const PER_INSTANCE_SUBSYSTEMS = [
  'rate limiting',
  'custom rate-limit rules',
  'log buffer',
  'request metrics',
  'shield telemetry',
  'realtime presence',
] as const;
