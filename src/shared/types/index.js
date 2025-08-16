/**
 * Shared TypeScript-like types using JSDoc
 * This provides better IDE support and documentation
 */

/**
 * @typedef {Object} User
 * @property {string} id - User ID (ULID)
 * @property {string} username - Unique username
 * @property {string} name - Full name
 * @property {'NASABAH'|'KASIR'|'KOLEKTOR'|'MANAJER'|'ADMIN'|'AKUNTAN'} role - User role
 * @property {'ACTIVE'|'INACTIVE'} status - User status
 * @property {Date} createdAt - Creation timestamp
 * @property {Date} updatedAt - Last update timestamp
 */

/**
 * @typedef {Object} AccountGeneral
 * @property {string} id - Account ID (ULID)
 * @property {string} code - Account code
 * @property {string} name - Account name
 * @property {'ASSET'|'HUTANG'|'MODAL'|'PENDAPATAN'|'BIAYA'} category - Account category
 * @property {'NERACA'|'LABA_RUGI'} reportType - Report type
 * @property {string} description - Account description
 * @property {boolean} isActive - Whether account is active
 * @property {Date} createdAt - Creation timestamp
 * @property {Date} updatedAt - Last update timestamp
 */

/**
 * @typedef {Object} AccountDetail
 * @property {string} id - Account detail ID (ULID)
 * @property {string} code - Account detail code
 * @property {string} name - Account detail name
 * @property {'ASSET'|'HUTANG'|'MODAL'|'PENDAPATAN'|'BIAYA'} category - Account category
 * @property {'NERACA'|'LABA_RUGI'} reportType - Report type
 * @property {'DEBIT'|'CREDIT'} transactionType - Transaction type
 * @property {number} balance - Current balance
 * @property {string} accountGeneralId - Parent general account ID
 * @property {boolean} isActive - Whether account is active
 * @property {Date} createdAt - Creation timestamp
 * @property {Date} updatedAt - Last update timestamp
 */

/**
 * @typedef {Object} Ledger
 * @property {string} id - Ledger ID (ULID)
 * @property {string} referenceNumber - Reference number
 * @property {Date} transactionDate - Transaction date
 * @property {string} description - Transaction description
 * @property {'DEBIT'|'CREDIT'} transactionType - Transaction type
 * @property {number} amount - Transaction amount
 * @property {'PENDING'|'POSTED'} postingStatus - Posting status
 * @property {string} accountDetailId - Related account detail ID
 * @property {Date} createdAt - Creation timestamp
 * @property {Date} updatedAt - Last update timestamp
 */

/**
 * @typedef {Object} PaginationOptions
 * @property {number} limit - Number of items per page
 * @property {number} skip - Number of items to skip
 * @property {number} page - Current page number
 */

/**
 * @typedef {Object} APIResponse
 * @property {boolean} success - Whether the request was successful
 * @property {*} data - Response data
 * @property {string} [message] - Optional message
 * @property {Object} [pagination] - Pagination info for list responses
 * @property {number} pagination.page - Current page
 * @property {number} pagination.limit - Items per page
 * @property {number} pagination.total - Total number of items
 * @property {number} pagination.pages - Total number of pages
 */

/**
 * @typedef {Object} ErrorResponse
 * @property {boolean} success - Always false for errors
 * @property {string} error - Error message
 * @property {number} statusCode - HTTP status code
 * @property {Object} [details] - Additional error details
 */

/**
 * @typedef {Object} DatabaseWhereClause
 * @property {Object} [AND] - AND conditions
 * @property {Object} [OR] - OR conditions
 * @property {Object} [NOT] - NOT conditions
 */

/**
 * @typedef {Object} SortOptions
 * @property {string} field - Field to sort by
 * @property {'asc'|'desc'} direction - Sort direction
 */

export {};
