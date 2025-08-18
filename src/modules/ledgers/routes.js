/**
 * Express Ledgers Routes
 * Ledger management endpoints for Express.js
 */

import { Router } from 'express';
import { body, param, query } from 'express-validator';
import {
  asyncHandler,
  createPaginatedResponse,
  createSuccessResponse
} from '../../core/errors/index.js';
import { authenticate, requireAccountingAccess } from '../../core/middleware/auth.js';
import { commonValidations, validationMiddleware } from '../../core/security/security.js';

const router = Router();

// Apply authentication to all ledger routes
router.use(authenticate);

// Require accounting access for all routes
router.use(requireAccountingAccess);

/**
 * @swagger
 * /ledgers:
 *   get:
 *     summary: Get all ledger entries
 *     tags: [Ledgers]
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
 *         description: Number of entries per page
 *       - in: query
 *         name: accountId
 *         schema:
 *           type: string
 *         description: Filter by account ID
 *     responses:
 *       200:
 *         description: Ledger entries retrieved successfully
 */
router.get(
  '/',
  [
    ...commonValidations.pagination,
    query('accountId').optional().isUUID().withMessage('Invalid account ID format')
  ],
  validationMiddleware,
  asyncHandler(async (req, res) => {
    const { page = 1, limit = 10, accountId } = req.query;
    const skip = (page - 1) * limit;

    const whereClause = accountId ? { accountId } : {};

    const [entries, total] = await Promise.all([
      req.app.locals.prisma.ledgerEntry.findMany({
        where: whereClause,
        include: {
          account: {
            select: {
              code: true,
              name: true
            }
          },
          transaction: {
            select: {
              id: true,
              description: true,
              date: true
            }
          }
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' }
      }),
      req.app.locals.prisma.ledgerEntry.count({ where: whereClause })
    ]);

    res.json(
      createPaginatedResponse(
        entries,
        { page, limit, total },
        'Ledger entries retrieved successfully'
      )
    );
  })
);

/**
 * @swagger
 * /ledgers/{id}:
 *   get:
 *     summary: Get ledger entry by ID
 *     tags: [Ledgers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Ledger entry ID
 *     responses:
 *       200:
 *         description: Ledger entry retrieved successfully
 *       404:
 *         description: Ledger entry not found
 */
router.get(
  '/:id',
  [commonValidations.id],
  validationMiddleware,
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const entry = await req.app.locals.prisma.ledgerEntry.findUnique({
      where: { id },
      include: {
        account: true,
        transaction: true
      }
    });

    if (!entry) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: 'Ledger entry not found'
      });
    }

    res.json(createSuccessResponse(entry, 'Ledger entry retrieved successfully'));
  })
);

/**
 * @swagger
 * /ledgers/transactions:
 *   post:
 *     summary: Create new transaction with ledger entries
 *     tags: [Ledgers]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - description
 *               - entries
 *             properties:
 *               description:
 *                 type: string
 *               date:
 *                 type: string
 *                 format: date
 *               entries:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required:
 *                     - accountId
 *                     - type
 *                     - amount
 *                   properties:
 *                     accountId:
 *                       type: string
 *                     type:
 *                       type: string
 *                       enum: [debit, credit]
 *                     amount:
 *                       type: number
 *     responses:
 *       201:
 *         description: Transaction created successfully
 *       400:
 *         description: Validation error
 */
router.post(
  '/transactions',
  [
    body('description')
      .trim()
      .notEmpty()
      .withMessage('Description is required')
      .isLength({ min: 1, max: 500 })
      .withMessage('Description must be between 1 and 500 characters'),
    body('date').optional().isISO8601().withMessage('Invalid date format'),
    body('entries')
      .isArray({ min: 2 })
      .withMessage('At least 2 entries are required for a transaction'),
    body('entries.*.accountId').isUUID().withMessage('Invalid account ID format'),
    body('entries.*.type')
      .isIn(['debit', 'credit'])
      .withMessage('Entry type must be debit or credit'),
    body('entries.*.amount').isFloat({ min: 0.01 }).withMessage('Amount must be a positive number')
  ],
  validationMiddleware,
  asyncHandler(async (req, res) => {
    const { description, date, entries } = req.body;

    // Validate that debits equal credits
    const totalDebits = entries
      .filter(entry => entry.type === 'debit')
      .reduce((sum, entry) => sum + entry.amount, 0);

    const totalCredits = entries
      .filter(entry => entry.type === 'credit')
      .reduce((sum, entry) => sum + entry.amount, 0);

    if (totalDebits !== totalCredits) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Total debits must equal total credits'
      });
    }

    // Create transaction with ledger entries in a database transaction
    const result = await req.app.locals.prisma.$transaction(async prisma => {
      // Create the transaction record
      const transaction = await prisma.transaction.create({
        data: {
          description,
          date: date ? new Date(date) : new Date(),
          amount: totalDebits, // Store total amount
          userId: req.user.id
        }
      });

      // Create ledger entries
      const ledgerEntries = await Promise.all(
        entries.map(entry =>
          prisma.ledgerEntry.create({
            data: {
              accountId: entry.accountId,
              transactionId: transaction.id,
              type: entry.type.toUpperCase(),
              amount: entry.amount,
              description: entry.description || description
            }
          })
        )
      );

      // Note: Account balances are maintained in the amountCredit/amountDebit fields
      // and should be updated through proper accounting procedures
      // This is a simplified implementation - in a real system, you'd want more sophisticated balance management

      return { transaction, ledgerEntries };
    });

    res.status(201).json(createSuccessResponse(result, 'Transaction created successfully'));
  })
);

/**
 * @swagger
 * /ledgers/balance/{accountId}:
 *   get:
 *     summary: Get account balance from ledger entries
 *     tags: [Ledgers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: accountId
 *         required: true
 *         schema:
 *           type: string
 *         description: Account Detail ID
 *     responses:
 *       200:
 *         description: Account balance retrieved successfully
 *       404:
 *         description: Account not found
 */
router.get(
  '/balance/:accountId',
  [param('accountId').isString().withMessage('Invalid account ID format')],
  validationMiddleware,
  asyncHandler(async (req, res) => {
    const { accountId } = req.params;

    // Get account detail information
    const accountDetail = await req.app.locals.prisma.accountDetail.findFirst({
      where: {
        id: accountId,
        deletedAt: null
      },
      select: {
        id: true,
        accountNumber: true,
        accountName: true,
        amountCredit: true,
        amountDebit: true,
        accountGeneral: {
          select: {
            id: true,
            accountNumber: true,
            accountName: true
          }
        }
      }
    });

    if (!accountDetail) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: 'Account not found'
      });
    }

    // Calculate balance from ledger entries
    const ledgerSummary = await req.app.locals.prisma.ledger.aggregate({
      where: {
        accountDetailId: accountId,
        deletedAt: null,
        postingStatus: 'POSTED'
      },
      _sum: {
        amount: true
      },
      _count: {
        id: true
      }
    });

    const ledgerBalance = ledgerSummary._sum.amount || 0;
    const transactionCount = ledgerSummary._count.id || 0;

    // Calculate net balance (debit - credit amounts)
    const netBalance =
      parseFloat(accountDetail.amountDebit) - parseFloat(accountDetail.amountCredit);

    res.json(
      createSuccessResponse(
        {
          account: accountDetail,
          ledgerBalance: parseFloat(ledgerBalance),
          netBalance,
          transactionCount,
          balanceDetails: {
            amountDebit: parseFloat(accountDetail.amountDebit),
            amountCredit: parseFloat(accountDetail.amountCredit)
          }
        },
        'Account balance retrieved successfully'
      )
    );
  })
);

export { router as ledgersRoutes };
