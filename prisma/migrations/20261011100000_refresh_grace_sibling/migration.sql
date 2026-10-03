-- At most ONE concurrent-refresh grace sibling per consumed refresh token:
-- the sibling's id is recorded here; a second grace replay revokes the family.
ALTER TABLE "refresh_tokens" ADD COLUMN "grace_child_id" TEXT;
