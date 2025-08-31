/**
 * Internationalization (i18n) System
 * Handles translations for the accounting API
 */

import { id } from './locales/id.js';
import logger from '../../core/logging/index.js';

// Available locales
const locales = {
  id // Indonesian
};

// Default locale
const DEFAULT_LOCALE = 'id';

/**
 * Get translation for a given key
 * @param {string} key - Translation key (dot notation supported, e.g., 'auth.invalidCredentials')
 * @param {Object} params - Parameters for string interpolation
 * @param {string} locale - Locale to use (defaults to Indonesian)
 * @returns {string} Translated string
 */
export function t(key, params = {}, locale = DEFAULT_LOCALE) {
  const translations = locales[locale] || locales[DEFAULT_LOCALE];

  // Navigate through nested object using dot notation
  const keys = key.split('.');
  let value = translations;

  for (const k of keys) {
    if (value && typeof value === 'object' && k in value) {
      value = value[k];
    } else {
      // Return the key if translation not found
      logger.warn(`Translation not found for key: ${key}`);
      return key;
    }
  }

  // If no translation found, return the key
  if (typeof value !== 'string') {
    logger.warn(`Translation not found for key: ${key}`);
    return key;
  }

  // Replace parameters in the string
  return interpolateString(value, params);
}

/**
 * Interpolate parameters in a string
 * @param {string} str - String with placeholders
 * @param {Object} params - Parameters to replace
 * @returns {string} Interpolated string
 */
function interpolateString(str, params) {
  return str.replace(/\{(\w+)\}/g, (match, key) => {
    return params[key] !== undefined ? params[key] : match;
  });
}

/**
 * Get all translations for a specific section
 * @param {string} section - Section key (e.g., 'auth', 'users')
 * @param {string} locale - Locale to use
 * @returns {Object} Section translations
 */
export function getSection(section, locale = DEFAULT_LOCALE) {
  const translations = locales[locale] || locales[DEFAULT_LOCALE];
  return translations[section] || {};
}

/**
 * Check if a translation key exists
 * @param {string} key - Translation key
 * @param {string} locale - Locale to check
 * @returns {boolean} True if key exists
 */
export function hasTranslation(key, locale = DEFAULT_LOCALE) {
  const translations = locales[locale] || locales[DEFAULT_LOCALE];
  const keys = key.split('.');
  let value = translations;

  for (const k of keys) {
    if (value && typeof value === 'object' && k in value) {
      value = value[k];
    } else {
      return false;
    }
  }

  return typeof value === 'string';
}

/**
 * Get current locale
 * @returns {string} Current locale
 */
export function getCurrentLocale() {
  return DEFAULT_LOCALE;
}

/**
 * Set locale for the session (can be extended for per-request locale)
 * @param {string} locale - Locale to set
 * @returns {boolean} Success status
 */
export function setLocale(locale) {
  if (locales[locale]) {
    // This could be extended to support per-request locale
    // For now, we'll keep it simple with Indonesian as default
    return true;
  }
  return false;
}

// Convenience functions for common translation patterns
export const translations = {
  // Success messages
  success: {
    created: () => t('crud.created'),
    updated: () => t('crud.updated'),
    deleted: () => t('crud.deleted'),
    retrieved: () => t('crud.retrieved'),
    operation: () => t('general.operationSuccessful')
  },

  // Error messages
  error: {
    notFound: () => t('http.notFound'),
    unauthorized: () => t('auth.notAuthenticated'),
    forbidden: () => t('auth.insufficientPermissions'),
    validation: () => t('http.validationFailed'),
    conflict: () => t('http.conflict'),
    internal: () => t('http.internalError'),
    database: () => t('http.databaseError')
  },

  // Authentication messages
  auth: {
    invalidCredentials: () => t('auth.invalidCredentials'),
    tokenExpired: () => t('auth.tokenExpired'),
    missingToken: () => t('auth.missingToken'),
    invalidToken: () => t('auth.invalidToken'),
    userNotFound: () => t('auth.userNotFound'),
    userInactive: () => t('auth.userInactive')
  },

  // User management messages
  users: {
    usernameExists: () => t('users.usernameAlreadyExists'),
    notFound: () => t('users.userNotFound'),
    created: () => t('users.userCreatedSuccessfully'),
    updated: () => t('users.userUpdatedSuccessfully'),
    deleted: () => t('users.userDeletedSuccessfully'),
    passwordChanged: () => t('users.passwordChangedSuccessfully')
  },

  // Ledger management messages
  ledgers: {
    notFound: () => t('ledgers.ledgerNotFound'),
    cannotUpdate: () => t('ledgers.cannotUpdatePostedLedger'),
    cannotDelete: () => t('ledgers.cannotDeletePostedLedger'),
    deleted: () => t('ledgers.ledgerDeletedSuccessfully'),
    noLedgersForDate: () => t('ledgers.noLedgersFoundForDate'),
    invalidDate: () => t('ledgers.invalidDateFormat')
  },

  // Posting messages
  posting: {
    noPendingLedgers: () => t('posting.noPendingLedgersFound'),
    alreadyPosted: date => t('posting.ledgersAlreadyPosted', { date }),
    successful: date => t('posting.ledgersPostedSuccessfully', { date }),
    shuCalculated: (action, year) => t('posting.shuCalculatedSuccessful', { action, year })
  }
};

// Export default translation function
export default t;
