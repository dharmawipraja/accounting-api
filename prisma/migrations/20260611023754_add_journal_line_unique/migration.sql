-- CreateIndex
CREATE UNIQUE INDEX "journal_lines_journal_entry_id_line_no_key" ON "journal_lines"("journal_entry_id", "line_no");
