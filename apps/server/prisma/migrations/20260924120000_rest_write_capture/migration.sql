-- RETURNING is a client opt-in, not an internal event transport. AFTER triggers
-- capture only writes armed by the server, after the caller's RLS checks.
CREATE TABLE platform.rest_write_requests (
  id uuid PRIMARY KEY,
  backend integer NOT NULL UNIQUE,
  transaction bigint NOT NULL,
  relation bigint NOT NULL
);
CREATE TABLE platform.rest_write_changes (
  ordinal bigserial PRIMARY KEY,
  "requestId" uuid NOT NULL REFERENCES platform.rest_write_requests(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('created', 'updated', 'deleted')),
  row jsonb NOT NULL
);
CREATE INDEX rest_write_changes_request_idx ON platform.rest_write_changes("requestId");
ALTER TABLE platform.rest_write_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.rest_write_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON platform.rest_write_requests, platform.rest_write_changes
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE platform.rest_write_changes_ordinal_seq
  FROM PUBLIC, anon, authenticated, service_role;

-- This private definer only copies NEW/OLD to the private buffer. It never
-- reads or mutates a user table and cannot make a forbidden write succeed.
CREATE FUNCTION platform.capture_rest_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  -- Match the REST statement's own rows, as RETURNING did. A user trigger may
  -- issue more SQL (including soft-delete UPDATEs); those are not this write.
  IF pg_trigger_depth() <> 1 THEN
    RETURN NULL;
  END IF;
  INSERT INTO platform.rest_write_changes ("requestId", action, row)
  SELECT id,
         CASE TG_OP WHEN 'INSERT' THEN 'created' WHEN 'UPDATE' THEN 'updated' ELSE 'deleted' END,
         CASE TG_OP WHEN 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END
  FROM platform.rest_write_requests
  WHERE backend = pg_backend_pid() AND transaction = txid_current()
    AND (relation = TG_RELID::bigint OR relation = pg_partition_root(TG_RELID)::oid::bigint);
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION platform.capture_rest_write() FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION platform.attach_rest_write_capture(target oid) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  relation_name text;
BEGIN
  SELECT format('%I.%I', n.nspname, c.relname) INTO relation_name
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.oid = target AND n.nspname = 'public'
    AND c.relkind IN ('r', 'p') AND NOT c.relispartition;
  IF relation_name IS NULL OR EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = target AND tgname = 'motherbase_capture_write'
  ) THEN
    RETURN;
  END IF;
  EXECUTE format(
    'CREATE TRIGGER motherbase_capture_write AFTER INSERT OR UPDATE OR DELETE ON %s
     FOR EACH ROW EXECUTE FUNCTION platform.capture_rest_write()', relation_name
  );
END;
$$;
REVOKE ALL ON FUNCTION platform.attach_rest_write_capture(oid) FROM PUBLIC, anon, authenticated, service_role;

-- Include SQL-created tables, not only tables created through Studio. Parent
-- partition triggers are cloned by PostgreSQL; never attach a second copy.
DO $$
DECLARE target oid;
BEGIN
  FOR target IN SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
  LOOP
    PERFORM platform.attach_rest_write_capture(target);
  END LOOP;
END;
$$;

CREATE FUNCTION platform.attach_rest_write_capture_on_ddl() RETURNS event_trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE command record;
BEGIN
  FOR command IN SELECT * FROM pg_event_trigger_ddl_commands()
    WHERE classid = 'pg_class'::regclass AND objsubid = 0
  LOOP
    PERFORM platform.attach_rest_write_capture(command.objid);
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION platform.attach_rest_write_capture_on_ddl()
  FROM PUBLIC, anon, authenticated, service_role;
CREATE EVENT TRIGGER motherbase_attach_rest_write_capture ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO', 'ALTER TABLE')
  EXECUTE FUNCTION platform.attach_rest_write_capture_on_ddl();
