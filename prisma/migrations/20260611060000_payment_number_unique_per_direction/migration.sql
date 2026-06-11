-- DropIndex
DROP INDEX "payments_fiscal_year_number_key";

-- CreateIndex
CREATE UNIQUE INDEX "payments_direction_fiscal_year_number_key" ON "payments"("direction", "fiscal_year", "number");
