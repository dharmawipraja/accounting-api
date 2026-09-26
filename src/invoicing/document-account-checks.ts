import { accountPolicyFor } from '../ledger/posting/account-policy';
import type {
  LedgerTx,
  PostingService,
} from '../ledger/posting/posting.service';
import {
  assertCashAccount,
  assertDocumentLineAccounts,
} from './document-account-rules';

/** An invoice / bill: its line-account rule set and posting source type. */
export interface DocumentAccountKind {
  nature: 'SALE' | 'PURCHASE';
  sourceType: 'SALES_INVOICE' | 'PURCHASE_BILL';
}

/**
 * The ONE invoice/bill line-account check, shared by draft create/PATCH,
 * journal preview and post so all three agree on every line, in the same
 * order and with the same errors: EVERY line account (incl. a free,
 * zero-amount line that leaves no journal line) exists, is live, postable and
 * active under the source type's policy (422 INVALID_ACCOUNT, via
 * PostingService.resolvePostableAccounts), then the document line rules
 * (control / cash / tax / type / contra → 422 VALIDATION_FAILED). `db` is the
 * base client (draft / preview) or the post transaction.
 */
export async function assertDocumentLineAccountsPostable(
  posting: PostingService,
  db: LedgerTx,
  kind: DocumentAccountKind,
  accountIds: string[],
): Promise<void> {
  await posting.resolvePostableAccounts(
    accountIds,
    accountPolicyFor(kind.sourceType),
    db,
  );
  await assertDocumentLineAccounts(db, kind.nature, accountIds);
}

/**
 * The ONE pre-tx payment cash-account check, shared by payment create and the
 * PAYMENT journal preview: exists, live, postable, active under the PAYMENT
 * policy (422 INVALID_ACCOUNT { accountId }), then the CASH role (422
 * VALIDATION_FAILED). The post re-checks the role in its tx (assertCashAccount)
 * and the postable rules under FOR SHARE (PostingService).
 */
export async function assertPaymentCashAccountPostable(
  posting: PostingService,
  db: LedgerTx,
  cashAccountId: string,
): Promise<void> {
  await posting.resolvePostableAccounts(
    [cashAccountId],
    accountPolicyFor('PAYMENT'),
    db,
  );
  await assertCashAccount(db, cashAccountId);
}
