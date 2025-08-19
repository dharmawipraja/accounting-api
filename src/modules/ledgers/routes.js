/**
 * Express Ledgers Routes
 * Ledger management endpoints for Express.js
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

// Apply authentication to all ledger routes
router.use(authenticate);

// Require accounting access for all routes
router.use(requireAccountingAccess);

router.get(
  '/',
  [
    ...commonValidations.pagination,
    query('accountDetailId').optional().isString().withMessage('Invalid account detail ID format'),
    query('accountGeneralId').optional().isString().withMessage('Invalid account general ID format')
  ],
  validationMiddleware,
  asyncHandler(async (req, res) => {
    const { page = 1, limit = 10, accountDetailId, accountGeneralId } = req.query;
    const skip = (page - 1) * limit;

    const whereClause = {
      deletedAt: null,
      ...(accountDetailId && { accountDetailAccountNumber: accountDetailId }),
      ...(accountGeneralId && { accountGeneralAccountNumber: accountGeneralId })
    };

    const [entries, total] = await Promise.all([
      req.app.locals.prisma.ledger.findMany({
        where: whereClause,
        include: {
          accountDetail: {
            select: {
              id: true,
              accountNumber: true,
              accountName: true
            }
          },
          accountGeneral: {
            select: {
              id: true,
              accountNumber: true,
              accountName: true
            }
          }
        },
        skip,
        take: limit,
        orderBy: { ledgerDate: 'desc' }
      }),
      req.app.locals.prisma.ledger.count({ where: whereClause })
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

router.get(
  '/:id',
  [commonValidations.id],
  validationMiddleware,
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const entry = await req.app.locals.prisma.ledger.findFirst({
      where: {
        id,
        deletedAt: null
      },
      include: {
        accountDetail: {
          select: {
            id: true,
            accountNumber: true,
            accountName: true,
            accountCategory: true
          }
        },
        accountGeneral: {
          select: {
            id: true,
            accountNumber: true,
            accountName: true,
            accountCategory: true
          }
        }
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

router.post(
  '/',
  [
    body('ledgers')
      .isArray({ min: 1, max: 100 })
      .withMessage('Ledgers must be an array with 1-100 entries'),
    body('ledgers.*.amount').isFloat({ min: 0.01 }).withMessage('Amount must be a positive number'),
    body('ledgers.*.description')
      .trim()
      .notEmpty()
      .withMessage('Description is required')
      .isLength({ max: 500 })
      .withMessage('Description must not exceed 500 characters'),
    body('ledgers.*.accountDetailId').notEmpty().withMessage('Account detail ID is required'),
    body('ledgers.*.accountGeneralId').notEmpty().withMessage('Account general ID is required'),
    body('ledgers.*.ledgerType')
      .isIn(['KAS_MASUK', 'KAS_KELUAR'])
      .withMessage('Invalid ledger type'),
    body('ledgers.*.transactionType')
      .isIn(['DEBIT', 'CREDIT'])
      .withMessage('Invalid transaction type'),
    body('ledgers.*.ledgerDate').isISO8601().withMessage('Invalid ledger date format')
  ],
  validationMiddleware,
  asyncHandler(async (req, res) => {
    // Import the controller
    const { LedgersController } = await import('./controller.js');
    const ledgersController = new LedgersController(req.app.locals.prisma);

    // Use the controller method
    await ledgersController.createBulkLedgers(req, res);
  })
);

export { router as ledgersRoutes };
