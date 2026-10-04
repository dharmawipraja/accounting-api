/** HTTP methods the audit interceptor records (mutating verbs only). */
export const MUTATING_METHODS = ['POST', 'PATCH', 'PUT', 'DELETE'] as const;

/** The audit_log `method` of a row written by an operator CLI script
 *  (scripts/create-admin) rather than by an HTTP request. */
export const CLI_AUDIT_METHOD = 'CLI';

/** The audit_log `method` of a row a data MIGRATION wrote for each row it
 *  auto-fixed (path = the migration name, body `{ table, id, old, new }`,
 *  user_id NULL) — 20261005000000_identifier_code_ci_unique and
 *  20261005300000_users_email_nfc. SQL-only writer: keep in sync. */
const MIGRATION_AUDIT_METHOD = 'MIGRATION';

/** Every `method` value an audit_log row can carry — the `?method=` filter of
 *  GET /v1/audit accepts exactly these. */
export const AUDIT_METHODS = [
  ...MUTATING_METHODS,
  CLI_AUDIT_METHOD,
  MIGRATION_AUDIT_METHOD,
] as const;
