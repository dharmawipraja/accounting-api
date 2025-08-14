/**
 * Authentication and Authorization Middleware
 */

import bcrypt from 'bcrypt';

/**
 * Hash password using bcrypt
 */
export const hashPassword = async password => {
  const saltRounds = 12;
  return await bcrypt.hash(password, saltRounds);
};

/**
 * Verify password using bcrypt
 */
export const verifyPassword = async (password, hash) => {
  return await bcrypt.compare(password, hash);
};

/**
 * Authentication middleware - verifies JWT token
 */
export const authenticate = async (request, reply) => {
  try {
    await request.jwtVerify();
  } catch (err) {
    request.log.warn('JWT verification failed:', err.message);
    throw reply.unauthorized('Authentication required');
  }
};

/**
 * Authorization middleware - checks if user has required role(s)
 */
export const authorize = (...allowedRoles) => {
  return async (request, reply) => {
    // First ensure user is authenticated
    await authenticate(request, reply);

    const userRole = request.user.role;

    if (!allowedRoles.includes(userRole)) {
      throw reply.forbidden(`Access denied. Required roles: ${allowedRoles.join(', ')}`);
    }
  };
};

/**
 * Check if user can manage other users (Admin or Manager only)
 */
export const canManageUsers = authorize('ADMIN', 'MANAJER');

/**
 * Check if user is admin
 */
export const requireAdmin = authorize('ADMIN');

/**
 * Check if user is admin or manager
 */
export const requireAdminOrManager = authorize('ADMIN', 'MANAJER');

/**
 * Soft delete check - ensures user is not accessing deleted resources
 */
export const checkNotDeleted = entity => {
  if (entity && entity.deletedAt) {
    throw new Error('Resource has been deleted');
  }
  return entity;
};

/**
 * Owner or admin check - user can access their own resources or admin can access all
 */
export const requireOwnerOrAdmin = async (request, reply) => {
  await authenticate(request, reply);

  const userRole = request.user.role;
  const userId = request.user.id;
  const targetUserId = request.params.id;

  // Admin can access any resource
  if (userRole === 'ADMIN') {
    return;
  }

  // User can only access their own resources
  if (userId !== targetUserId) {
    throw reply.forbidden('You can only access your own resources');
  }
};
