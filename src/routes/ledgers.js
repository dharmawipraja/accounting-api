/**
 * Ledger Routes
 *
 * Routes for managing ledger entries (journal entries).
 * Access restricted to Admin, Manager (MANAJER), and Accountant (AKUNTAN) roles.
 */

import { nanoid } from 'nanoid';
import { authorize } from '../middleware/index.js';
import {
  IdParamSchema,
  LedgerBulkCreateSchema,
  LedgerQuerySchema,
  LedgerUpdateSchema
} from '../schemas/index.js';

/**
 * Authorization middleware for ledger operations
 * Only Admin, Manager, and Accountant can manage ledgers
 */
const requireLedgerAccess = authorize('ADMIN', 'MANAJER', 'AKUNTAN');

/**
 * Generate unique reference number with prefix
 */
const generateReferenceNumber = () => {
  const prefix = 'LED';
  const timestamp = Date.now().toString(36).toUpperCase();
  const randomId = nanoid(6).toUpperCase();
  return `${prefix}-${timestamp}-${randomId}`;
};

/**
 * Round a number to 2 decimal places safely
 */
const round2 = value => Math.round(Number(value) * 100) / 100;

/**
 * Ledger Routes Plugin
 */
export const ledgerRoutes = async fastify => {
  // Apply authentication middleware to all routes in this group
  fastify.addHook('onRequest', requireLedgerAccess);

  /**
   * Create Bulk Ledgers
   * POST /ledgers
   *
   * Creates multiple ledger entries in a transaction.
   * All entries share the same reference number.
   * Only accessible by Admin, Manager, and Accountant.
   */
  fastify.post(
    '/',
    {
      schema: {
        tags: ['Ledgers'],
        summary: 'Create bulk ledger entries',
        description:
          'Creates multiple ledger entries in a single transaction. All entries share the same reference number. Requires Admin, Manager, or Accountant role.',
        body: {
          type: 'object',
          properties: {
            ledgers: {
              type: 'array',
              minItems: 1,
              maxItems: 100,
              items: {
                type: 'object',
                properties: {
                  amount: {
                    type: 'number',
                    minimum: 0.01,
                    maximum: 99999999.99,
                    description: 'Ledger amount'
                  },
                  description: {
                    type: 'string',
                    minLength: 3,
                    maxLength: 500,
                    description: 'Ledger description'
                  },
                  accountDetailId: {
                    type: 'string',
                    description: 'Account detail ID'
                  },
                  accountGeneralId: {
                    type: 'string',
                    description: 'Account general ID'
                  },
                  ledgerType: {
                    type: 'string',
                    enum: ['KAS_MASUK', 'KAS_KELUAR'],
                    description: 'Ledger type'
                  },
                  transactionType: {
                    type: 'string',
                    enum: ['DEBIT', 'CREDIT'],
                    description: 'Transaction type'
                  },
                  ledgerDate: {
                    type: 'string',
                    format: 'date-time',
                    description: 'Ledger date'
                  }
                },
                required: [
                  'amount',
                  'description',
                  'accountDetailId',
                  'accountGeneralId',
                  'ledgerType',
                  'transactionType',
                  'ledgerDate'
                ]
              }
            }
          },
          required: ['ledgers']
        },
        response: {
          201: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              message: { type: 'string' },
              data: {
                type: 'object',
                properties: {
                  referenceNumber: { type: 'string' },
                  totalEntries: { type: 'number' },
                  ledgers: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        referenceNumber: { type: 'string' },
                        amount: { type: 'number' },
                        description: { type: 'string' },
                        ledgerType: { type: 'string' },
                        transactionType: { type: 'string' },
                        postingStatus: { type: 'string' },
                        ledgerDate: { type: 'string' },
                        accountDetailId: { type: 'string' },
                        accountGeneralId: { type: 'string' },
                        createdAt: { type: 'string' },
                        createdBy: { type: 'string' }
                      }
                    }
                  }
                }
              }
            }
          },
          400: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              error: {
                type: 'object',
                properties: {
                  code: { type: 'string' },
                  message: { type: 'string' },
                  details: { type: 'array', items: { type: 'string' } }
                }
              }
            }
          }
        }
      }
    },
    async (request, reply) => {
      try {
        // Validate request body
        const validation = LedgerBulkCreateSchema.safeParse(request.body);
        if (!validation.success) {
          return reply.code(400).send({
            success: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid input data',
              details: validation.error.errors.map(err => `${err.path.join('.')}: ${err.message}`)
            }
          });
        }

        const { ledgers } = validation.data;
        const referenceNumber = generateReferenceNumber();
        const userId = request.user.id;
        const now = new Date();

        // Check if all account details and generals exist
        const accountDetailIds = [...new Set(ledgers.map(l => l.accountDetailId))];
        const accountGeneralIds = [...new Set(ledgers.map(l => l.accountGeneralId))];

        const [existingAccountDetails, existingAccountGenerals] = await Promise.all([
          fastify.prisma.accountDetail.findMany({
            where: {
              id: { in: accountDetailIds },
              deletedAt: null
            },
            select: { id: true, accountGeneralId: true }
          }),
          fastify.prisma.accountGeneral.findMany({
            where: {
              id: { in: accountGeneralIds },
              deletedAt: null
            },
            select: { id: true }
          })
        ]);

        // Validate all accounts exist
        const detailMap = new Map(
          existingAccountDetails.map(acc => [acc.id, acc.accountGeneralId])
        );
        const foundGeneralIds = new Set(existingAccountGenerals.map(acc => acc.id));

        const missingDetailIds = accountDetailIds.filter(id => !detailMap.has(id));
        const missingGeneralIds = accountGeneralIds.filter(id => !foundGeneralIds.has(id));

        if (missingDetailIds.length > 0 || missingGeneralIds.length > 0) {
          return reply.code(400).send({
            success: false,
            error: {
              code: 'ACCOUNTS_NOT_FOUND',
              message: 'Some accounts were not found',
              details: [
                ...(missingDetailIds.length > 0
                  ? [`Account Details not found: ${missingDetailIds.join(', ')}`]
                  : []),
                ...(missingGeneralIds.length > 0
                  ? [`Account Generals not found: ${missingGeneralIds.join(', ')}`]
                  : [])
              ]
            }
          });
        }

        // Verify each detail belongs to the provided general
        const mismatches = [];
        for (const item of ledgers) {
          const expectedGeneral = detailMap.get(item.accountDetailId);
          if (!expectedGeneral || expectedGeneral !== item.accountGeneralId) {
            mismatches.push(
              `Detail ${item.accountDetailId} does not belong to General ${item.accountGeneralId}`
            );
          }
        }
        if (mismatches.length) {
          return reply.code(400).send({
            success: false,
            error: {
              code: 'ACCOUNT_RELATION_MISMATCH',
              message: 'Account detail and general mismatch',
              details: mismatches
            }
          });
        }

        // Double-entry check: DEBIT total must equal CREDIT total
        const totals = ledgers.reduce(
          (acc, l) => {
            const amt = round2(l.amount);
            if (l.transactionType === 'DEBIT') acc.debit = round2(acc.debit + amt);
            if (l.transactionType === 'CREDIT') acc.credit = round2(acc.credit + amt);
            return acc;
          },
          { debit: 0, credit: 0 }
        );
        if (Math.round((totals.debit - totals.credit) * 100) !== 0) {
          return reply.code(400).send({
            success: false,
            error: {
              code: 'UNBALANCED_JOURNAL',
              message: `Unbalanced entries: debit ${totals.debit.toFixed(2)} != credit ${totals.credit.toFixed(2)}`
            }
          });
        }

        // Check reference number uniqueness within the transaction
        const existingRef = await fastify.prisma.ledger.findFirst({
          where: { referenceNumber },
          select: { id: true }
        });

        if (existingRef) {
          throw new Error('Reference number already exists');
        }

        // Prepare ledger data for bulk insert
        const ledgerData = ledgers.map(ledger => ({
          referenceNumber,
          amount: round2(ledger.amount),
          description: ledger.description.trim(),
          accountDetailId: ledger.accountDetailId,
          accountGeneralId: ledger.accountGeneralId,
          ledgerType: ledger.ledgerType,
          transactionType: ledger.transactionType,
          ledgerDate: new Date(ledger.ledgerDate),
          postingStatus: 'PENDING',
          postingAt: null,
          createdBy: userId,
          updatedBy: userId,
          createdAt: now,
          updatedAt: now
        }));

        // Create all ledgers in a transaction
        const createdLedgers = await fastify.prisma.$transaction(async prisma => {
          // Create all ledger entries
          const results = [];
          for (const data of ledgerData) {
            const created = await prisma.ledger.create({
              data,
              select: {
                id: true,
                referenceNumber: true,
                amount: true,
                description: true,
                ledgerType: true,
                transactionType: true,
                postingStatus: true,
                ledgerDate: true,
                postingAt: true,
                accountDetailId: true,
                accountGeneralId: true,
                createdAt: true,
                createdBy: true
              }
            });
            results.push(created);
          }

          return results;
        });

        reply.code(201).send({
          success: true,
          message: `Successfully created ${createdLedgers.length} ledger entries`,
          data: {
            referenceNumber,
            totalEntries: createdLedgers.length,
            ledgers: createdLedgers
          }
        });
      } catch (error) {
        request.log.error('Error creating bulk ledgers:', error);

        if (error.message === 'Reference number already exists') {
          return reply.code(409).send({
            success: false,
            error: {
              code: 'REFERENCE_NUMBER_EXISTS',
              message: 'Reference number already exists, please retry'
            }
          });
        }

        if (
          error.code === 'P2002' &&
          Array.isArray(error.meta?.target) &&
          error.meta.target.includes('referenceNumber')
        ) {
          return reply.code(409).send({
            success: false,
            error: {
              code: 'REFERENCE_NUMBER_EXISTS',
              message: 'Reference number already exists, please retry'
            }
          });
        }

        reply.code(500).send({
          success: false,
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Failed to create ledger entries'
          }
        });
      }
    }
  );

  /**
   * Get All Ledgers
   * GET /ledgers
   *
   * Retrieves all ledger entries with pagination and filtering.
   * Only accessible by Admin, Manager, and Accountant.
   */
  fastify.get(
    '/',
    {
      schema: {
        tags: ['Ledgers'],
        summary: 'Get all ledger entries',
        description:
          'Retrieves all ledger entries with pagination and optional filtering. Requires Admin, Manager, or Accountant role.',
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1, description: 'Page number' },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 100,
              default: 10,
              description: 'Items per page'
            },
            search: {
              type: 'string',
              description: 'Search in reference number and description'
            },
            ledgerType: {
              type: 'string',
              enum: ['KAS_MASUK', 'KAS_KELUAR'],
              description: 'Filter by ledger type'
            },
            transactionType: {
              type: 'string',
              enum: ['DEBIT', 'CREDIT'],
              description: 'Filter by transaction type'
            },
            postingStatus: {
              type: 'string',
              enum: ['PENDING', 'POSTED'],
              description: 'Filter by posting status'
            },
            accountDetailId: {
              type: 'string',
              description: 'Filter by account detail ID'
            },
            accountGeneralId: {
              type: 'string',
              description: 'Filter by account general ID'
            },
            startDate: {
              type: 'string',
              format: 'date',
              description: 'Start date for filtering'
            },
            endDate: {
              type: 'string',
              format: 'date',
              description: 'End date for filtering'
            }
          }
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    referenceNumber: { type: 'string' },
                    amount: { type: 'number' },
                    description: { type: 'string' },
                    ledgerType: { type: 'string' },
                    transactionType: { type: 'string' },
                    postingStatus: { type: 'string' },
                    ledgerDate: { type: 'string' },
                    postingAt: { type: ['string', 'null'] },
                    createdAt: { type: 'string' },
                    updatedAt: { type: 'string' },
                    accountDetail: {
                      type: 'object',
                      properties: {
                        accountNumber: { type: 'string' },
                        accountName: { type: 'string' }
                      }
                    },
                    accountGeneral: {
                      type: 'object',
                      properties: {
                        accountNumber: { type: 'string' },
                        accountName: { type: 'string' }
                      }
                    }
                  }
                }
              },
              meta: {
                type: 'object',
                properties: {
                  pagination: {
                    type: 'object',
                    properties: {
                      page: { type: 'number' },
                      limit: { type: 'number' },
                      total: { type: 'number' },
                      totalPages: { type: 'number' },
                      hasNext: { type: 'boolean' },
                      hasPrev: { type: 'boolean' },
                      nextPage: { type: ['number', 'null'] },
                      prevPage: { type: ['number', 'null'] }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    async (request, reply) => {
      try {
        // Validate query parameters
        const validation = LedgerQuerySchema.safeParse(request.query);
        if (!validation.success) {
          return reply.code(400).send({
            success: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid query parameters',
              details: validation.error.errors.map(err => `${err.path.join('.')}: ${err.message}`)
            }
          });
        }

        const {
          page,
          limit,
          search,
          ledgerType,
          transactionType,
          postingStatus,
          accountDetailId,
          accountGeneralId,
          startDate,
          endDate
        } = validation.data;

        // Normalize date range to day boundaries when both provided
        const normalizedStart = startDate ? new Date(startDate) : undefined;
        const normalizedEnd = endDate ? new Date(endDate) : undefined;
        if (normalizedStart) {
          normalizedStart.setHours(0, 0, 0, 0);
        }
        if (normalizedEnd) {
          normalizedEnd.setHours(23, 59, 59, 999);
        }

        // Build where clause
        const where = {
          deletedAt: null,
          ...(search && {
            OR: [
              { referenceNumber: { contains: search, mode: 'insensitive' } },
              { description: { contains: search, mode: 'insensitive' } }
            ]
          }),
          ...(ledgerType && { ledgerType }),
          ...(transactionType && { transactionType }),
          ...(postingStatus && { postingStatus }),
          ...(accountDetailId && { accountDetailId }),
          ...(accountGeneralId && { accountGeneralId }),
          ...((normalizedStart || normalizedEnd) && {
            ledgerDate: {
              ...(normalizedStart && { gte: normalizedStart }),
              ...(normalizedEnd && { lte: normalizedEnd })
            }
          })
        };

        // Get total count and data
        const [total, ledgers] = await Promise.all([
          fastify.prisma.ledger.count({ where }),
          fastify.prisma.ledger.findMany({
            where,
            include: {
              accountDetail: {
                select: {
                  accountNumber: true,
                  accountName: true
                }
              },
              accountGeneral: {
                select: {
                  accountNumber: true,
                  accountName: true
                }
              }
            },
            orderBy: [{ ledgerDate: 'desc' }, { createdAt: 'desc' }],
            skip: (page - 1) * limit,
            take: limit
          })
        ]);

        const totalPages = Math.ceil(total / limit);

        reply.send({
          success: true,
          data: ledgers,
          meta: {
            pagination: {
              page,
              limit,
              total,
              totalPages,
              hasNext: page < totalPages,
              hasPrev: page > 1,
              nextPage: page < totalPages ? page + 1 : null,
              prevPage: page > 1 ? page - 1 : null
            }
          }
        });
      } catch (error) {
        request.log.error('Error fetching ledgers:', error);
        reply.code(500).send({
          success: false,
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Failed to fetch ledger entries'
          }
        });
      }
    }
  );

  /**
   * Get Ledger by ID
   * GET /ledgers/:id
   *
   * Retrieves a specific ledger entry by ID.
   * Only accessible by Admin, Manager, and Accountant.
   */
  fastify.get(
    '/:id',
    {
      schema: {
        tags: ['Ledgers'],
        summary: 'Get ledger by ID',
        description:
          'Retrieves a specific ledger entry by ID. Requires Admin, Manager, or Accountant role.',
        params: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Ledger ID'
            }
          },
          required: ['id']
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  referenceNumber: { type: 'string' },
                  amount: { type: 'number' },
                  description: { type: 'string' },
                  ledgerType: { type: 'string' },
                  transactionType: { type: 'string' },
                  postingStatus: { type: 'string' },
                  ledgerDate: { type: 'string' },
                  postingAt: { type: ['string', 'null'] },
                  createdAt: { type: 'string' },
                  updatedAt: { type: 'string' },
                  accountDetail: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      accountNumber: { type: 'string' },
                      accountName: { type: 'string' }
                    }
                  },
                  accountGeneral: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      accountNumber: { type: 'string' },
                      accountName: { type: 'string' }
                    }
                  }
                }
              }
            }
          },
          404: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              error: {
                type: 'object',
                properties: {
                  code: { type: 'string' },
                  message: { type: 'string' }
                }
              }
            }
          }
        }
      }
    },
    async (request, reply) => {
      try {
        // Validate params
        const validation = IdParamSchema.safeParse(request.params);
        if (!validation.success) {
          return reply.code(400).send({
            success: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid ledger ID format'
            }
          });
        }

        const { id } = validation.data;

        const ledger = await fastify.prisma.ledger.findFirst({
          where: {
            id,
            deletedAt: null
          },
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
          }
        });

        if (!ledger) {
          return reply.code(404).send({
            success: false,
            error: {
              code: 'LEDGER_NOT_FOUND',
              message: 'Ledger entry not found'
            }
          });
        }

        reply.send({
          success: true,
          data: ledger
        });
      } catch (error) {
        request.log.error('Error fetching ledger:', error);
        reply.code(500).send({
          success: false,
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Failed to fetch ledger entry'
          }
        });
      }
    }
  );

  /**
   * Update Ledger
   * PUT /ledgers/:id
   *
   * Updates a specific ledger entry.
   * Only accessible by Admin, Manager, and Accountant.
   */
  fastify.put(
    '/:id',
    {
      schema: {
        tags: ['Ledgers'],
        summary: 'Update ledger entry',
        description:
          'Updates a specific ledger entry. Requires Admin, Manager, or Accountant role.',
        params: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Ledger ID'
            }
          },
          required: ['id']
        },
        body: {
          type: 'object',
          properties: {
            amount: {
              type: 'number',
              minimum: 0.01,
              maximum: 99999999.99,
              description: 'Ledger amount'
            },
            description: {
              type: 'string',
              minLength: 3,
              maxLength: 500,
              description: 'Ledger description'
            },
            ledgerType: {
              type: 'string',
              enum: ['KAS_MASUK', 'KAS_KELUAR'],
              description: 'Ledger type'
            },
            transactionType: {
              type: 'string',
              enum: ['DEBIT', 'CREDIT'],
              description: 'Transaction type'
            },
            ledgerDate: {
              type: 'string',
              format: 'date-time',
              description: 'Ledger date'
            }
          }
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              message: { type: 'string' },
              data: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  referenceNumber: { type: 'string' },
                  amount: { type: 'number' },
                  description: { type: 'string' },
                  ledgerType: { type: 'string' },
                  transactionType: { type: 'string' },
                  updatedAt: { type: 'string' }
                }
              }
            }
          }
        }
      }
    },
    async (request, reply) => {
      try {
        // Validate params and body
        const paramsValidation = IdParamSchema.safeParse(request.params);
        const bodyValidation = LedgerUpdateSchema.safeParse(request.body);

        if (!paramsValidation.success || !bodyValidation.success) {
          return reply.code(400).send({
            success: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid input data',
              details: [
                ...(paramsValidation.error?.errors.map(
                  err => `params.${err.path.join('.')}: ${err.message}`
                ) || []),
                ...(bodyValidation.error?.errors.map(
                  err => `body.${err.path.join('.')}: ${err.message}`
                ) || [])
              ]
            }
          });
        }

        const { id } = paramsValidation.data;
        const updateData = bodyValidation.data;

        // Check if ledger exists and is not deleted
        const existingLedger = await fastify.prisma.ledger.findFirst({
          where: {
            id,
            deletedAt: null
          }
        });

        if (!existingLedger) {
          return reply.code(404).send({
            success: false,
            error: {
              code: 'LEDGER_NOT_FOUND',
              message: 'Ledger entry not found'
            }
          });
        }

        // Check if ledger is already posted (cannot edit posted ledgers)
        if (existingLedger.postingStatus === 'POSTED') {
          return reply.code(409).send({
            success: false,
            error: {
              code: 'LEDGER_ALREADY_POSTED',
              message: 'Cannot edit posted ledger entries'
            }
          });
        }

        // Update ledger
        const updatedLedger = await fastify.prisma.ledger.update({
          where: { id },
          data: {
            ...updateData,
            ...(typeof updateData.amount === 'number' && {
              amount: round2(updateData.amount)
            }),
            ...(updateData.description && { description: updateData.description.trim() }),
            ...(updateData.ledgerDate && { ledgerDate: new Date(updateData.ledgerDate) }),
            updatedBy: request.user.id,
            updatedAt: new Date()
          },
          select: {
            id: true,
            referenceNumber: true,
            amount: true,
            description: true,
            ledgerType: true,
            transactionType: true,
            postingStatus: true,
            ledgerDate: true,
            updatedAt: true
          }
        });

        reply.send({
          success: true,
          message: 'Ledger entry updated successfully',
          data: updatedLedger
        });
      } catch (error) {
        request.log.error('Error updating ledger:', error);
        reply.code(500).send({
          success: false,
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Failed to update ledger entry'
          }
        });
      }
    }
  );

  /**
   * Delete Ledger (Soft Delete)
   * DELETE /ledgers/:id
   *
   * Soft deletes a specific ledger entry.
   * Only accessible by Admin, Manager, and Accountant.
   */
  fastify.delete(
    '/:id',
    {
      schema: {
        tags: ['Ledgers'],
        summary: 'Delete ledger entry',
        description:
          'Soft deletes a specific ledger entry. Requires Admin, Manager, or Accountant role.',
        params: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Ledger ID'
            }
          },
          required: ['id']
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              message: { type: 'string' }
            }
          }
        }
      }
    },
    async (request, reply) => {
      try {
        // Validate params
        const validation = IdParamSchema.safeParse(request.params);
        if (!validation.success) {
          return reply.code(400).send({
            success: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid ledger ID format'
            }
          });
        }

        const { id } = validation.data;

        // Check if ledger exists and is not already deleted
        const existingLedger = await fastify.prisma.ledger.findFirst({
          where: {
            id,
            deletedAt: null
          }
        });

        if (!existingLedger) {
          return reply.code(404).send({
            success: false,
            error: {
              code: 'LEDGER_NOT_FOUND',
              message: 'Ledger entry not found'
            }
          });
        }

        // Check if ledger is posted (cannot delete posted ledgers)
        if (existingLedger.postingStatus === 'POSTED') {
          return reply.code(409).send({
            success: false,
            error: {
              code: 'LEDGER_ALREADY_POSTED',
              message: 'Cannot delete posted ledger entries'
            }
          });
        }

        // Soft delete ledger
        await fastify.prisma.ledger.update({
          where: { id },
          data: {
            deletedAt: new Date(),
            updatedBy: request.user.id,
            updatedAt: new Date()
          }
        });

        reply.send({
          success: true,
          message: 'Ledger entry deleted successfully'
        });
      } catch (error) {
        request.log.error('Error deleting ledger:', error);
        reply.code(500).send({
          success: false,
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Failed to delete ledger entry'
          }
        });
      }
    }
  );

  /**
   * Post Ledger
   * PATCH /ledgers/:id/post
   *
   * Changes ledger status from PENDING to POSTED.
   * Only accessible by Admin, Manager, and Accountant.
   */
  fastify.patch(
    '/:id/post',
    {
      schema: {
        tags: ['Ledgers'],
        summary: 'Post ledger entry',
        description:
          'Changes ledger status from PENDING to POSTED and sets postingAt timestamp. Requires Admin, Manager, or Accountant role.',
        params: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Ledger ID'
            }
          },
          required: ['id']
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              message: { type: 'string' },
              data: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  postingStatus: { type: 'string' },
                  postingAt: { type: 'string' }
                }
              }
            }
          }
        }
      }
    },
    async (request, reply) => {
      try {
        // Validate params
        const validation = IdParamSchema.safeParse(request.params);
        if (!validation.success) {
          return reply.code(400).send({
            success: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid ledger ID format'
            }
          });
        }

        const { id } = validation.data;

        // Check if ledger exists and is not deleted
        const existingLedger = await fastify.prisma.ledger.findFirst({
          where: {
            id,
            deletedAt: null
          }
        });

        if (!existingLedger) {
          return reply.code(404).send({
            success: false,
            error: {
              code: 'LEDGER_NOT_FOUND',
              message: 'Ledger entry not found'
            }
          });
        }

        // Check if ledger is already posted
        if (existingLedger.postingStatus === 'POSTED') {
          return reply.code(409).send({
            success: false,
            error: {
              code: 'LEDGER_ALREADY_POSTED',
              message: 'Ledger entry is already posted'
            }
          });
        }

        const now = new Date();

        // Update ledger to posted status
        const updatedLedger = await fastify.prisma.ledger.update({
          where: { id },
          data: {
            postingStatus: 'POSTED',
            postingAt: now,
            updatedBy: request.user.id,
            updatedAt: now
          },
          select: {
            id: true,
            postingStatus: true,
            postingAt: true
          }
        });

        reply.send({
          success: true,
          message: 'Ledger entry posted successfully',
          data: updatedLedger
        });
      } catch (error) {
        request.log.error('Error posting ledger:', error);
        reply.code(500).send({
          success: false,
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Failed to post ledger entry'
          }
        });
      }
    }
  );

  /**
   * Unpost Ledger
   * PATCH /ledgers/:id/unpost
   *
   * Changes ledger status from POSTED to PENDING.
   * Only accessible by Admin, Manager, and Accountant.
   */
  fastify.patch(
    '/:id/unpost',
    {
      schema: {
        tags: ['Ledgers'],
        summary: 'Unpost ledger entry',
        description:
          'Changes ledger status from POSTED to PENDING and removes postingAt timestamp. Requires Admin, Manager, or Accountant role.',
        params: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Ledger ID'
            }
          },
          required: ['id']
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              message: { type: 'string' },
              data: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  postingStatus: { type: 'string' },
                  postingAt: { type: ['string', 'null'] }
                }
              }
            }
          }
        }
      }
    },
    async (request, reply) => {
      try {
        // Validate params
        const validation = IdParamSchema.safeParse(request.params);
        if (!validation.success) {
          return reply.code(400).send({
            success: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid ledger ID format'
            }
          });
        }

        const { id } = validation.data;

        // Check if ledger exists and is not deleted
        const existingLedger = await fastify.prisma.ledger.findFirst({
          where: {
            id,
            deletedAt: null
          }
        });

        if (!existingLedger) {
          return reply.code(404).send({
            success: false,
            error: {
              code: 'LEDGER_NOT_FOUND',
              message: 'Ledger entry not found'
            }
          });
        }

        // Check if ledger is not posted
        if (existingLedger.postingStatus === 'PENDING') {
          return reply.code(409).send({
            success: false,
            error: {
              code: 'LEDGER_NOT_POSTED',
              message: 'Ledger entry is not posted'
            }
          });
        }

        // Update ledger to pending status
        const updatedLedger = await fastify.prisma.ledger.update({
          where: { id },
          data: {
            postingStatus: 'PENDING',
            postingAt: null,
            updatedBy: request.user.id,
            updatedAt: new Date()
          },
          select: {
            id: true,
            postingStatus: true,
            postingAt: true
          }
        });

        reply.send({
          success: true,
          message: 'Ledger entry unposted successfully',
          data: updatedLedger
        });
      } catch (error) {
        request.log.error('Error unposting ledger:', error);
        reply.code(500).send({
          success: false,
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Failed to unpost ledger entry'
          }
        });
      }
    }
  );
};
