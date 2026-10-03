import type { LedgerTx } from '../common/prisma/prisma.service';

/** The partner flags the in-tx checks look at. */
export interface LockedPartner {
  isActive: boolean;
  isCustomer: boolean;
  isVendor: boolean;
}

/**
 * Read a live partner FOR SHARE inside the caller's transaction, or undefined
 * when it does not exist / is soft-deleted. Partner soft-delete locks the row
 * FOR UPDATE before counting open items, so a draft create or payment post
 * holding this lock serializes with it: either the delete waits and then sees
 * the new draft (422 OPEN_ITEMS), or the writer waits and then sees the
 * partner gone. Raw SQL on purpose: Prisma has no FOR SHARE.
 */
export async function lockLivePartnerForShare(
  tx: LedgerTx,
  partnerId: string,
): Promise<LockedPartner | undefined> {
  const rows = await tx.$queryRaw<
    { is_active: boolean; is_customer: boolean; is_vendor: boolean }[]
  >`
    SELECT is_active, is_customer, is_vendor FROM business_partners
    WHERE id = ${partnerId} AND deleted_at IS NULL FOR SHARE`;
  const r = rows[0];
  return r
    ? {
        isActive: r.is_active,
        isCustomer: r.is_customer,
        isVendor: r.is_vendor,
      }
    : undefined;
}
