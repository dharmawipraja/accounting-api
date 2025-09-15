/**
 * Shared Constants
 * Central location for all application constants
 */

import { t } from '../i18n/index.js';

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
  AKTIVA: 'AKTIVA',
  PASIVA: 'PASIVA',
  PENJUALAN: 'PENJUALAN',
  BEBAN_DAN_BIAYA: 'BEBAN_DAN_BIAYA'
};

// Account Sub Categories
export const ACCOUNT_SUB_CATEGORIES = {
  AKTIVA_LANCAR: 'AKTIVA_LANCAR',
  AKTIVA_TETAP: 'AKTIVA_TETAP',
  AKTIVA_LAINNYA: 'AKTIVA_LAINNYA',
  HUTANG: 'HUTANG',
  MODAL: 'MODAL',
  PENJUALAN: 'PENJUALAN',
  HARGA_POKOK_PENJUALAN: 'HARGA_POKOK_PENJUALAN',
  BEBAN_TETAP: 'BEBAN_TETAP',
  BIAYA_TIDAK_TETAP: 'BIAYA_TIDAK_TETAP',
  PENDAPATAN_DAN_BIAYA_LAINNYA: 'PENDAPATAN_DAN_BIAYA_LAINNYA',
  TAKSIRAN_PAJAK: 'TAKSIRAN_PAJAK'
};

// Account Types
export const ACCOUNT_TYPES = {
  GENERAL: 'GENERAL',
  DETAIL: 'DETAIL'
};

// Transaction Types
export const TRANSACTION_TYPES = {
  DEBIT: 'DEBIT',
  KREDIT: 'KREDIT'
};

// Ledger Types
export const LEDGER_TYPES = {
  KAS: 'KAS',
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

// Error Messages (using i18n)
export const ERROR_MESSAGES = {
  UNAUTHORIZED: () => t('http.unauthorized'),
  FORBIDDEN: () => t('http.forbidden'),
  NOT_FOUND: () => t('http.notFound'),
  ALREADY_EXISTS: () => t('http.alreadyExists'),
  VALIDATION_FAILED: () => t('http.validationFailed'),
  DATABASE_ERROR: () => t('http.databaseError'),
  INTERNAL_ERROR: () => t('http.internalError'),

  // Authentication specific messages
  AUTH: {
    MISSING_TOKEN: () => t('auth.missingToken'),
    INVALID_TOKEN: () => t('auth.invalidToken'),
    TOKEN_EXPIRED: () => t('auth.tokenExpired'),
    USER_NOT_FOUND: () => t('auth.userNotFound'),
    USER_INACTIVE: () => t('auth.userInactive'),
    NOT_AUTHENTICATED: () => t('auth.notAuthenticated'),
    INSUFFICIENT_PERMISSIONS: () => t('auth.insufficientPermissions')
  }
};

// Success Messages (using i18n)
export const SUCCESS_MESSAGES = {
  CREATED: () => t('crud.created'),
  UPDATED: () => t('crud.updated'),
  DELETED: () => t('crud.deleted'),
  RETRIEVED: () => t('crud.retrieved')
};
