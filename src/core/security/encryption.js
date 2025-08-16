/**
 * Data Encryption Utilities
 *
 * This module provides encryption utilities for sensitive data using Node.js
 * built-in crypto module. Uses AES-256-GCM for authenticated encryption.
 */

import * as crypto from 'crypto';
import { z } from 'zod';

// Encryption algorithm
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16; // AES block size
const SALT_LENGTH = 32; // Salt length for key derivation

/**
 * Generate a cryptographically secure random key
 */
export function generateKey() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Generate a cryptographically secure random IV
 */
export function generateIV() {
  return crypto.randomBytes(IV_LENGTH);
}

/**
 * Generate a cryptographically secure salt
 */
export function generateSalt() {
  return crypto.randomBytes(SALT_LENGTH);
}

/**
 * Derive encryption key from password using PBKDF2
 */
export function deriveKey(password, salt, iterations = 100000) {
  return crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha512');
}

/**
 * Encrypt data using AES-256-GCM
 */
export function encrypt(data, key) {
  try {
    const iv = crypto.randomBytes(16);

    // Use scrypt to derive a proper 32-byte key from the input key
    const derivedKey = crypto.scryptSync(key, 'salt', 32);

    const cipher = crypto.createCipheriv(ALGORITHM, derivedKey, iv);

    let encrypted = cipher.update(data, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    return {
      encrypted,
      iv: iv.toString('hex'),
      tag: authTag.toString('hex')
    };
  } catch (error) {
    throw new Error(`Encryption failed: ${error.message}`);
  }
} /**
 * Decrypt data using AES-256-GCM
 */
export function decrypt(encryptedData, key) {
  try {
    const { encrypted, iv, tag } = encryptedData;

    // Use scrypt to derive the same key
    const derivedKey = crypto.scryptSync(key, 'salt', 32);

    const decipher = crypto.createDecipheriv(ALGORITHM, derivedKey, Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(tag, 'hex'));

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (error) {
    throw new Error(`Decryption failed: ${error.message}`);
  }
}

/**
 * Encrypt data with password-based encryption
 */
export function encryptWithPassword(text, password) {
  try {
    const salt = generateSalt();
    const key = deriveKey(password, salt);
    const encrypted = encrypt(text, key);

    return {
      salt: salt.toString('hex'),
      ...encrypted
    };
  } catch (error) {
    throw new Error(`Password encryption failed: ${error.message}`);
  }
}

/**
 * Decrypt data with password-based encryption
 */
export function decryptWithPassword(encryptedObj, password) {
  try {
    const { salt, ...encryptedData } = encryptedObj;
    const key = deriveKey(password, Buffer.from(salt, 'hex'));

    return decrypt(encryptedData, key);
  } catch (error) {
    throw new Error(`Password decryption failed: ${error.message}`);
  }
}

/**
 * Hash data using SHA-256
 */
export function hash(data, algorithm = 'sha256') {
  return crypto.createHash(algorithm).update(data).digest('hex');
}

/**
 * Create HMAC signature
 */
export function createHmac(data, secret, algorithm = 'sha256') {
  return crypto.createHmac(algorithm, secret).update(data).digest('hex');
}

/**
 * Verify HMAC signature
 */
export function verifyHmac(data, signature, secret, algorithm = 'sha256') {
  const expectedSignature = createHmac(data, secret, algorithm);
  return crypto.timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(expectedSignature, 'hex')
  );
}

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
 * Encrypt sensitive fields in an object
 */
export function encryptSensitiveFields(obj, sensitiveFields, key) {
  const result = { ...obj };

  for (const field of sensitiveFields) {
    if (result[field]) {
      result[field] = encrypt(String(result[field]), key);
    }
  }

  return result;
}

/**
 * Decrypt sensitive fields in an object
 */
export function decryptSensitiveFields(obj, sensitiveFields, key) {
  const result = { ...obj };

  for (const field of sensitiveFields) {
    if (result[field] && typeof result[field] === 'object') {
      try {
        result[field] = decrypt(result[field], key);
      } catch (error) {
        // Leave field as is if decryption fails
        console.warn(`Failed to decrypt field ${field}:`, error.message);
      }
    }
  }

  return result;
}

/**
 * Zod schema for encrypted data
 */
export const encryptedDataSchema = z.object({
  iv: z.string(),
  tag: z.string(),
  data: z.string()
});

/**
 * Zod schema for password-encrypted data
 */
export const passwordEncryptedDataSchema = z.object({
  salt: z.string(),
  iv: z.string(),
  tag: z.string(),
  data: z.string()
});

/**
 * Fastify decorator for encryption utilities
 */
export async function encryptionPlugin(fastify, options = {}) {
  const { encryptionKey } = options;

  if (!encryptionKey) {
    throw new Error('Encryption key is required');
  }

  // Decorate fastify instance with encryption utilities
  fastify.decorate('encryption', {
    encrypt: text => encrypt(text, encryptionKey),
    decrypt: encryptedObj => decrypt(encryptedObj, encryptionKey),
    encryptSensitiveFields: (obj, fields) => encryptSensitiveFields(obj, fields, encryptionKey),
    decryptSensitiveFields: (obj, fields) => decryptSensitiveFields(obj, fields, encryptionKey),
    hash,
    createHmac: (data, secret) => createHmac(data, secret || encryptionKey),
    verifyHmac: (data, signature, secret) => verifyHmac(data, signature, secret || encryptionKey),
    generateToken,
    generateUUID
  });
}
