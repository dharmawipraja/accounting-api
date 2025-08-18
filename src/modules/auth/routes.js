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

/**
 * @swagger
 * /auth/login:
 *   post:
 *     summary: User login
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - username
 *               - password
 *             properties:
 *               username:
 *                 type: string
 *                 description: Username or email
 *               password:
 *                 type: string
 *                 description: User password
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 data:
 *                   type: object
 *                   properties:
 *                     token:
 *                       type: string
 *                     user:
 *                       type: object
 *       400:
 *         description: Invalid credentials
 *       429:
 *         description: Too many requests
 */
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
    const { username, password } = req.body;
    const jwtSecret = env.JWT_SECRET || req.app.locals.config?.security?.jwtSecret;

    const authController = new AuthController(req.app.locals.prisma, jwtSecret);
    const result = await authController.login({ body: { username, password } });

    res.json(createSuccessResponse(result.data, 'Login successful'));
  })
);

/**
 * @swagger
 * /auth/logout:
 *   post:
 *     summary: User logout
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Logout successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 data:
 *                   type: object
 *                   properties:
 *                     message:
 *                       type: string
 *       401:
 *         description: Unauthorized
 */
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

/**
 * @swagger
 * /auth/profile:
 *   get:
 *     summary: Get current user profile
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Profile retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 data:
 *                   type: object
 *                   properties:
 *                     user:
 *                       type: object
 *       401:
 *         description: Unauthorized
 */
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

/**
 * @swagger
 * /auth/refresh:
 *   post:
 *     summary: Refresh JWT token
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Token refreshed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 data:
 *                   type: object
 *                   properties:
 *                     token:
 *                       type: string
 *       401:
 *         description: Unauthorized
 */
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
      email: req.user.email,
      role: req.user.role
    });

    res.json(createSuccessResponse({ token: newToken }, 'Token refreshed successfully'));
  })
);

export { router as authRoutes };
