/**
 * Express Auth Routes
 * Authentication endpoints for Express.js using dependency injection
 */

import { Router } from 'express';
import { body } from 'express-validator';
import { asyncHandler } from '../../core/errors/index.js';
import { authenticate } from '../../core/middleware/auth.js';
import { validationMiddleware } from '../../core/security/security.js';

/**
 * Create auth routes with dependency injection
 * @param {Object} container - Dependency injection container
 * @returns {Router} Express router
 */
export function createAuthRoutes(container) {
  const router = Router();
  const authController = container.get('authController');

  // Login endpoint
  router.post(
    '/login',
    [
      body('username')
        .trim()
        .notEmpty()
        .withMessage('Username is required')
        .isLength({ min: 3, max: 50 })
        .withMessage('Username must be between 3 and 50 characters'),
      body('password')
        .notEmpty()
        .withMessage('Password is required')
        .isLength({ min: 6 })
        .withMessage('Password must be at least 6 characters')
    ],
    validationMiddleware,
    asyncHandler(async (req, res) => {
      await authController.login(req, res);
    })
  );

  // Logout endpoint
  router.post(
    '/logout',
    authenticate,
    asyncHandler(async (req, res) => {
      await authController.logout(req, res);
    })
  );

  // Get profile endpoint
  router.get(
    '/profile',
    authenticate,
    asyncHandler(async (req, res) => {
      await authController.getProfile(req, res);
    })
  );

  // Refresh token endpoint
  router.post(
    '/refresh',
    authenticate,
    asyncHandler(async (req, res) => {
      await authController.refreshToken(req, res);
    })
  );

  return router;
}
