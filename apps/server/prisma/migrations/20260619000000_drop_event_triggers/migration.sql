-- The app-level event-trigger system (webhook / edge-function reactions on row
-- change) is removed in favor of real PostgreSQL triggers managed via the
-- Triggers page. Webhooks/Realtime already cover app-level event reactions.
DROP TABLE IF EXISTS "triggers";
