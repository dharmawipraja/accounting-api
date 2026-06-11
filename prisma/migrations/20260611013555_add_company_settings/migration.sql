-- CreateTable
CREATE TABLE "company_settings" (
    "id" TEXT NOT NULL,
    "singleton" BOOLEAN NOT NULL DEFAULT true,
    "legal_name" TEXT NOT NULL,
    "npwp" TEXT,
    "address" TEXT,
    "fiscal_year_start_month" INTEGER NOT NULL DEFAULT 1,
    "base_currency" TEXT NOT NULL DEFAULT 'IDR',
    "segregation_of_duties_enabled" BOOLEAN NOT NULL DEFAULT true,
    "is_pkp" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "company_settings_singleton_key" ON "company_settings"("singleton");
