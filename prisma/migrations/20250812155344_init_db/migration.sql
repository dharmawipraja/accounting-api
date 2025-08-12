-- CreateEnum
CREATE TYPE "public"."AccountCategory" AS ENUM ('ASSET', 'HUTANG', 'MODAL', 'PENDAPATAN', 'BIAYA');

-- CreateEnum
CREATE TYPE "public"."AccountType" AS ENUM ('GENERAL', 'DETAIL');

-- CreateEnum
CREATE TYPE "public"."LedgerType" AS ENUM ('KAS_MASUK', 'KAS_KELUAR');

-- CreateEnum
CREATE TYPE "public"."PostingStatus" AS ENUM ('PENDING', 'POSTED');

-- CreateEnum
CREATE TYPE "public"."ReportType" AS ENUM ('NERACA', 'LABA_RUGI');

-- CreateEnum
CREATE TYPE "public"."Role" AS ENUM ('NASABAH', 'KASIR', 'KOLEKTOR', 'MANAJER', 'ADMIN', 'AKUNTAN');

-- CreateEnum
CREATE TYPE "public"."TransactionType" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "public"."UserStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateTable
CREATE TABLE "public"."users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "public"."Role" NOT NULL DEFAULT 'NASABAH',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "status" "public"."UserStatus" NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."accounts_detail" (
    "id" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "accountType" "public"."AccountType" NOT NULL DEFAULT 'DETAIL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "accountGeneralId" TEXT NOT NULL,
    "accountCategory" "public"."AccountCategory" NOT NULL,
    "amountCredit" DECIMAL(10,2) NOT NULL,
    "amountDebit" DECIMAL(10,2) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "reportType" "public"."ReportType" NOT NULL,
    "transactionType" "public"."TransactionType" NOT NULL,

    CONSTRAINT "accounts_detail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."accounts_general" (
    "id" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "accountType" "public"."AccountType" NOT NULL DEFAULT 'GENERAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "accountCategory" "public"."AccountCategory" NOT NULL,
    "amountCredit" DECIMAL(10,2) NOT NULL,
    "amountDebit" DECIMAL(10,2) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "reportType" "public"."ReportType" NOT NULL,
    "transactionType" "public"."TransactionType" NOT NULL,

    CONSTRAINT "accounts_general_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."balances" (
    "id" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ledgers" (
    "id" TEXT NOT NULL,
    "referenceNumber" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "accountDetailId" TEXT NOT NULL,
    "ledgerType" "public"."LedgerType" NOT NULL,
    "transactionType" "public"."TransactionType" NOT NULL,
    "postingStatus" "public"."PostingStatus" NOT NULL DEFAULT 'PENDING',
    "postingAt" TIMESTAMP(3),
    "accountGeneralId" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "ledgerDate" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ledgers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "public"."users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_detail_accountNumber_key" ON "public"."accounts_detail"("accountNumber");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_general_accountNumber_key" ON "public"."accounts_general"("accountNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ledgers_referenceNumber_key" ON "public"."ledgers"("referenceNumber");

-- AddForeignKey
ALTER TABLE "public"."accounts_detail" ADD CONSTRAINT "accounts_detail_accountGeneralId_fkey" FOREIGN KEY ("accountGeneralId") REFERENCES "public"."accounts_general"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ledgers" ADD CONSTRAINT "ledgers_accountDetailId_fkey" FOREIGN KEY ("accountDetailId") REFERENCES "public"."accounts_detail"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ledgers" ADD CONSTRAINT "ledgers_accountGeneralId_fkey" FOREIGN KEY ("accountGeneralId") REFERENCES "public"."accounts_general"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
