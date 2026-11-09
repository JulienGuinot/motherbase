-- The Git repository a project imports its migrations from.
--
-- One row by construction: `id` defaults to 'default' and is the primary key, so
-- a second "connect a repo" is a constraint violation instead of a second row
-- that two webhook deliveries would sync from in parallel.
--
-- `accessToken` and `webhookSecret` hold AES-GCM ciphertext produced by
-- crypto.helper, not plaintext. Both are revoked on disconnect.
CREATE TABLE IF NOT EXISTS platform.git_repo_links (
  id                text PRIMARY KEY DEFAULT 'default',
  provider          text NOT NULL DEFAULT 'github',
  "accessToken"     text NOT NULL,
  "accountLogin"    text NOT NULL,
  owner             text,
  repo              text,
  branch            text NOT NULL DEFAULT 'main',
  "migrationsPath"  text NOT NULL DEFAULT 'migrations',
  "webhookId"       text,
  "webhookSecret"   text,
  "lastSyncAt"      timestamptz,
  "lastSyncStatus"  text,
  "lastSyncMessage" text,
  "lastSyncSha"     text,
  "createdAt"       timestamptz NOT NULL DEFAULT now(),
  "updatedAt"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT git_repo_links_sync_status_check
    CHECK ("lastSyncStatus" IS NULL OR "lastSyncStatus" IN ('ok', 'failed')),
  -- Owner and repo are set together or not at all. "Authorized but not linked"
  -- is a real state (OAuth done, repo not picked yet); "half a repo" is not.
  CONSTRAINT git_repo_links_repo_pair_check
    CHECK ((owner IS NULL) = (repo IS NULL))
);

-- The data plane has no business reading an OAuth token, encrypted or not.
REVOKE ALL ON platform.git_repo_links FROM anon, authenticated, service_role;
