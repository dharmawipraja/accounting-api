/**
 * Data Encryption Utilities
 *
 * This module provides encryption utilities for sensitive data using Node.js
 * built-in crypto module. Uses AES-256-GCM for authenticated encryption.
 */

import * as crypto from 'crypto';

/**
 * Generate a secure random token
 */
export function generateToken(length = 32) {
  return crypto.randomBytes(length).toString('hex');
}

/**
 * Generate a UUID v4
 */
export function generateUUID() {
  return crypto.randomUUID();
}

/**
 * Hash data using SHA-256
 */
export function hash(data, algorithm = 'sha256') {
  return crypto.createHash(algorithm).update(data).digest('hex');
}
