# Motherbase CLI

A Supabase-CLI-like operator CLI for **Motherbase**. It drives both the
**Platform Console** (account + multi-project lifecycle) and a **linked project's
admin API** through the Console proxy, or a single project API directly.

Zero runtime dependencies. Node ≥ 18 (uses built-in `fetch`, `readline`, `fs`,
`child_process` only).

```bash
node bin/motherbase.js --help          # auto-generated help
npm link                               # or: npm i -g @motherbase/cli
motherbase login --url https://console.example.com
motherbase link                        # pick a project → writes ./.motherbase/config.json
motherbase db tables
motherbase functions deploy --name hello --route hello --file ./hello.js
```

## Connection model

1. **Console / account**, `motherbase login [--url <consoleUrl>]` performs a real
   Console login (`POST /api/platform/login`) and stores the session token.
2. **Linked project**, `motherbase link [project]` records which project this
   directory targets. All resource commands then route through the Console proxy
   (`/api/projects/:id/admin/*`).
3. **Direct mode (CI / single stack)**. Set `MOTHERBASE_URL` +
   `MOTHERBASE_ADMIN_TOKEN` to talk straight to one project's `/api/admin/*`.

### Configuration files

**Global credentials**: `~/.motherbase/config.json` (contains tokens, written `0o600`):

```json
{
  "consoles": {
    "https://console.example.com": { "token": "…", "email": "you@example.com" }
  },
  "current": "https://console.example.com"
}
```

**Project link**: `./.motherbase/config.json` (versionable, non-secret):

```json
{ "consoleUrl": "https://console.example.com", "projectId": "my-app", "projectName": "my-app" }
```

### Resolution precedence

`flags > env > config`, per value:

| Value       | Flag              | Env                       | Config |
| ----------- | ----------------- | ------------------------- | ------ |
| console URL | `--url/-u`        | `MOTHERBASE_CONSOLE_URL`  | link / global `current` |
| token       | `--token`         | `MOTHERBASE_TOKEN`        | global console entry |
| project     | `--project/-p`    | `MOTHERBASE_PROJECT`      | link |
| direct API  | (| `MOTHERBASE_URL` + `MOTHERBASE_ADMIN_TOKEN` |) |

### Auth headers

The console session token is sent as `Authorization: Bearer <token>` on every
request. Console requests hit `/api/platform/*`; admin requests hit the proxy at
`/api/projects/:id/admin/*` (which validates the session, then injects its own
`X-Platform-Token` to the project). In direct mode the admin token is the Bearer.

## Commands

Global flags: `-o/--output pretty|json|yaml|env` (`--json` is `-o json`),
`--yes/-y`, `--project/-p/--project-ref <id>`, `--url/-u <consoleUrl>`,
`--token <t>`, `--workdir <dir>`, `--debug` (one stderr line per HTTP request),
`-h/--help`, `-v/--version`.

Commands follow the Supabase CLI's names. Where Motherbase already had its own
name, both work: `projects api-keys` / `keys list`, `backups list|restore` /
`db backups|restore`, `functions download` / `functions pull`, `db lint` /
`rls lint`, `gen types --lang <l>` / `gen types <l>`.

- **Connection**: `login`, `logout`, `whoami`, `link`, `unlink`, `status`
- **Orgs & projects (Console)**: `orgs list|create`, `projects list|create|start|stop|restart|update|rebuild|delete|logs|info|limits|api-keys`
- **Branches (Console)**: `branches create <name> [--with-data] [--git-branch <ref>]`, `branches list|get|update|delete|pause|unpause|reset|merge|rebase|switch <name>`
- **Domains (Console)**: `domains create --custom-hostname <host>`, `domains get|reverify|activate|delete`, `vanity-subdomains get|check-availability|activate --desired-subdomain <name>|delete`
- **Database access**: `network-restrictions get|update --db-allow-cidr <cidr> ...`, `ssl-enforcement get|update --enable-db-ssl-enforcement|--disable-db-ssl-enforcement`
- **Local self-host** (docker compose): `init`, `start`, `stop`, `deploy`, `logs`
- **Database**: `db push|pull|diff|reset|dump|seed`, `db tables|sql|backup|restore|backups|lint`, `backups list|restore`, `test db`
- **Database objects**: `db indexes list|create|drop`, `db types list|create|add-value|rename-value|drop`, `db roles list|create|alter|drop`, `db column-privileges list|grant|revoke`, `db publications list|create|alter|drop`
- **Postgres config**: `postgres-config get [--all]`, `postgres-config update --config k=v [--scope database|role|system] [--replace-existing-overrides]`, `postgres-config delete --config k1,k2`
- **Migrations**: `migration new|list|up|down|repair|squash|fetch|diff|get|create|apply|rollback` (`migrations` is an alias)
- **Import**: `import --from-supabase <conn> [--preview] [--no-data] [--no-auth]`
- **RLS**: `rls list|enable|disable`, `rls policy create|delete`
- **Users**: `users list|get|create|update|delete|reset-password|promote|demote|revoke-sessions|audit`
- **Storage**: `storage buckets list|create|delete`, `storage ls|cp|mv|rm [-r]` on `ss:///bucket/key` paths
- **Functions**: `functions list|get|new|deploy|pull|download|serve|delete|invoke|logs`
- **Secrets**: `secrets list|unset`, `secrets set NAME=VALUE ... [--env-file .env]`
- **Realtime**: `realtime config|channels`
- **Webhooks**: `webhooks list|create|delete|test`
- **Cron**: `cron list|create|delete|toggle`
- **Queues**: `queues list|enable|expose|create|drop|send|read|archive|purge`
- **Vault**: `vault list|enable|create|update|reveal|delete`
- **Wrappers**: `wrappers list|enable|create-server|drop-server|credentials|import|create-table|drop-table`
- **Config**: `config list|get|set`
- **Inspect**: `inspect db <query>`, `inspect report`, `inspect logs|stats|performance|index-advisor|requests|advisor|shield`
- **Codegen**: `gen types [--lang typescript|zod] [--schema public] [--local] [--output <file>] [--check]`
- **AI agents**: `mcp [--write]`
- **Keys**: `gen signing-key [--algorithm ES256|RS256|EdDSA] [--append]`, `gen bearer-jwt --sub <user> [--role] [--valid-for 1h]`, `gen keys [-o env]`
- **Shell**: `completion bash|zsh|fish` (e.g. `source <(motherbase completion bash)`)

Run `motherbase <group> -h` for per-group usage.

## Migrations and seeds

Local files, laid out like a Supabase project's `supabase/` directory:

```
motherbase/
  migrations/<version>_<name>.sql   `migration new <name>` stamps the version (UTC)
  seed.sql                          or db.seed.sql_paths in motherbase/config.json
  tests/*.sql                       pgTAP, for `motherbase test db`
```

A migration file may end with a `-- @down` line followed by the SQL that undoes
it; `migration down` needs one. The linked project keeps the history, keyed on
`version`, and the Studio Migrations page shows the same rows (origin `cli`,
`studio` or `git`).

```bash
motherbase migration list                 # LOCAL | REMOTE side by side
motherbase db push --dry-run              # then without, add --include-seed for the seeds
motherbase db pull                        # remote changes -> a new file, recorded as applied
motherbase db diff -f add_index           # the same diff, written as a new migration
motherbase migration repair 20260101120000 --status reverted
motherbase db reset --confirm             # backup, empty app schemas, replay migrations + seed
motherbase db dump -f schema.sql --schema-only
```

Each pushed file runs in its own transaction; a push stops at the first file
that fails, and nothing of that file is recorded. `db diff` replays the local
migrations into a throwaway database on the same server and compares tables,
columns and indexes: review what it writes. With no local migration yet, `db
pull` writes the remote schema itself, from `pg_dump`. `db dump` used to take a
server-side backup; that is `db backup` now.

## Type generation

Generate TypeScript definitions for the live schema, in the shape supabase-js
emits, so `createClient<Database>(url, key)` types every row, rejects unknown
columns and types `.rpc()` calls:

```bash
motherbase gen types typescript            # in a terminal: writes ./database.types.ts
motherbase gen types typescript > database.types.ts   # piped: prints the file
motherbase gen types typescript --schema shop --output src/shop.types.ts
```

The same `Database` also names the project's edge functions and buckets, under
`__InternalMotherbase`, so `client.functions.invoke('…')` and
`client.storage.from('…')` autocomplete with no extra generic. A name created
after the file was generated still compiles. Since they are part of the file,
adding a function or a bucket is drift for `--check` below.

With no `--output` the file goes to stdout and nothing else does, so the
redirect above produces a compiling file. `--local` skips the Console proxy and
talks to a project API on this machine (`MOTHERBASE_URL`, default
`http://localhost:5001`, with `MOTHERBASE_ADMIN_TOKEN`).

Gate CI on schema drift with `--check`, which never writes and exits non-zero
when the committed file differs from a fresh generation:

```bash
motherbase gen types typescript --check --output database.types.ts
```

## Storage paths

Objects are addressed as the Supabase CLI does, `ss:///<bucket>/<key>`, and
`-r` applies a command to everything under a prefix:

```bash
motherbase storage ls                                   # buckets
motherbase storage ls ss:///media/img                   # one level; -r for every key
motherbase storage cp ./logo.png ss:///media/img/       # upload (overwrites)
motherbase storage cp -r ./site ss:///web/v2            # upload a directory tree
motherbase storage cp -r ss:///web/v2 ./site-backup     # download a prefix
motherbase storage mv -r ss:///web/v2 ss:///web/live    # move within a bucket
motherbase storage rm -r ss:///web/old
```

Bulk commands send one request per object and stop at the first failure,
saying how many had already gone through. `mv` and in-bucket `cp` work within
one bucket. The older forms still work: `cp ./a.png bucket:` uploads with a
generated key, `cp <fileId> ./a.png` downloads and `rm <fileId>` deletes by id.

## Database inspection

`inspect db` runs the Supabase CLI's diagnostic queries against the linked
project, on its read-only SQL endpoint:

```bash
motherbase inspect db outliers        # slowest queries by total time
motherbase inspect db table-stats -o json
motherbase inspect report --output-dir reports   # one CSV per query in reports/<YYYY-MM-DD>/
```

The queries are `bloat`, `blocking`, `calls`, `db-stats`, `index-stats`,
`locks`, `long-running-queries`, `outliers`, `replication-slots`, `role-stats`,
`table-stats`, `traffic-profile` and `vacuum-stats`. The names Supabase has
deprecated (`cache-hit`, `index-usage`, `table-sizes`, `unused-indexes`, …)
still work and run the query that replaced them. `calls` and `outliers` read
`pg_stat_statements`: it is preloaded by the Motherbase Postgres image but has
to be created once per database (Studio > Database > Extensions, or
`motherbase db sql -e "create extension pg_stat_statements"`); `inspect report`
skips those two files until it is.

## MCP server

`motherbase mcp` serves this project to an AI agent over stdio:

```json
{ "mcpServers": { "motherbase": { "command": "npx", "args": ["@motherbase/cli", "mcp"] } } }
```

It exposes what the session can reach. With a linked project (or direct mode):
`list_tables`, `describe_table`, `list_policies`, `simulate_rls`,
`get_advisors`, `get_logs`, `generate_types`, `execute_sql` (read-only),
`get_project_url`, `get_publishable_keys`, `list_extensions`,
`list_migrations`, `list_edge_functions`, `get_edge_function`,
`list_storage_buckets` and `get_storage_config`. With a console login:
`list_organizations`, `get_organization`, `list_projects` and `get_project`.

Everything that changes something needs `--write`: `apply_migration`,
`execute_sql_write`, `deploy_edge_function`, `create_project`,
`pause_project` and `restore_project`. The names and arguments follow
Supabase's MCP server.

## Supabase migration

Preview a Supabase import without writing to Motherbase:

```bash
motherbase import --from-supabase "$SUPABASE_DB_URL" --preview --json
```

Run the import:

```bash
motherbase import --from-supabase "$SUPABASE_DB_URL" --yes
```

The importer moves the portable parts of a Supabase project: `public` schema, table data, RLS policies, and email/password users from `auth.users`. Storage objects are not copied. Use `--no-data` or `--no-auth` for partial imports.

## Tests

```bash
npm test        # node --test, mocked fetch, no network/DB
```
