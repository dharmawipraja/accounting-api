-- AUDIT3 iteration-2 (Task 15): request_id is now ALWAYS server-generated (a
-- UUID, echoed as the X-Request-Id response header). A caller-supplied
-- X-Request-Id is no longer trusted as the trace id; when it is a safe shape
-- (^[\w.-]{1,128}$) it is kept here for client-side correlation only, else NULL.
-- Nullable, no default → metadata-only ALTER (no rewrite of the append-only
-- table; its UPDATE/DELETE/TRUNCATE guards are unaffected).
ALTER TABLE "audit_log" ADD COLUMN "client_request_id" TEXT;
