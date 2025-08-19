/**
 * Express Account Detail Routes
 * Detail account management endpoints for Express.js
 */

import { Router } from 'express';
import { body, query } from 'express-validator';
import { ulid } from 'ulid';
import {
  asyncHandler,
  createPaginatedResponse,
  createSuccessResponse
} from '../../../core/errors/index.js';
import { authenticate, requireAccountingAccess } from '../../../core/middleware/auth.js';
import { commonValidations, validationMiddleware } from '../../../core/security/security.js';

const router = Router();

// Apply authentication to all account detail routes
router.use(authenticate);

// Require accounting access for all routes
router.use(requireAccountingAccess);

router.get(
  '/',
  [
    ...commonValidations.pagination,
    query('accountCategory')
      .optional()
      .isIn(['ASSET', 'HUTANG', 'MODAL', 'PENDAPATAN', 'BIAYA'])
      .withMessage('Invalid account category'),
    query('accountGeneralId')
      .optional()
      .isString()
      .withMessage('Account general ID must be a string')
  ],
  validationMiddleware,
  asyncHandler(async (req, res) => {
    const { page = 1, limit = 10, accountCategory, accountGeneralId } = req.query;
    const skip = (page - 1) * limit;

    const whereClause = {
      deletedAt: null,
      ...(accountCategory && { accountCategory }),
      ...(accountGeneralId && { accountGeneralId })
    };

    const [accounts, total] = await Promise.all([
      req.app.locals.prisma.accountDetail.findMany({
        where: whereClause,
        skip,
        take: limit,
        orderBy: { accountNumber: 'asc' },
        include: {
          accountGeneral: {
            select: {
              id: true,
              accountNumber: true,
              accountName: true,
              accountCategory: true
            }
          }
        }
      }),
      req.app.locals.prisma.accountDetail.count({ where: whereClause })
    ]);

    res.json(
      createPaginatedResponse(
        accounts,
        { page, limit, total },
        'Detail accounts retrieved successfully'
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

    const account = await req.app.locals.prisma.accountDetail.findFirst({
      where: {
        id,
        deletedAt: null
      },
      include: {
        accountGeneral: {
          select: {
            id: true,
            accountNumber: true,
            accountName: true,
            accountCategory: true
          }
        },
        ledgers: {
          where: { deletedAt: null },
          select: {
            id: true,
            referenceNumber: true,
            amount: true,
            description: true,
            ledgerType: true,
            postingStatus: true,
            ledgerDate: true
          },
          orderBy: { ledgerDate: 'desc' },
          take: 10
        }
      }
    });

    if (!account) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: 'Detail account not found'
      });
    }

    res.json(createSuccessResponse(account, 'Detail account retrieved successfully'));
  })
);

router.post(
  '/',
  [
    body('accountNumber')
      .trim()
      .notEmpty()
      .withMessage('Account number is required')
      .isLength({ min: 1, max: 20 })
      .withMessage('Account number must be between 1 and 20 characters')
      .matches(/^[0-9\-]+$/)
      .withMessage('Account number can only contain numbers and hyphens'),
    body('accountName')
      .trim()
      .notEmpty()
      .withMessage('Account name is required')
      .isLength({ min: 3, max: 100 })
      .withMessage('Account name must be between 3 and 100 characters'),
    body('accountGeneralId').notEmpty().withMessage('General account ID is required'),
    body('accountCategory')
      .isIn(['ASSET', 'HUTANG', 'MODAL', 'PENDAPATAN', 'BIAYA'])
      .withMessage('Invalid account category'),
    body('reportType').isIn(['NERACA', 'LABA_RUGI']).withMessage('Invalid report type'),
    body('transactionType').isIn(['DEBIT', 'CREDIT']).withMessage('Invalid transaction type'),
    body('amountCredit')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Amount credit must be a positive number'),
    body('amountDebit')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Amount debit must be a positive number')
  ],
  validationMiddleware,
  asyncHandler(async (req, res) => {
    const {
      accountNumber,
      accountName,
      accountGeneralAccountNumber,
      accountCategory,
      reportType,
      transactionType,
      amountCredit = 0,
      amountDebit = 0
    } = req.body;

    const userId = req.user?.userId || req.user?.id;

    // Check if account number already exists
    const existingAccount = await req.app.locals.prisma.accountDetail.findFirst({
      where: {
        accountNumber,
        deletedAt: null
      }
    });

    if (existingAccount) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Account with this number already exists'
      });
    }

    // Check if general account exists
    const generalAccount = await req.app.locals.prisma.accountGeneral.findFirst({
      where: {
        accountNumber: accountGeneralAccountNumber,
        deletedAt: null
      }
    });

    if (!generalAccount) {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'General account not found'
      });
    }

    const account = await req.app.locals.prisma.accountDetail.create({
      data: {
        id: ulid(),
        accountNumber,
        accountName,
        accountType: 'DETAIL',
        accountGeneralAccountNumber,
        accountCategory,
        reportType,
        transactionType,
        amountCredit: parseFloat(amountCredit),
        amountDebit: parseFloat(amountDebit),
        createdBy: userId,
        updatedBy: userId,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      include: {
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

    res.status(201).json(createSuccessResponse(account, 'Detail account created successfully'));
  })
);

router.put(
  '/:id',
  [
    commonValidations.id,
    body('accountName')
      .optional()
      .trim()
      .isLength({ min: 3, max: 100 })
      .withMessage('Account name must be between 3 and 100 characters'),
    body('accountCategory')
      .optional()
      .isIn(['ASSET', 'HUTANG', 'MODAL', 'PENDAPATAN', 'BIAYA'])
      .withMessage('Invalid account category'),
    body('reportType').optional().isIn(['NERACA', 'LABA_RUGI']).withMessage('Invalid report type'),
    body('transactionType')
      .optional()
      .isIn(['DEBIT', 'CREDIT'])
      .withMessage('Invalid transaction type'),
    body('amountCredit')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Amount credit must be a positive number'),
    body('amountDebit')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Amount debit must be a positive number')
  ],
  validationMiddleware,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const updates = req.body;
    const userId = req.user?.userId || req.user?.id;

    // Check if account exists
    const existingAccount = await req.app.locals.prisma.accountDetail.findFirst({
      where: {
        id,
        deletedAt: null
      }
    });

    if (!existingAccount) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: 'Detail account not found'
      });
    }

    // Prepare update data
    const updateData = {
      ...updates,
      updatedBy: userId,
      updatedAt: new Date()
    };

    // Convert numeric fields if provided
    if (updates.amountCredit !== undefined) {
      updateData.amountCredit = parseFloat(updates.amountCredit);
    }
    if (updates.amountDebit !== undefined) {
      updateData.amountDebit = parseFloat(updates.amountDebit);
    }

    const account = await req.app.locals.prisma.accountDetail.update({
      where: { id },
      data: updateData,
      include: {
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

    res.json(createSuccessResponse(account, 'Detail account updated successfully'));
  })
);

router.delete(
  '/:id',
  [commonValidations.id],
  validationMiddleware,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user?.userId || req.user?.id;

    // Check if account exists
    const existingAccount = await req.app.locals.prisma.accountDetail.findFirst({
      where: {
        id,
        deletedAt: null
      }
    });

    if (!existingAccount) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: 'Detail account not found'
      });
    }

    // Check if account has ledger entries
    const ledgerCount = await req.app.locals.prisma.ledger.count({
      where: {
        accountDetailAccountNumber: existingAccount.accountNumber,
        deletedAt: null
      }
    });

    if (ledgerCount > 0) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'Cannot delete account with existing ledger entries'
      });
    }

    // Perform soft delete
    await req.app.locals.prisma.accountDetail.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        updatedBy: userId,
        updatedAt: new Date()
      }
    });

    res.json(createSuccessResponse({ deletedId: id }, 'Detail account deleted successfully'));
  })
);

export { router as accountDetailRoutes };
