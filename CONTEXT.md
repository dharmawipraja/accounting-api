# Domain Context

Ubiquitous terms used in this codebase, beyond the accounting glossary in
`docs/runbooks/domain-glossary.md`. Keep entries short; link code where useful.

## Taxed trade document

A document that runs through the tax engine (`TaxService`) and posts to an
AR/AP **control account** via `DocumentPostingService` — i.e. a **sales invoice**
or a **purchase bill**. Payments are *not* taxed trade documents (they settle
documents and carry no tax lines).

The shared behavior of taxed trade documents (create/update/list/delete/post/void
and presentation) lives in one deep module, `TaxedDocumentService`
(`src/invoicing/taxed-document.service.ts`), driven by a typed
`DocumentDescriptor` (`src/invoicing/document-descriptor.ts`). `SALE` and
`PURCHASE` are the two descriptor adapters, built by `SalesInvoicesService` and
`PurchaseBillsService` respectively.

## Payment target

The document a payment allocation settles: a **sales invoice** for a `RECEIPT`,
a **purchase bill** for a `DISBURSEMENT`. The receipt/disbursement behavior that
varies by direction (target table, control role, partner flag, doc-number prefix,
cash side, message nouns) lives in one `PaymentTarget` descriptor
(`src/invoicing/payment-targets.ts`), keyed by `PaymentDirection`; the shared
`settleInTx`/`unwindInTx`/`loadTarget` helpers own the over-allocation guard once.
`PaymentsService` selects the descriptor by direction and delegates.
