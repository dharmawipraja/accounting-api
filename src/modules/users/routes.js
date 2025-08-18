/**
 * Express User Routes
 * User management endpoints for Express.js
 */

import { Router } from 'express';
import { body, query } from 'express-validator';
import {
  asyncHandler,
  createPaginatedResponse,
  createSuccessResponse
} from '../../core/errors/index.js';
import { authenticate, requireAdmin, requireOwnership } from '../../core/middleware/auth.js';
import { commonValidations, validationMiddleware } from '../../core/security/security.js';

const router = Router();

// Apply authentication to all user routes
router.use(authenticate);

/**
 * @swagger
 * /users:
 *   get:
 *     summary: Get all users (Admin only)
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *         description: Number of users per page
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search users by name or email
 *     responses:
 *       200:
 *         description: Users retrieved successfully
 *       403:
 *         description: Forbidden - Admin access required
 */
router.get(
  '/',
  requireAdmin,
  [
    ...commonValidations.pagination,
    query('search').optional().trim().isLength({ max: 100 }).withMessage('Search term too long')
  ],
  validationMiddleware,
  asyncHandler(async (req, res) => {
    const { page = 1, limit = 10, search } = req.query;
    const skip = (page - 1) * limit;

    const whereClause = search
      ? {
          OR: [
            { username: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } }
          ]
        }
      : {};

    const [users, total] = await Promise.all([
      req.app.locals.prisma.user.findMany({
        where: whereClause,
        select: {
          id: true,
          username: true,
          role: true,
          status: true,
          createdAt: true,
          updatedAt: true
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' }
      }),
      req.app.locals.prisma.user.count({ where: whereClause })
    ]);

    res.json(
      createPaginatedResponse(users, { page, limit, total }, 'Users retrieved successfully')
    );
  })
);

/**
 * @swagger
 * /users/{id}:
 *   get:
 *     summary: Get user by ID
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID
 *     responses:
 *       200:
 *         description: User retrieved successfully
 *       404:
 *         description: User not found
 *       403:
 *         description: Forbidden - Can only access own profile unless admin
 */
router.get(
  '/:id',
  [commonValidations.id],
  validationMiddleware,
  requireOwnership('id'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const user = await req.app.locals.prisma.user.findUnique({
      where: { id },
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
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: 'User not found'
      });
    }

    res.json(createSuccessResponse(user, 'User retrieved successfully'));
  })
);

/**
 * @swagger
 * /users:
 *   post:
 *     summary: Create new user (Admin only)
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - username
 *               - email
 *               - password
 *               - role
 *             properties:
 *               username:
 *                 type: string
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *               role:
 *                 type: string
 *     responses:
 *       201:
 *         description: User created successfully
 *       400:
 *         description: Validation error
 *       403:
 *         description: Forbidden - Admin access required
 */
router.post(
  '/',
  requireAdmin,
  [
    commonValidations.username,
    commonValidations.password,
    body('role').isIn(['ADMIN', 'MANAJER', 'AKUNTAN', 'USER']).withMessage('Invalid role')
  ],
  validationMiddleware,
  asyncHandler(async (req, res) => {
    const { username, email, password, role } = req.body;

    // Check if user already exists
    const existingUser = await req.app.locals.prisma.user.findFirst({
      where: {
        OR: [{ username }, { email }]
      }
    });

    if (existingUser) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'User with this username or email already exists'
      });
    }

    // Hash password
    const bcrypt = await import('bcrypt');
    const hashedPassword = await bcrypt.hash(password, 12);

    const user = await req.app.locals.prisma.user.create({
      data: {
        username,
        email,
        password: hashedPassword,
        role,
        status: true
      },
      select: {
        id: true,
        username: true,
        role: true,
        status: true,
        createdAt: true
      }
    });

    res.status(201).json(createSuccessResponse(user, 'User created successfully'));
  })
);

/**
 * @swagger
 * /users/{id}:
 *   put:
 *     summary: Update user
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email:
 *                 type: string
 *               role:
 *                 type: string
 *               isActive:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: User updated successfully
 *       404:
 *         description: User not found
 *       403:
 *         description: Forbidden
 */
router.put(
  '/:id',
  [commonValidations.id],
  validationMiddleware,
  requireOwnership('id'),
  [
    body('email').optional().isEmail().normalizeEmail().withMessage('Invalid email format'),
    body('role')
      .optional()
      .isIn(['ADMIN', 'MANAJER', 'AKUNTAN', 'USER'])
      .withMessage('Invalid role'),
    body('isActive').optional().isBoolean().withMessage('isActive must be a boolean')
  ],
  validationMiddleware,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const updates = req.body;

    // Non-admin users can only update their own email
    if (req.user.role !== 'ADMIN') {
      const allowedFields = ['email'];
      const updateKeys = Object.keys(updates);
      const invalidFields = updateKeys.filter(key => !allowedFields.includes(key));

      if (invalidFields.length > 0) {
        return res.status(403).json({
          success: false,
          error: 'Forbidden',
          message: 'You can only update your email address'
        });
      }
    }

    const user = await req.app.locals.prisma.user.update({
      where: { id },
      data: updates,
      select: {
        id: true,
        username: true,
        role: true,
        status: true,
        updatedAt: true
      }
    });

    res.json(createSuccessResponse(user, 'User updated successfully'));
  })
);

/**
 * @swagger
 * /users/{id}:
 *   delete:
 *     summary: Delete user (Admin only)
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID
 *     responses:
 *       200:
 *         description: User deleted successfully
 *       404:
 *         description: User not found
 *       403:
 *         description: Forbidden - Admin access required
 */
router.delete(
  '/:id',
  requireAdmin,
  [commonValidations.id],
  validationMiddleware,
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    // Prevent self-deletion
    if (req.user.id === id) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Cannot delete your own account'
      });
    }

    await req.app.locals.prisma.user.delete({
      where: { id }
    });

    res.json(createSuccessResponse({ deletedId: id }, 'User deleted successfully'));
  })
);

export { router as userRoutes };
