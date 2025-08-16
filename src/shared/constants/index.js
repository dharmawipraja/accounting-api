/**
 * Shared Constants
 * Central location for all application constants
 */

// User Roles
export const USER_ROLES = {
  NASABAH: 'NASABAH',
  KASIR: 'KASIR',
  KOLEKTOR: 'KOLEKTOR',
  MANAJER: 'MANAJER',
  ADMIN: 'ADMIN',
  AKUNTAN: 'AKUNTAN'
};

// User Status
export const USER_STATUS = {
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE'
};

// Account Categories
export const ACCOUNT_CATEGORIES = {
  ASSET: 'ASSET',
  HUTANG: 'HUTANG',
  MODAL: 'MODAL',
  PENDAPATAN: 'PENDAPATAN',
  BIAYA: 'BIAYA'
};

// Account Types
export const ACCOUNT_TYPES = {
  GENERAL: 'GENERAL',
  DETAIL: 'DETAIL'
};

// Transaction Types
export const TRANSACTION_TYPES = {
  DEBIT: 'DEBIT',
  CREDIT: 'CREDIT'
};

// Ledger Types
export const LEDGER_TYPES = {
  KAS_MASUK: 'KAS_MASUK',
  KAS_KELUAR: 'KAS_KELUAR'
};

// Posting Status
export const POSTING_STATUS = {
  PENDING: 'PENDING',
  POSTED: 'POSTED'
};

// Report Types
export const REPORT_TYPES = {
  NERACA: 'NERACA',
  LABA_RUGI: 'LABA_RUGI'
};

// Cache durations (in seconds)
export const CACHE_DURATION = {
  SHORT: 60, // 1 minute
  MEDIUM: 300, // 5 minutes
  LONG: 3600, // 1 hour
  API_INFO: 300 // 5 minutes for API info
};

// Pagination defaults
export const PAGINATION = {
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
  MIN_LIMIT: 1
};

// Validation limits
export const VALIDATION_LIMITS = {
  MAX_AMOUNT: 99999999.99,
  DECIMAL_PLACES: 2,
  ULID_LENGTH: 26,
  PASSWORD_MIN_LENGTH: 6,
  USERNAME_MIN_LENGTH: 3,
  NAME_MIN_LENGTH: 2
};

// HTTP Status Codes (commonly used)
export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL_SERVER_ERROR: 500
};

// Error Messages
export const ERROR_MESSAGES = {
  UNAUTHORIZED: 'Authentication required',
  FORBIDDEN: 'Insufficient permissions',
  NOT_FOUND: 'Resource not found',
  ALREADY_EXISTS: 'Resource already exists',
  VALIDATION_FAILED: 'Validation failed',
  DATABASE_ERROR: 'Database operation failed',
  INTERNAL_ERROR: 'Internal server error'
};

// Success Messages
export const SUCCESS_MESSAGES = {
  CREATED: 'Resource created successfully',
  UPDATED: 'Resource updated successfully',
  DELETED: 'Resource deleted successfully',
  RETRIEVED: 'Resource retrieved successfully'
};
