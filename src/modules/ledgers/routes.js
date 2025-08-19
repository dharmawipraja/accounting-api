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
 *         name: accountDetailId
 *         schema:
 *           type: string
 *         description: Filter by account detail ID
 *       - in: query
 *         name: accountGeneralId
 *         schema:
 *           type: string
 *         description: Filter by account general ID
 *     responses:
 *       200:
 *         description: Ledger entries retrieved successfully
 */
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
      ...(accountDetailId && { accountDetailId }),
      ...(accountGeneralId && { accountGeneralId })
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

/**
 * @swagger
 * /ledgers/bulk:
 *   post:
 *     summary: Create multiple ledger entries in bulk
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
 *               - ledgers
 *             properties:
 *               ledgers:
 *                 type: array
 *                 minItems: 1
 *                 maxItems: 100
 *                 items:
 *                   type: object
 *                   required:
 *                     - amount
 *                     - description
 *                     - accountDetailId
 *                     - accountGeneralId
 *                     - ledgerType
 *                     - transactionType
 *                     - ledgerDate
 *                   properties:
 *                     amount:
 *                       type: number
 *                       minimum: 0.01
 *                     description:
 *                       type: string
 *                       maxLength: 500
 *                     accountDetailId:
 *                       type: string
 *                     accountGeneralId:
 *                       type: string
 *                     ledgerType:
 *                       type: string
 *                       enum: [KAS_MASUK, KAS_KELUAR]
 *                     transactionType:
 *                       type: string
 *                       enum: [DEBIT, CREDIT]
 *                     ledgerDate:
 *                       type: string
 *                       format: date-time
 *     responses:
 *       201:
 *         description: Ledger entries created successfully
 *       400:
 *         description: Validation error
 */
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

/**
 * @swagger
 * /ledgers:
 *   post:
 *     summary: Create new ledger entry
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
 *               - referenceNumber
 *               - amount
 *               - description
 *               - accountDetailId
 *               - accountGeneralId
 *               - ledgerType
 *               - transactionType
 *               - ledgerDate
 *             properties:
 *               referenceNumber:
 *                 type: string
 *               amount:
 *                 type: number
 *                 minimum: 0
 *               description:
 *                 type: string
 *               accountDetailId:
 *                 type: string
 *               accountGeneralId:
 *                 type: string
 *               ledgerType:
 *                 type: string
 *                 enum: [KAS_MASUK, KAS_KELUAR]
 *               transactionType:
 *                 type: string
 *                 enum: [DEBIT, CREDIT]
 *               ledgerDate:
 *                 type: string
 *                 format: date-time
 *               postingStatus:
 *                 type: string
 *                 enum: [PENDING, POSTED]
 *     responses:
 *       201:
 *         description: Ledger entry created successfully
 *       400:
 *         description: Validation error
 */
// router.post(
//   '/',
//   [
//     body('referenceNumber').trim().notEmpty().withMessage('Reference number is required'),
//     body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be a positive number'),
//     body('description')
//       .trim()
//       .notEmpty()
//       .withMessage('Description is required')
//       .isLength({ max: 500 })
//       .withMessage('Description must not exceed 500 characters'),
//     body('accountDetailId').notEmpty().withMessage('Account detail ID is required'),
//     body('accountGeneralId').notEmpty().withMessage('Account general ID is required'),
//     body('ledgerType').isIn(['KAS_MASUK', 'KAS_KELUAR']).withMessage('Invalid ledger type'),
//     body('transactionType').isIn(['DEBIT', 'CREDIT']).withMessage('Invalid transaction type'),
//     body('ledgerDate').isISO8601().withMessage('Invalid ledger date format'),
//     body('postingStatus')
//       .optional()
//       .isIn(['PENDING', 'POSTED'])
//       .withMessage('Invalid posting status')
//   ],
//   validationMiddleware,
//   asyncHandler(async (req, res) => {
//     const {
//       referenceNumber,
//       amount,
//       description,
//       accountDetailId,
//       accountGeneralId,
//       ledgerType,
//       transactionType,
//       ledgerDate,
//       postingStatus = 'PENDING'
//     } = req.body;

//     const userId = req.user?.userId || req.user?.id;

//     // Verify account detail exists
//     const accountDetail = await req.app.locals.prisma.accountDetail.findFirst({
//       where: {
//         id: accountDetailId,
//         deletedAt: null
//       }
//     });

//     if (!accountDetail) {
//       return res.status(400).json({
//         success: false,
//         error: 'Validation Error',
//         message: 'Account detail not found'
//       });
//     }

//     // Verify account general exists
//     const accountGeneral = await req.app.locals.prisma.accountGeneral.findFirst({
//       where: {
//         id: accountGeneralId,
//         deletedAt: null
//       }
//     });

//     if (!accountGeneral) {
//       return res.status(400).json({
//         success: false,
//         error: 'Validation Error',
//         message: 'Account general not found'
//       });
//     }

//     // Create ledger entry
//     const ledgerEntry = await req.app.locals.prisma.ledger.create({
//       data: {
//         id: ulid(),
//         referenceNumber,
//         amount: parseFloat(amount),
//         description,
//         accountDetailId,
//         ledgerType,
//         transactionType,
//         accountGeneralId,
//         ledgerDate: new Date(ledgerDate),
//         postingStatus,
//         postingAt: postingStatus === 'POSTED' ? new Date() : null,
//         createdBy: userId,
//         updatedBy: userId,
//         createdAt: new Date(),
//         updatedAt: new Date()
//       },
//       include: {
//         accountDetail: {
//           select: {
//             id: true,
//             accountNumber: true,
//             accountName: true
//           }
//         },
//         accountGeneral: {
//           select: {
//             id: true,
//             accountNumber: true,
//             accountName: true
//           }
//         }
//       }
//     });

//     res.status(201).json(createSuccessResponse(ledgerEntry, 'Ledger entry created successfully'));
//   })
// );

export { router as ledgersRoutes };
