'use strict';

// The `inspect db` query set, ported from the Supabase CLI
// (apps/cli/src/commands/inspect/db/*/*.query.ts) so the same subcommand
// answers the same question with the same columns.
//
// Every query runs through the admin API's POST /sql/readonly, which executes it
// in a READ ONLY transaction and cannot bind parameters. The deltas from
// upstream all follow from that, or from running on a plain Postgres rather than
// the supabase/postgres image:
//
//   - `$1` (the internal schemas to skip) is inlined as a text[] literal, and
//     `$2` (the database name) is `current_database()`.
//   - pg_stat_statements is referenced unqualified: `CREATE EXTENSION` puts it on
//     the search_path, not in an `extensions` schema. It is preloaded by our
//     Postgres image but may not be created in a given database, so the queries
//     that need it are flagged `needsStatStatements` for a clearer error.
//   - numeric results are cast to text. The readonly endpoint serialises a
//     Prisma Decimal as its internal `{ s, e, d }` fields, not as a number.
//   - vacuum-stats prints `No stats` in SQL, where upstream post-processes the
//     rendered cell.

// Schemas the queries exclude, verbatim from upstream's inspect-schemas.ts.
const INTERNAL_SCHEMAS = [
  'information_schema',
  'pg_*',
  '_analytics', '_realtime', '_supavisor', 'auth', 'etl', 'extensions', 'pgbouncer',
  'realtime', 'storage', 'supabase_functions', 'supabase_migrations',
  'cron', 'dbdev', 'graphql', 'graphql_public', 'net', 'pgmq', 'pgsodium',
  'pgsodium_masks', 'pgtle', 'repack', 'tiger', 'tiger_data', 'timescaledb_*',
  '_timescaledb_*', 'topology', 'vault',
];

// A schema name as a LIKE pattern: `_` and `\` are literal, `*` is the wildcard.
function likePattern(schema) {
  return schema.replace(/[\\_*]/g, char => (char === '*' ? '%' : `\\${char}`));
}

const IGNORED_SCHEMAS = `'{${INTERNAL_SCHEMAS.map(likePattern).join(',')}}'::text[]`;

// Column shorthand: `[key, label]` pairs, in display order.
const cols = pairs => pairs.map(([key, label]) => ({ key, label }));

// pg_stat_statements' timing columns were renamed in PG17; to_jsonb reads
// whichever this server has. Shared by `calls` and `outliers`.
const SYNC_IO_TIME = `(
    interval '1 millisecond' * (
      COALESCE((to_jsonb(s) ->> 'shared_blk_read_time')::double precision, (to_jsonb(s) ->> 'blk_read_time')::double precision, 0)
      + COALESCE((to_jsonb(s) ->> 'shared_blk_write_time')::double precision, (to_jsonb(s) ->> 'blk_write_time')::double precision, 0)
    )
  )::text AS sync_io_time`;

const QUERIES = {
  bloat: {
    summary: 'Estimate space wasted by dead tuples in tables and indexes',
    columns: cols([['type', 'Type'], ['name', 'Name'], ['bloat', 'Bloat'], ['waste', 'Waste']]),
    sql: `WITH constants AS (
  SELECT current_setting('block_size')::numeric AS bs, 23 AS hdr, 4 AS ma
), bloat_info AS (
  SELECT
    ma,bs,schemaname,tablename,
    (datawidth+(hdr+ma-(case when hdr%ma=0 THEN ma ELSE hdr%ma END)))::numeric AS datahdr,
    (maxfracsum*(nullhdr+ma-(case when nullhdr%ma=0 THEN ma ELSE nullhdr%ma END))) AS nullhdr2
  FROM (
    SELECT
      schemaname, tablename, hdr, ma, bs,
      SUM((1-null_frac)*avg_width) AS datawidth,
      MAX(null_frac) AS maxfracsum,
      hdr+(
        SELECT 1+count(*)/8
        FROM pg_stats s2
        WHERE null_frac<>0 AND s2.schemaname = s.schemaname AND s2.tablename = s.tablename
      ) AS nullhdr
    FROM pg_stats s, constants
    GROUP BY 1,2,3,4,5
  ) AS foo
), table_bloat AS (
  SELECT
    schemaname, tablename, cc.relpages, bs,
    CEIL((cc.reltuples*((datahdr+ma-
      (CASE WHEN datahdr%ma=0 THEN ma ELSE datahdr%ma END))+nullhdr2+4))/(bs-20::float)) AS otta
  FROM bloat_info
  JOIN pg_class cc ON cc.relname = bloat_info.tablename
  JOIN pg_namespace nn ON cc.relnamespace = nn.oid AND nn.nspname = bloat_info.schemaname
  WHERE NOT nn.nspname LIKE ANY(${IGNORED_SCHEMAS})
), index_bloat AS (
  SELECT
    schemaname, tablename, bs,
    COALESCE(c2.relname,'?') AS iname, COALESCE(c2.reltuples,0) AS ituples, COALESCE(c2.relpages,0) AS ipages,
    COALESCE(CEIL((c2.reltuples*(datahdr-12))/(bs-20::float)),0) AS iotta
  FROM bloat_info
  JOIN pg_class cc ON cc.relname = bloat_info.tablename
  JOIN pg_namespace nn ON cc.relnamespace = nn.oid AND nn.nspname = bloat_info.schemaname
  JOIN pg_index i ON indrelid = cc.oid
  JOIN pg_class c2 ON c2.oid = i.indexrelid
  WHERE NOT nn.nspname LIKE ANY(${IGNORED_SCHEMAS})
), bloat_summary AS (
  SELECT
    'table' as type,
    FORMAT('%I.%I', schemaname, tablename) AS name,
    ROUND(CASE WHEN otta=0 THEN 0.0 ELSE table_bloat.relpages/otta::numeric END,1) AS bloat,
    CASE WHEN relpages < otta THEN '0' ELSE (bs*(table_bloat.relpages-otta)::bigint)::bigint END AS raw_waste
  FROM table_bloat
    UNION
  SELECT
    'index' as type,
    FORMAT('%I.%I::%I', schemaname, tablename, iname) AS name,
    ROUND(CASE WHEN iotta=0 OR ipages=0 THEN 0.0 ELSE ipages/iotta::numeric END,1) AS bloat,
  CASE WHEN ipages < iotta THEN '0' ELSE (bs*(ipages-iotta))::bigint END AS raw_waste
  FROM index_bloat
)
SELECT type, name, bloat::text AS bloat, pg_size_pretty(raw_waste) as waste
FROM bloat_summary
ORDER BY raw_waste DESC, bloat_summary.bloat DESC`,
  },

  blocking: {
    summary: 'Queries holding locks and the queries waiting on them',
    columns: cols([
      ['blocked_pid', 'blocked pid'], ['blocking_statement', 'blocking statement'],
      ['blocking_duration', 'blocking duration'], ['blocking_pid', 'blocking pid'],
      ['blocked_statement', 'blocked statement'], ['blocked_duration', 'blocked duration'],
    ]),
    sql: `SELECT
  bl.pid AS blocked_pid,
  ka.query AS blocking_statement,
  age(now(), ka.query_start)::text AS blocking_duration,
  kl.pid AS blocking_pid,
  a.query AS blocked_statement,
  age(now(), a.query_start)::text AS blocked_duration
FROM pg_catalog.pg_locks bl
JOIN pg_catalog.pg_stat_activity a
  ON bl.pid = a.pid
JOIN pg_catalog.pg_locks kl
JOIN pg_catalog.pg_stat_activity ka
  ON kl.pid = ka.pid
  ON bl.transactionid = kl.transactionid AND bl.pid != kl.pid
WHERE NOT bl.granted`,
  },

  calls: {
    summary: 'Queries ordered by number of calls (pg_stat_statements)',
    needsStatStatements: true,
    columns: cols([
      ['query', 'Query'], ['total_exec_time', 'Total Execution Time'],
      ['prop_exec_time', 'Proportion of total exec time'], ['ncalls', 'Number Calls'],
      ['sync_io_time', 'Sync IO time'],
    ]),
    sql: `SELECT
  query,
  (interval '1 millisecond' * total_exec_time)::text AS total_exec_time,
  to_char((total_exec_time/sum(total_exec_time) OVER()) * 100, 'FM90D0') || '%'  AS prop_exec_time,
  to_char(calls, 'FM999G999G999G999G990') AS ncalls,
  ${SYNC_IO_TIME}
FROM pg_stat_statements s
ORDER BY calls DESC
LIMIT 10`,
  },

  'db-stats': {
    summary: 'Database size, cache hit rates and WAL size',
    columns: cols([
      ['name', 'Name'], ['database_size', 'Database Size'], ['total_index_size', 'Total Index Size'],
      ['total_table_size', 'Total Table Size'], ['total_toast_size', 'Total Toast Size'],
      ['time_since_stats_reset', 'Time Since Stats Reset'], ['index_hit_rate', 'Index Hit Rate'],
      ['table_hit_rate', 'Table Hit Rate'], ['wal_size', 'WAL Size'],
    ]),
    // Upstream reads pg_stat_statements_info unconditionally, which would fail
    // the whole summary on a database without the extension. query_to_xml
    // defers the reference to run time, and the CASE never reaches it when the
    // view does not exist.
    sql: `WITH total_objects AS (
  SELECT c.relkind, pg_size_pretty(SUM(pg_relation_size(c.oid))) AS size
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('i', 'r', 't') AND NOT n.nspname LIKE ANY(${IGNORED_SCHEMAS})
  GROUP BY c.relkind
), cache_hit AS (
  SELECT
    'i' AS relkind,
    ROUND(SUM(idx_blks_hit)::numeric / nullif(SUM(idx_blks_hit + idx_blks_read), 0), 2) AS ratio
  FROM pg_statio_user_indexes
  WHERE NOT schemaname LIKE ANY(${IGNORED_SCHEMAS})
    UNION
  SELECT
    't' AS relkind,
    ROUND(
      SUM(COALESCE((to_jsonb(s) ->> 'rel_blks_hit')::bigint, (to_jsonb(s) ->> 'heap_blks_hit')::bigint, 0))::numeric
      / nullif(SUM(
          COALESCE((to_jsonb(s) ->> 'rel_blks_hit')::bigint, (to_jsonb(s) ->> 'heap_blks_hit')::bigint, 0)
          + COALESCE((to_jsonb(s) ->> 'rel_blks_read')::bigint, (to_jsonb(s) ->> 'heap_blks_read')::bigint, 0)
        ), 0),
      2
    ) AS ratio
  FROM pg_statio_user_tables s
  WHERE NOT schemaname LIKE ANY(${IGNORED_SCHEMAS})
)
SELECT
  current_database() AS name,
  pg_size_pretty(pg_database_size(current_database())) AS database_size,
  COALESCE((SELECT size FROM total_objects WHERE relkind = 'i'), '0 bytes') AS total_index_size,
  COALESCE((SELECT size FROM total_objects WHERE relkind = 'r'), '0 bytes') AS total_table_size,
  COALESCE((SELECT size FROM total_objects WHERE relkind = 't'), '0 bytes') AS total_toast_size,
  CASE WHEN to_regclass('pg_stat_statements_info') IS NULL THEN 'N/A' ELSE COALESCE((xpath(
    '/row/age/text()',
    query_to_xml('SELECT (now() - stats_reset)::text AS age FROM pg_stat_statements_info', false, true, '')
  ))[1]::text, 'N/A') END AS time_since_stats_reset,
  (SELECT COALESCE(ratio::text, 'N/A') FROM cache_hit WHERE relkind = 'i') AS index_hit_rate,
  (SELECT COALESCE(ratio::text, 'N/A') FROM cache_hit WHERE relkind = 't') AS table_hit_rate,
  COALESCE((SELECT pg_size_pretty(SUM(size)) FROM pg_ls_waldir()), '0 bytes') AS wal_size`,
  },

  'index-stats': {
    summary: 'Index size, usage, scan counts and unused indexes',
    columns: cols([
      ['name', 'Name'], ['table', 'Table'], ['columns', 'Columns'], ['size', 'Size'],
      ['percent_used', 'Percent used'], ['index_scans', 'Index scans'], ['seq_scans', 'Seq scans'],
      ['unused', 'Unused'],
    ]),
    sql: `WITH idx_sizes AS (
  SELECT
    i.indexrelid AS oid,
    FORMAT('%I.%I', n.nspname, c.relname) AS name,
    FORMAT('%I.%I', tn.nspname, tc.relname) AS table_name,
    (
      SELECT STRING_AGG(pg_get_indexdef(i.indexrelid, ord::int, false), ',' ORDER BY ord)
      FROM unnest(i.indkey::int[]) WITH ORDINALITY AS k(attnum, ord)
    ) AS columns,
    pg_relation_size(i.indexrelid) AS index_size_bytes
  FROM pg_stat_user_indexes ui
  JOIN pg_index i ON ui.indexrelid = i.indexrelid
  JOIN pg_class c ON ui.indexrelid = c.oid
  JOIN pg_namespace n ON c.relnamespace = n.oid
  JOIN pg_class tc ON tc.oid = i.indrelid
  JOIN pg_namespace tn ON tn.oid = tc.relnamespace
  WHERE NOT n.nspname LIKE ANY(${IGNORED_SCHEMAS})
),
idx_usage AS (
  SELECT indexrelid AS oid, idx_scan::bigint AS idx_scans
  FROM pg_stat_user_indexes ui
  WHERE NOT schemaname LIKE ANY(${IGNORED_SCHEMAS})
),
seq_usage AS (
  SELECT relid AS oid, seq_scan::bigint AS seq_scans
  FROM pg_stat_user_tables
  WHERE NOT schemaname LIKE ANY(${IGNORED_SCHEMAS})
),
usage_pct AS (
  SELECT
    u.oid,
    CASE
      WHEN u.idx_scans IS NULL OR u.idx_scans = 0 THEN 0
      WHEN s.seq_scans IS NULL THEN 100
      ELSE ROUND(100.0 * u.idx_scans / (s.seq_scans + u.idx_scans), 1)
    END AS percent_used
  FROM idx_usage u
  LEFT JOIN seq_usage s ON s.oid = u.oid
)
SELECT
  s.name,
  s.table_name AS "table",
  s.columns,
  pg_size_pretty(s.index_size_bytes) AS size,
  COALESCE(up.percent_used, 0)::text || '%' AS percent_used,
  COALESCE(u.idx_scans, 0) AS index_scans,
  COALESCE(sq.seq_scans, 0) AS seq_scans,
  CASE WHEN COALESCE(u.idx_scans, 0) = 0 THEN true ELSE false END AS unused
FROM idx_sizes s
LEFT JOIN idx_usage u ON u.oid = s.oid
LEFT JOIN seq_usage sq ON sq.oid = s.oid
LEFT JOIN usage_pct up ON up.oid = s.oid
ORDER BY s.index_size_bytes DESC`,
  },

  locks: {
    summary: 'Queries holding an exclusive lock on a relation',
    columns: cols([
      ['pid', 'pid'], ['relname', 'relname'], ['transactionid', 'transaction id'],
      ['granted', 'granted'], ['stmt', 'stmt'], ['age', 'age'],
    ]),
    sql: `SELECT
  pg_stat_activity.pid,
  COALESCE(pg_class.relname, 'null') AS relname,
  COALESCE(pg_locks.transactionid::text, 'null') AS transactionid,
  pg_locks.granted,
  pg_stat_activity.query AS stmt,
  age(now(), pg_stat_activity.query_start)::text AS age
FROM pg_stat_activity, pg_locks LEFT OUTER JOIN pg_class ON (pg_locks.relation = pg_class.oid)
WHERE pg_stat_activity.query <> '<insufficient privilege>'
AND pg_locks.pid = pg_stat_activity.pid
AND pg_locks.mode = 'ExclusiveLock'
ORDER BY query_start`,
  },

  'long-running-queries': {
    summary: 'Queries running for longer than five minutes',
    columns: cols([['pid', 'pid'], ['duration', 'Duration'], ['query', 'Query']]),
    sql: `SELECT
  pid,
  age(now(), pg_stat_activity.query_start)::text AS duration,
  query AS query
FROM pg_stat_activity
WHERE pg_stat_activity.query <> ''::text
  AND state <> 'idle'
  AND age(now(), pg_stat_activity.query_start) > interval '5 minutes'
ORDER BY age(now(), pg_stat_activity.query_start) DESC`,
  },

  outliers: {
    summary: 'Queries ordered by total execution time (pg_stat_statements)',
    needsStatStatements: true,
    columns: cols([
      ['query', 'Query'], ['total_exec_time', 'Execution Time'],
      ['prop_exec_time', 'Proportion of exec time'], ['ncalls', 'Number Calls'],
      ['sync_io_time', 'Sync IO time'],
    ]),
    sql: `SELECT
  (interval '1 millisecond' * total_exec_time)::text AS total_exec_time,
  to_char((total_exec_time/sum(total_exec_time) OVER()) * 100, 'FM90D0') || '%'  AS prop_exec_time,
  to_char(calls, 'FM999G999G999G990') AS ncalls,
  ${SYNC_IO_TIME},
  query
FROM pg_stat_statements s WHERE userid = (SELECT usesysid FROM pg_user WHERE usename = current_user LIMIT 1)
ORDER BY total_exec_time DESC
LIMIT 10`,
  },

  'replication-slots': {
    summary: 'Replication slots and their lag',
    columns: cols([
      ['slot_name', 'Name'], ['active', 'Active'], ['state', 'State'],
      ['replication_client_address', 'Replication Client Address'],
      ['replication_lag_gb', 'Replication Lag GB'],
    ]),
    sql: `SELECT
  s.slot_name,
  s.active,
  COALESCE(r.state, 'N/A') as state,
  CASE WHEN r.client_addr IS NULL
    THEN 'N/A'
    ELSE r.client_addr::text
  END replication_client_address,
  GREATEST(0, ROUND((redo_lsn-restart_lsn)/1024/1024/1024, 2))::text as replication_lag_gb
FROM pg_control_checkpoint(), pg_replication_slots s
LEFT JOIN pg_stat_replication r ON (r.pid = s.active_pid)`,
  },

  'role-stats': {
    summary: 'Roles with their connection counts, limits and custom config',
    columns: cols([
      ['role_name', 'Role name'], ['active_connections', 'Active connections'],
      ['connection_limit', 'Connection limit'], ['custom_config', 'Custom config'],
    ]),
    sql: `SELECT
  rolname as role_name,
  (SELECT count(*) FROM pg_stat_activity WHERE pg_roles.rolname = pg_stat_activity.usename) AS active_connections,
  CASE WHEN rolconnlimit = -1
    THEN current_setting('max_connections')::int8
    ELSE rolconnlimit
  END AS connection_limit,
  array_to_string(rolconfig, ',', '*') as custom_config
FROM pg_roles
ORDER BY 1 DESC`,
  },

  'table-stats': {
    summary: 'Table size, index size and estimated row count',
    columns: cols([
      ['name', 'Name'], ['table_size', 'Table size'], ['index_size', 'Index size'],
      ['total_size', 'Total size'], ['estimated_row_count', 'Estimated row count'],
      ['seq_scans', 'Seq scans'],
    ]),
    sql: `SELECT
  ts.name,
  pg_size_pretty(ts.table_size_bytes) AS table_size,
  pg_size_pretty(ts.index_size_bytes) AS index_size,
  pg_size_pretty(ts.total_size_bytes) AS total_size,
  COALESCE(rc.estimated_row_count, 0) AS estimated_row_count,
  COALESCE(rc.seq_scans, 0) AS seq_scans
FROM (
  SELECT
    FORMAT('%I.%I', n.nspname, c.relname) AS name,
    pg_table_size(c.oid) AS table_size_bytes,
    pg_indexes_size(c.oid) AS index_size_bytes,
    pg_total_relation_size(c.oid) AS total_size_bytes
  FROM pg_class c
  LEFT JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE NOT n.nspname LIKE ANY(${IGNORED_SCHEMAS})
    AND c.relkind = 'r'
) ts
LEFT JOIN (
  SELECT
    FORMAT('%I.%I', schemaname, relname) AS name,
    n_live_tup AS estimated_row_count,
    seq_scan AS seq_scans
  FROM pg_stat_user_tables
  WHERE NOT schemaname LIKE ANY(${IGNORED_SCHEMAS})
) rc ON rc.name = ts.name
ORDER BY ts.total_size_bytes DESC`,
  },

  'traffic-profile': {
    summary: 'Read/write balance of each table',
    columns: cols([
      ['schemaname', 'Schema'], ['table_name', 'Table'], ['blocks_read', 'Blocks Read'],
      ['write_tuples', 'Write Tuples'], ['blocks_write', 'Blocks Write'], ['activity_ratio', 'Activity Ratio'],
    ]),
    // Adapted upstream from Crunchy Data's "Is Postgres Read Heavy or Write Heavy?".
    sql: `WITH
ratio_target AS (SELECT 5 AS ratio),
table_list AS (SELECT
  s.schemaname,
  s.relname AS table_name,
  si.heap_blks_read + si.idx_blks_read AS blocks_read,
  s.n_tup_ins + s.n_tup_upd + s.n_tup_del AS write_tuples,
  relpages * (s.n_tup_ins + s.n_tup_upd + s.n_tup_del ) / (case when reltuples = 0 then 1 else reltuples end) as blocks_write
FROM pg_stat_user_tables AS s
JOIN pg_statio_user_tables AS si ON s.relid = si.relid
JOIN pg_class c ON c.oid = s.relid
WHERE (s.n_tup_ins + s.n_tup_upd + s.n_tup_del) > 0
  AND (si.heap_blks_read + si.idx_blks_read) > 0
)
SELECT
  schemaname,
  table_name,
  blocks_read,
  write_tuples,
  to_char(blocks_write, 'FM999999999990.0') AS blocks_write,
  CASE
    WHEN blocks_read = 0 and blocks_write = 0 THEN 'No Activity'
    WHEN blocks_write * ratio > blocks_read THEN
      CASE
        WHEN blocks_read = 0 THEN 'Write-Only'
        ELSE ROUND(blocks_write :: numeric / blocks_read :: numeric, 1)::text || ':1 (Write-Heavy)'
      END
    WHEN blocks_read > blocks_write * ratio THEN
      CASE
        WHEN blocks_write = 0 THEN 'Read-Only'
        ELSE '1:' || ROUND(blocks_read::numeric / blocks_write :: numeric, 1)::text || ' (Read-Heavy)'
      END
    ELSE '1:1 (Balanced)'
  END AS activity_ratio
FROM table_list, ratio_target
ORDER BY (blocks_read + table_list.blocks_write) DESC`,
  },

  'vacuum-stats': {
    summary: 'Vacuum and analyze history, and whether autovacuum is due',
    columns: cols([
      ['name', 'Table'], ['last_vacuum', 'Last Vacuum'], ['last_autovacuum', 'Last Auto Vacuum'],
      ['last_analyze', 'Last Analyze'], ['last_autoanalyze', 'Last Auto Analyze'],
      ['rowcount', 'Row count'], ['dead_rowcount', 'Dead row count'],
      ['expect_autovacuum', 'Expect autovacuum?'], ['expect_autoanalyze', 'Expect autoanalyze?'],
    ]),
    sql: `WITH table_opts AS (
  SELECT pg_class.oid, relname, nspname, array_to_string(reloptions, '') AS relopts
  FROM pg_class INNER JOIN pg_namespace ns ON relnamespace = ns.oid
), vacuum_settings AS (
  SELECT
    oid, relname, nspname,
    CASE
      WHEN relopts LIKE '%autovacuum_vacuum_threshold%'
        THEN substring(relopts, '.*autovacuum_vacuum_threshold=([0-9.]+).*')::integer
        ELSE current_setting('autovacuum_vacuum_threshold')::integer
      END AS autovacuum_vacuum_threshold,
    CASE
      WHEN relopts LIKE '%autovacuum_vacuum_scale_factor%'
        THEN substring(relopts, '.*autovacuum_vacuum_scale_factor=([0-9.]+).*')::real
        ELSE current_setting('autovacuum_vacuum_scale_factor')::real
      END AS autovacuum_vacuum_scale_factor,
    CASE
      WHEN relopts LIKE '%autovacuum_analyze_threshold%'
        THEN substring(relopts, '.*autovacuum_analyze_threshold=([0-9.]+).*')::integer
        ELSE current_setting('autovacuum_analyze_threshold')::integer
      END AS autovacuum_analyze_threshold,
    CASE
      WHEN relopts LIKE '%autovacuum_analyze_scale_factor%'
        THEN substring(relopts, '.*autovacuum_analyze_scale_factor=([0-9.]+).*')::real
        ELSE current_setting('autovacuum_analyze_scale_factor')::real
      END AS autovacuum_analyze_scale_factor
  FROM table_opts
)
SELECT
  FORMAT('%I.%I', vacuum_settings.nspname, vacuum_settings.relname) AS name,
  coalesce(to_char(psut.last_vacuum, 'YYYY-MM-DD HH24:MI'), '') AS last_vacuum,
  coalesce(to_char(psut.last_autovacuum, 'YYYY-MM-DD HH24:MI'), '') AS last_autovacuum,
  coalesce(to_char(psut.last_analyze, 'YYYY-MM-DD HH24:MI'), '') AS last_analyze,
  coalesce(to_char(psut.last_autoanalyze, 'YYYY-MM-DD HH24:MI'), '') AS last_autoanalyze,
  CASE WHEN pg_class.reltuples = -1 THEN 'No stats' ELSE to_char(pg_class.reltuples, '9G999G999G999') END AS rowcount,
  to_char(psut.n_dead_tup, '9G999G999G999') AS dead_rowcount,
  to_char(autovacuum_vacuum_threshold
       + (autovacuum_vacuum_scale_factor::numeric * pg_class.reltuples), '9G999G999G999') AS autovacuum_threshold,
  CASE
    WHEN autovacuum_vacuum_threshold + (autovacuum_vacuum_scale_factor::numeric * pg_class.reltuples) < psut.n_dead_tup
    THEN 'yes'
    ELSE 'no'
  END AS expect_autovacuum,
  to_char(autovacuum_analyze_threshold
       + (autovacuum_analyze_scale_factor::numeric * pg_class.reltuples), '9G999G999G999') AS autoanalyze_threshold,
  CASE
    WHEN autovacuum_analyze_threshold + (autovacuum_analyze_scale_factor::numeric * pg_class.reltuples) < psut.n_dead_tup
    THEN 'yes'
    ELSE 'no'
  END AS expect_autoanalyze
FROM pg_stat_user_tables psut INNER JOIN pg_class ON psut.relid = pg_class.oid
INNER JOIN vacuum_settings ON pg_class.oid = vacuum_settings.oid
WHERE NOT vacuum_settings.nspname LIKE ANY(${IGNORED_SCHEMAS})
ORDER BY
  case when pg_class.reltuples = -1 then 1 else 0 end,
  1`,
  },
};

// Names Supabase has folded into the queries above and still accepts, each
// routed to the query that replaced it (upstream's deprecated handlers).
const DEPRECATED = {
  'cache-hit': 'db-stats',
  'index-sizes': 'index-stats',
  'index-usage': 'index-stats',
  'seq-scans': 'index-stats',
  'table-record-counts': 'index-stats',
  'total-index-size': 'index-stats',
  'unused-indexes': 'index-stats',
  'role-configs': 'role-stats',
  'role-connections': 'role-stats',
  'table-index-sizes': 'table-stats',
  'table-sizes': 'table-stats',
  'total-table-sizes': 'table-stats',
};

// `inspect report` has no query of its own for unused indexes (the subcommand
// is a deprecated alias), so it carries upstream's standalone one.
const UNUSED_INDEXES = {
  columns: cols([['name', 'name'], ['index', 'index'], ['index_size', 'index_size'], ['index_scans', 'index_scans']]),
  sql: `SELECT
  FORMAT('%I.%I', schemaname, relname) AS name,
  indexrelname AS index,
  pg_size_pretty(pg_relation_size(i.indexrelid)) AS index_size,
  idx_scan as index_scans
FROM pg_stat_user_indexes ui
JOIN pg_index i ON ui.indexrelid = i.indexrelid
WHERE
  NOT indisunique AND idx_scan < 50 AND pg_relation_size(relid) > 5 * 8192
  AND NOT schemaname LIKE ANY(${IGNORED_SCHEMAS})
ORDER BY
  pg_relation_size(i.indexrelid) / nullif(idx_scan, 0) DESC NULLS FIRST,
  pg_relation_size(i.indexrelid) DESC`,
};

// The report's files, named like upstream's CSVs (`db_stats.csv`), in its order.
const REPORT = [
  ...Object.keys(QUERIES).map(name => ({ file: name.replace(/-/g, '_'), name, query: QUERIES[name] })),
  { file: 'unused_indexes', name: 'unused-indexes', query: UNUSED_INDEXES },
].sort((a, b) => a.file.localeCompare(b.file));

/** The query a subcommand name runs, following deprecated names to their replacement. */
function resolveQuery(name) {
  const canonical = DEPRECATED[name] || name;
  const query = QUERIES[canonical];
  return query ? { name: canonical, query } : undefined;
}

module.exports = { QUERIES, DEPRECATED, REPORT, INTERNAL_SCHEMAS, resolveQuery, likePattern };
