-- AlterTable
ALTER TABLE "public"."journal_ledgers" ADD COLUMN     "postingAt" TIMESTAMP(3),
ADD COLUMN     "postingStatus" "public"."PostingStatus" NOT NULL DEFAULT 'PENDING';
