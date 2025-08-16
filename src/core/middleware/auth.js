/**
 * Authentication and Authorization Middleware
 * Centralized auth logic for the application
 */

import bcrypt from 'bcrypt';
import { ERROR_MESSAGES, USER_ROLES } from '../../shared/constants/index.js';

/**
 * JWT Authentication middleware
 * Verifies JWT token and attaches user info to request
 */
export async function authenticate(request, reply) {
  try {
    await request.jwtVerify();
  } catch (err) {
    request.log.warn('JWT verification failed:', err.message);
    throw reply.unauthorized(ERROR_MESSAGES.UNAUTHORIZED);
  }
}

/**
 * Authorization middleware factory
 * Creates middleware that checks if user has required roles
 * @param {...string} allowedRoles - Roles that are allowed
 * @returns {Function} Middleware function
 */
export function authorize(...allowedRoles) {
  return async (request, reply) => {
    if (!request.user) {
      throw reply.unauthorized(ERROR_MESSAGES.UNAUTHORIZED);
    }

    const userRole = request.user.role;
    if (!allowedRoles.includes(userRole)) {
      throw reply.forbidden(ERROR_MESSAGES.FORBIDDEN);
    }
  };
}

/**
 * Admin-only middleware
 */
export const requireAdmin = authorize(USER_ROLES.ADMIN);

/**
 * Admin or Manager middleware
 */
export const requireAdminOrManager = authorize(USER_ROLES.ADMIN, USER_ROLES.MANAJER);

/**
 * Admin, Manager, or Accountant middleware
 */
export const requireAccountingAccess = authorize(
  USER_ROLES.ADMIN,
  USER_ROLES.MANAJER,
  USER_ROLES.AKUNTAN
);

/**
 * Resource ownership check middleware
 * Allows admin or the owner of the resource
 * @param {string} resourceUserIdField - Field name that contains the user ID in the resource
 * @returns {Function} Middleware function
 */
export function requireOwnerOrAdmin(resourceUserIdField = 'userId') {
  return async (request, reply) => {
    if (!request.user) {
      throw reply.unauthorized(ERROR_MESSAGES.UNAUTHORIZED);
    }

    const userRole = request.user.role;
    const { userId } = request.user;

    // Admin can access any resource
    if (userRole === USER_ROLES.ADMIN) {
      return;
    }

    // For other users, check ownership
    const resourceUserId = request.params[resourceUserIdField] || request.body[resourceUserIdField];
    if (userId !== resourceUserId) {
      throw reply.forbidden(ERROR_MESSAGES.FORBIDDEN);
    }
  };
}

/**
 * Check if resource is not soft deleted
 * @param {string} model - Prisma model name
 * @param {string} idField - ID field name (default: 'id')
 * @returns {Function} Middleware function
 */
export function checkNotDeleted(model, idField = 'id') {
  return async (request, reply) => {
    const id = request.params[idField];
    const resource = await request.server.prisma[model].findUnique({
      where: { id },
      select: { deletedAt: true }
    });

    if (!resource) {
      throw reply.notFound(ERROR_MESSAGES.NOT_FOUND);
    }

    if (resource.deletedAt) {
      throw reply.notFound('Resource has been deleted');
    }
  };
}

/**
 * Hash password utility
 * @param {string} password - Plain text password
 * @returns {Promise<string>} Hashed password
 */
export async function hashPassword(password) {
  const saltRounds = 12;
  return bcrypt.hash(password, saltRounds);
}

/**
 * Verify password utility
 * @param {string} password - Plain text password
 * @param {string} hashedPassword - Hashed password
 * @returns {Promise<boolean>} Password match result
 */
export async function verifyPassword(password, hashedPassword) {
  return bcrypt.compare(password, hashedPassword);
}
