-- CreateTable
CREATE TABLE "public"."journal_ledgers" (
    "id" TEXT NOT NULL,
    "referenceNumber" TEXT NOT NULL,
    "accountDetailAccountNumber" TEXT NOT NULL,
    "accountGeneralAccountNumber" TEXT NOT NULL,
    "transactionType" "public"."TransactionType" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "reportType" "public"."ReportType" NOT NULL,
    "ledgerDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "journal_ledgers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."journal_balances" (
    "id" TEXT NOT NULL,
    "accountDetailAccountNumber" TEXT NOT NULL,
    "accountGeneralAccountNumber" TEXT NOT NULL,
    "transactionType" "public"."TransactionType" NOT NULL,
    "amountCredit" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "amountDebit" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "reportType" "public"."ReportType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "journal_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."sisa_hasil_usaha" (
    "id" TEXT NOT NULL,
    "year" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sisa_hasil_usaha_pkey" PRIMARY KEY ("id")
);
