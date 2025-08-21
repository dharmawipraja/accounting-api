/**
 * Authentication and Authorization Middleware
 * Centralized auth logic for Express.js
 */

import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { ERROR_MESSAGES, USER_ROLES } from '../../shared/constants/index.js';
import { authErrors, errors } from '../errors/index.js';

/**
 * JWT Authentication middleware
 * Verifies JWT token and attaches user info to request
 */
export async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw authErrors.missingToken();
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    try {
      // Use JWT secret from environment or config
      const jwtSecret = env.JWT_SECRET || req.app.locals.config?.security?.jwtSecret;
      if (!jwtSecret) {
        throw errors.internal('JWT secret not configured');
      }

      const decoded = jwt.verify(token, jwtSecret);

      // Get user from database
      const { container } = req.app.locals;
      if (!container) {
        throw errors.internal('Application container not available');
      }

      const prisma = container.get('prisma');
      if (!prisma) {
        throw errors.internal('Database connection not available');
      }

      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: {
          id: true,
          username: true,
          role: true,
          status: true,
          createdAt: true,
          updatedAt: true
        }
      });

      if (!user) {
        throw authErrors.userNotFound();
      }

      if (user.status !== 'ACTIVE') {
        throw authErrors.userInactive();
      }

      // Attach user to request
      req.user = user;
      next();
    } catch (jwtError) {
      if (jwtError.name === 'TokenExpiredError') {
        throw authErrors.tokenExpired();
      }
      if (jwtError.name === 'JsonWebTokenError') {
        throw authErrors.invalidToken();
      }
      throw jwtError;
    }
  } catch (error) {
    next(error);
  }
}

/**
 * Authorization middleware factory for Express
 * Creates middleware that checks if user has required roles
 * @param {...string} allowedRoles - Roles that are allowed
 * @returns {Function} Middleware function
 */
export function authorize(...allowedRoles) {
  return (req, res, next) => {
    try {
      if (!req.user) {
        throw authErrors.missingToken();
      }

      if (!allowedRoles.includes(req.user.role)) {
        throw errors.authorization(ERROR_MESSAGES.AUTH.INSUFFICIENT_PERMISSIONS);
      }

      next();
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Admin-only middleware
 */
export const requireAdmin = authorize(USER_ROLES.ADMIN);

/**
 * Admin, Manager, or Accountant middleware
 */
export const requireAccountingAccess = authorize(
  USER_ROLES.ADMIN,
  USER_ROLES.MANAJER,
  USER_ROLES.AKUNTAN
);

/**
 * Password hashing utility
 * @param {string} password - Plain text password
 * @returns {Promise<string>} Hashed password
 */
export async function hashPassword(password) {
  const saltRounds = 12;
  return bcrypt.hash(password, saltRounds);
}

/**
 * Password verification utility
 * @param {string} password - Plain text password
 * @param {string} hashedPassword - Hashed password from database
 * @returns {Promise<boolean>} True if password matches
 */
export async function verifyPassword(password, hashedPassword) {
  return bcrypt.compare(password, hashedPassword);
}

/**
 * Generate JWT token
 * @param {Object} payload - Token payload
 * @param {string} secret - JWT secret
 * @param {Object} options - JWT options
 * @returns {string} JWT token
 */
export function generateToken(payload, secret, options = {}) {
  const defaultOptions = {
    expiresIn: '24h',
    issuer: 'accounting-api',
    audience: 'accounting-api-users'
  };

  return jwt.sign(payload, secret, { ...defaultOptions, ...options });
}

/**
 * User ownership middleware
 * Ensures user can only access their own resources (or admin can access all)
 */
export function requireOwnership(userIdParam = 'userId') {
  return (req, res, next) => {
    try {
      if (!req.user) {
        throw authErrors.missingToken();
      }

      const requestedUserId = req.params[userIdParam];

      // Admin can access any resource
      if (req.user.role === USER_ROLES.ADMIN) {
        return next();
      }

      // User can only access their own resources
      if (req.user.id !== requestedUserId) {
        throw errors.authorization(ERROR_MESSAGES.AUTH.INSUFFICIENT_PERMISSIONS);
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}
