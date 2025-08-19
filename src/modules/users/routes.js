/**
 * Express User Routes
 * User management endpoints using dependency injection
 */

import { Router } from 'express';
import { body, query } from 'express-validator';
import { asyncHandler } from '../../core/errors/index.js';
import { authenticate, requireAdmin, requireOwnership } from '../../core/middleware/auth.js';
import { commonValidations, validationMiddleware } from '../../core/security/security.js';

/**
 * Create user routes with dependency injection
 * @param {Object} container - Dependency injection container
 * @returns {Router} Express router
 */
export function createUserRoutes(container) {
  const router = Router();
  const usersController = container.get('usersController');

  // Apply authentication to all user routes
  router.use(authenticate);

  // Get all users (admin only)
  router.get(
    '/',
    requireAdmin,
    [
      ...commonValidations.pagination,
      query('search').optional().trim().isLength({ max: 100 }).withMessage('Search term too long')
    ],
    validationMiddleware,
    asyncHandler(async (req, res) => {
      await usersController.getUsers(req, res);
    })
  );

  // Get user by ID
  router.get(
    '/:id',
    [commonValidations.id],
    validationMiddleware,
    requireOwnership('id'),
    asyncHandler(async (req, res) => {
      await usersController.getUserById(req, res);
    })
  );

  // Create new user (admin only)
  router.post(
    '/',
    requireAdmin,
    [
      body('username')
        .trim()
        .notEmpty()
        .withMessage('Username is required')
        .isLength({ min: 3, max: 50 })
        .withMessage('Username must be between 3 and 50 characters'),
      body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
      body('name')
        .trim()
        .notEmpty()
        .withMessage('Name is required')
        .isLength({ max: 100 })
        .withMessage('Name is too long'),
      body('role')
        .isIn(['ADMIN', 'MANAJER', 'AKUNTAN', 'KASIR', 'KOLEKTOR', 'NASABAH'])
        .withMessage('Invalid role')
    ],
    validationMiddleware,
    asyncHandler(async (req, res) => {
      await usersController.createUser(req, res);
    })
  );

  // Update user
  router.put(
    '/:id',
    [
      commonValidations.id,
      body('username')
        .optional()
        .trim()
        .isLength({ min: 3, max: 50 })
        .withMessage('Username must be between 3 and 50 characters'),
      body('name').optional().trim().isLength({ max: 100 }).withMessage('Name is too long'),
      body('role')
        .optional()
        .isIn(['ADMIN', 'MANAJER', 'AKUNTAN', 'KASIR', 'KOLEKTOR', 'NASABAH'])
        .withMessage('Invalid role'),
      body('status').optional().isIn(['ACTIVE', 'INACTIVE']).withMessage('Invalid status')
    ],
    validationMiddleware,
    requireOwnership('id'),
    asyncHandler(async (req, res) => {
      await usersController.updateUser(req, res);
    })
  );

  // Delete user (admin only)
  router.delete(
    '/:id',
    requireAdmin,
    [commonValidations.id],
    validationMiddleware,
    asyncHandler(async (req, res) => {
      await usersController.deleteUser(req, res);
    })
  );

  return router;
}

// Export for backward compatibility
export { createUserRoutes as userRoutes };
