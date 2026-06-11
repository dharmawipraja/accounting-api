-- AlterEnum: ADD VALUE cannot run inside a transaction block in PostgreSQL,
-- so this is intentionally in its own migration folder.
ALTER TYPE "JournalSourceType" ADD VALUE 'CLOSING';
