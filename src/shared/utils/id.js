/**
 * ID Generation Utilities
 * Centralized ID generation functions
 */

import { ulid } from 'ulid';

/**
 * Generate a unique ULID
 * @returns {string} Generated ULID
 */
export const generateId = () => ulid();

/**
 * Generate multiple unique ULIDs
 * @param {number} count - Number of IDs to generate
 * @returns {string[]} Array of generated ULIDs
 */
export const generateIds = count => {
  return Array.from({ length: count }, () => ulid());
};

/**
 * Validate if a string is a valid ULID
 * @param {string} id - ID to validate
 * @returns {boolean} True if valid ULID
 */
export const isValidId = id => {
  if (typeof id !== 'string') {
    return false;
  }

  // ULID characters: 0123456789ABCDEFGHJKMNPQRSTVWXYZ
  const ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
  return ulidRegex.test(id);
};

/**
 * Generate a ULID with timestamp prefix for sorting
 * @param {Date} [timestamp] - Optional timestamp (defaults to now)
 * @returns {string} Generated ULID
 */
export const generateTimestampedId = (timestamp = new Date()) => {
  return ulid(timestamp.getTime());
};
