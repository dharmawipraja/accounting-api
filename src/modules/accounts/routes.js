/**
 * Express Accounts Routes
 * Account management endpoints for Express.js
 */

import { Router } from 'express';
import { body, query } from 'express-validator';
import {
  asyncHandler,
  createPaginatedResponse,
  createSuccessResponse
} from '../../core/errors/index.js';
import { authenticate, requireAccountingAccess } from '../../core/middleware/auth.js';
import { commonValidations, validationMiddleware } from '../../core/security/security.js';

const router = Router();

// Apply authentication to all account routes
router.use(authenticate);

// Require accounting access for all routes
router.use(requireAccountingAccess);

/**
 * @swagger
 * /accounts:
 *   get:
 *     summary: Get all accounts
 *     tags: [Accounts]
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
 *         description: Number of accounts per page
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *         description: Filter by account type
 *     responses:
 *       200:
 *         description: Accounts retrieved successfully
 */
router.get(
  '/',
  [
    ...commonValidations.pagination,
    query('type').optional().trim().isLength({ max: 50 }).withMessage('Type filter too long')
  ],
  validationMiddleware,
  asyncHandler(async (req, res) => {
    const { page = 1, limit = 10, type } = req.query;
    const skip = (page - 1) * limit;

    const whereClause = type ? { type } : {};

    const [accounts, total] = await Promise.all([
      req.app.locals.prisma.account.findMany({
        where: whereClause,
        skip,
        take: limit,
        orderBy: { code: 'asc' }
      }),
      req.app.locals.prisma.account.count({ where: whereClause })
    ]);

    res.json(
      createPaginatedResponse(accounts, { page, limit, total }, 'Accounts retrieved successfully')
    );
  })
);

/**
 * @swagger
 * /accounts/{id}:
 *   get:
 *     summary: Get account by ID
 *     tags: [Accounts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Account ID
 *     responses:
 *       200:
 *         description: Account retrieved successfully
 *       404:
 *         description: Account not found
 */
router.get(
  '/:id',
  [commonValidations.id],
  validationMiddleware,
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const account = await req.app.locals.prisma.account.findUnique({
      where: { id }
    });

    if (!account) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: 'Account not found'
      });
    }

    res.json(createSuccessResponse(account, 'Account retrieved successfully'));
  })
);

/**
 * @swagger
 * /accounts:
 *   post:
 *     summary: Create new account
 *     tags: [Accounts]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - code
 *               - name
 *               - type
 *             properties:
 *               code:
 *                 type: string
 *               name:
 *                 type: string
 *               type:
 *                 type: string
 *               description:
 *                 type: string
 *     responses:
 *       201:
 *         description: Account created successfully
 *       400:
 *         description: Validation error
 */
router.post(
  '/',
  [
    body('code')
      .trim()
      .notEmpty()
      .withMessage('Account code is required')
      .isLength({ min: 1, max: 20 })
      .withMessage('Account code must be between 1 and 20 characters'),
    body('name')
      .trim()
      .notEmpty()
      .withMessage('Account name is required')
      .isLength({ min: 1, max: 100 })
      .withMessage('Account name must be between 1 and 100 characters'),
    body('type').trim().notEmpty().withMessage('Account type is required'),
    body('description')
      .optional()
      .trim()
      .isLength({ max: 500 })
      .withMessage('Description must not exceed 500 characters')
  ],
  validationMiddleware,
  asyncHandler(async (req, res) => {
    const { code, name, type, description } = req.body;

    // Check if account code already exists
    const existingAccount = await req.app.locals.prisma.account.findUnique({
      where: { code }
    });

    if (existingAccount) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Account with this code already exists'
      });
    }

    const account = await req.app.locals.prisma.account.create({
      data: {
        code,
        name,
        type,
        description,
        balance: 0 // Default balance
      }
    });

    res.status(201).json(createSuccessResponse(account, 'Account created successfully'));
  })
);

/**
 * @swagger
 * /accounts/{id}:
 *   put:
 *     summary: Update account
 *     tags: [Accounts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Account ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               isActive:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Account updated successfully
 *       404:
 *         description: Account not found
 */
router.put(
  '/:id',
  [commonValidations.id],
  validationMiddleware,
  [
    body('name')
      .optional()
      .trim()
      .isLength({ min: 1, max: 100 })
      .withMessage('Account name must be between 1 and 100 characters'),
    body('description')
      .optional()
      .trim()
      .isLength({ max: 500 })
      .withMessage('Description must not exceed 500 characters'),
    body('isActive').optional().isBoolean().withMessage('isActive must be a boolean')
  ],
  validationMiddleware,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const updates = req.body;

    const account = await req.app.locals.prisma.account.update({
      where: { id },
      data: updates
    });

    res.json(createSuccessResponse(account, 'Account updated successfully'));
  })
);

/**
 * @swagger
 * /accounts/{id}:
 *   delete:
 *     summary: Delete account
 *     tags: [Accounts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Account ID
 *     responses:
 *       200:
 *         description: Account deleted successfully
 *       404:
 *         description: Account not found
 */
router.delete(
  '/:id',
  [commonValidations.id],
  validationMiddleware,
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    // Check if account has transactions before deleting
    const transactionCount = await req.app.locals.prisma.transaction.count({
      where: {
        OR: [{ debitAccountId: id }, { creditAccountId: id }]
      }
    });

    if (transactionCount > 0) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Cannot delete account with existing transactions'
      });
    }

    await req.app.locals.prisma.account.delete({
      where: { id }
    });

    res.json(createSuccessResponse({ deletedId: id }, 'Account deleted successfully'));
  })
);

export { router as accountsRoutes };
