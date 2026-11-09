-- Realtime Broadcast from Database and Realtime Authorization, Supabase-shaped.
--
-- `realtime.messages` plays the same two roles it plays on Supabase:
--   1. The record of every message sent from SQL with `realtime.send` (or
--      `realtime.broadcast_changes` from a trigger).
--   2. The table whose RLS policies decide who may join a private channel and
--      what they may do on it: SELECT = receive, INSERT = send. Policies read
--      the channel being joined with `realtime.topic()` and the feature with
--      the `extension` column ('broadcast' | 'presence').
--
-- Delivery reuses the realtime outbox: `send` enqueues a 'broadcast' event in
-- the same transaction, so a message is delivered exactly when the transaction
-- that sent it commits, with the outbox's retries and NOTIFY wake-up.

CREATE SCHEMA IF NOT EXISTS "realtime";
GRANT USAGE ON SCHEMA "realtime" TO anon, authenticated, service_role;

CREATE TABLE "realtime"."messages" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "topic" text NOT NULL,
  "extension" text NOT NULL,
  "event" text,
  "payload" jsonb,
  "private" boolean NOT NULL DEFAULT true,
  "inserted_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "messages_extension_check" CHECK ("extension" IN ('broadcast', 'presence'))
);
CREATE INDEX "messages_inserted_at_idx" ON "realtime"."messages" ("inserted_at");

-- RLS on and no policy: nobody may join a private channel until the project
-- writes a policy that says who can, which is Supabase's default too.
ALTER TABLE "realtime"."messages" ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON "realtime"."messages" TO anon, authenticated;
GRANT ALL ON "realtime"."messages" TO service_role;

-- The topic of the channel being authorized. Set per check with SET LOCAL
-- `realtime.topic` by RealtimeAuthorizationService.
CREATE FUNCTION "realtime"."topic"() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('realtime.topic', true), '')::text $$;
GRANT EXECUTE ON FUNCTION "realtime"."topic"() TO anon, authenticated, service_role;

ALTER TABLE "platform"."realtime_outbox" DROP CONSTRAINT "realtime_outbox_action_check";
ALTER TABLE "platform"."realtime_outbox" ADD CONSTRAINT "realtime_outbox_action_check"
  CHECK ("action" IN ('created', 'updated', 'deleted', 'broadcast'));

-- SECURITY DEFINER because the outbox is private to the owner. EXECUTE is not
-- granted to anon/authenticated: as on Supabase, a trigger that broadcasts
-- runs a SECURITY DEFINER function of its own, so a REST caller cannot publish
-- arbitrary messages by calling this directly.
--
-- Errors become a WARNING rather than failing the caller, like Supabase: a
-- realtime message must never be able to roll back the write it describes.
CREATE FUNCTION "realtime"."send"(payload jsonb, event text, topic text, private boolean DEFAULT true)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  message_id uuid;
BEGIN
  BEGIN
    INSERT INTO "realtime"."messages" ("payload", "event", "topic", "private", "extension")
      VALUES (payload, event, topic, private, 'broadcast')
      RETURNING "id" INTO message_id;
    INSERT INTO "platform"."realtime_outbox" ("id", "model", "dbName", "action", "payloads", "updatedAt")
      VALUES (
        gen_random_uuid()::text, 'realtime.messages', 'realtime.messages', 'broadcast',
        jsonb_build_array(jsonb_build_object(
          'id', message_id, 'topic', topic, 'event', event, 'payload', payload, 'private', private
        )),
        now()
      );
    PERFORM pg_notify('realtime_outbox', '');
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'ErrorSendingBroadcastMessage: %', SQLERRM;
  END;
END;
$$;
REVOKE ALL ON FUNCTION "realtime"."send"(jsonb, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "realtime"."send"(jsonb, text, text, boolean) TO service_role;

-- Same signature and payload as Supabase's, so a trigger written for Supabase
-- runs unchanged:
--   PERFORM realtime.broadcast_changes('room:' || NEW.room_id, TG_OP, TG_OP,
--     TG_TABLE_NAME, TG_TABLE_SCHEMA, NEW, OLD);
CREATE FUNCTION "realtime"."broadcast_changes"(
  topic_name text, event_name text, operation text, table_name text, table_schema text,
  new record, old record, level text DEFAULT 'ROW'
) RETURNS void
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF level = 'STATEMENT' THEN
    RAISE EXCEPTION 'function can only be triggered for each row, not for each statement';
  END IF;
  IF operation NOT IN ('INSERT', 'UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'Unexpected operation type: %', operation;
  END IF;
  PERFORM "realtime"."send"(
    jsonb_build_object(
      'old_record', old,
      'record', new,
      'operation', operation,
      'table', table_name,
      'schema', table_schema
    ),
    event_name,
    topic_name,
    true
  );
END;
$$;
REVOKE ALL ON FUNCTION "realtime"."broadcast_changes"(text, text, text, text, text, record, record, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "realtime"."broadcast_changes"(text, text, text, text, text, record, record, text) TO service_role;
