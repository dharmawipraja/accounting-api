/** HTTP methods the audit interceptor records (mutating verbs only). */
export const MUTATING_METHODS = ['POST', 'PATCH', 'PUT', 'DELETE'] as const;

/** The audit_log `method` of a row written by an operator CLI script
 *  (scripts/create-admin) rather than by an HTTP request. */
export const CLI_AUDIT_METHOD = 'CLI';

/** Every `method` value an audit_log row can carry — the `?method=` filter of
 *  GET /v1/audit accepts exactly these. */
export const AUDIT_METHODS = [...MUTATING_METHODS, CLI_AUDIT_METHOD] as const;
