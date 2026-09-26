/**
 * Advisory-lock keys shared by the app and the out-of-process admin bootstrap
 * (scripts/create-admin.ts). Kept dependency-free so the script can import them
 * without pulling in Nest services.
 */

/** Advisory-lock key serializing admin-pool mutations (role/isActive/delete).
 *  Far outside the fiscal-year key space used by year-end close (~2000-2200). */
export const USER_ADMIN_LOCK_KEY = 71_001_001;

/**
 * Namespace (classid) of the per-user refresh-session advisory lock, taken with
 * the TWO-int4-key form `pg_advisory_xact_lock(ns, hashtext(user_id))`. Postgres
 * keeps the two-key space disjoint from the single-bigint space, so this can
 * never collide with the bigint keys 71_00x_001 or the fiscal-year keys. A
 * hashtext collision between two users only over-serializes (harmless).
 */
export const REFRESH_SESSION_LOCK_NS = 71_002;
