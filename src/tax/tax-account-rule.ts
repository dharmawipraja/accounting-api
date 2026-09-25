import {
  AccountRole,
  AccountSubtype,
  NormalBalance,
  TaxKind,
} from '@prisma/client';

/** The account attributes the tax-code account rule looks at. */
export interface TaxAccountCandidate {
  id: string;
  role: AccountRole | null;
  subtype: AccountSubtype;
  normalBalance: NormalBalance;
  isPostable: boolean;
}

export interface TaxAccountViolation {
  message: string;
  details: Record<string, unknown> & {
    taxAccountId: string;
    reason: 'NOT_POSTABLE' | 'SYSTEM_ROLE' | 'NORMAL_BALANCE' | 'SUBTYPE';
  };
}

/** Input VAT / prepaid PPh are recoverable (debit-normal receivables); output
 *  VAT / withheld PPh are owed (credit-normal payables). */
function isReceivableKind(kind: TaxKind): boolean {
  return kind === 'PPN_INPUT' || kind === 'PPH_PREPAID';
}

/**
 * Pure rule for the account a tax code posts to (checked on tax-code create and
 * re-checked inside the document post transaction): postable, no system role
 * (a tax posting must never land on cash, AR/AP control, equity or tax-expense
 * accounts), and shaped for the kind — PPN_INPUT/PPH_PREPAID need a
 * DEBIT-normal TAX_RECEIVABLE account, PPN_OUTPUT/PPH_PAYABLE a CREDIT-normal
 * TAX_PAYABLE one. Returns null when the account is acceptable.
 */
export function taxAccountViolation(
  kind: TaxKind,
  a: TaxAccountCandidate,
): TaxAccountViolation | null {
  if (!a.isPostable)
    return {
      message: 'Tax account must be postable',
      details: { taxAccountId: a.id, reason: 'NOT_POSTABLE' },
    };
  if (a.role !== null)
    return {
      message: `Tax account cannot hold the system role ${a.role}`,
      details: { taxAccountId: a.id, reason: 'SYSTEM_ROLE', role: a.role },
    };
  const receivable = isReceivableKind(kind);
  const requiredBalance: NormalBalance = receivable ? 'DEBIT' : 'CREDIT';
  if (a.normalBalance !== requiredBalance)
    return {
      message: `Tax kind ${kind} requires a ${requiredBalance}-normal account`,
      details: {
        taxAccountId: a.id,
        reason: 'NORMAL_BALANCE',
        kind,
        normalBalance: a.normalBalance,
      },
    };
  const requiredSubtype: AccountSubtype = receivable
    ? 'TAX_RECEIVABLE'
    : 'TAX_PAYABLE';
  if (a.subtype !== requiredSubtype)
    return {
      message: `Tax kind ${kind} requires a ${requiredSubtype} account`,
      details: {
        taxAccountId: a.id,
        reason: 'SUBTYPE',
        kind,
        subtype: a.subtype,
        required: requiredSubtype,
      },
    };
  return null;
}
