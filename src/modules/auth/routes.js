/**
 * Express Auth Routes
 * Authentication endpoints for Express.js
 */

import { Router } from 'express';
import { body } from 'express-validator';
import { env } from '../../config/env.js';
import { asyncHandler, createSuccessResponse } from '../../core/errors/index.js';
import { authenticate } from '../../core/middleware/auth.js';
import { validationMiddleware } from '../../core/security/security.js';
import { AuthController } from './controller.js';

const router = Router();

router.post(
  '/login',
  // Validation middleware
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
    const jwtSecret = env.JWT_SECRET || req.app.locals.config?.security?.jwtSecret;
    const authController = new AuthController(req.app.locals.prisma, jwtSecret);

    await authController.login(req, res);
  })
);

router.post(
  '/logout',
  authenticate,
  asyncHandler(async (req, res) => {
    // In JWT-based auth, logout is primarily client-side token removal
    // But we can log the logout event for audit purposes
    req.log?.info(
      {
        audit: {
          action: 'logout',
          userId: req.user.id,
          userEmail: req.user.email,
          ip: req.ip,
          timestamp: new Date().toISOString()
        }
      },
      `User logout: ${req.user.email}`
    );

    res.json(createSuccessResponse({ message: 'Logged out successfully' }, 'Logout successful'));
  })
);

router.get(
  '/profile',
  authenticate,
  asyncHandler(async (req, res) => {
    // Return user profile without sensitive information
    // eslint-disable-next-line no-unused-vars
    const { password: _password, ...userProfile } = req.user;

    res.json(createSuccessResponse({ user: userProfile }, 'Profile retrieved successfully'));
  })
);

router.post(
  '/refresh',
  authenticate,
  asyncHandler(async (req, res) => {
    const jwtSecret = env.JWT_SECRET || req.app.locals.config?.security?.jwtSecret;
    const authController = new AuthController(req.app.locals.prisma, jwtSecret);

    // Generate new token with current user data
    const newToken = authController.generateToken({
      userId: req.user.id,
      username: req.user.username,
      role: req.user.role
    });

    res.json(createSuccessResponse({ token: newToken }, 'Token refreshed successfully'));
  })
);

export { router as authRoutes };
