/**
 * Ledger Routes
 *
 * Routes for managing ledger entries (journal entries).
 * Access restricted to Admin, Manager (MANAJER), and Accountant (AKUNTAN) roles.
 */

import { ulid } from 'ulid';
import { z } from 'zod';
import { cacheControl } from '../middleware/caching.js';
import { authorize } from '../middleware/index.js';
import { zodToJsonSchema } from '../middleware/validation.js';
import {
  ErrorResponseSchema,
  IdParamSchema,
  LedgerBulkCreateSchema,
  LedgerQuerySchema,
  LedgerResponseSchema,
  LedgerUpdateSchema,
  SuccessResponseSchema
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
  // use a short suffix from ULID to preserve compactness while being sortable
  const randomId = ulid().slice(-6).toUpperCase();
  return `${prefix}-${timestamp}-${randomId}`;
};

import config from '../config/index.js';
import { toUtcFromLocal } from '../utils/date.js';
import { formatMoneyForDb, roundMoney, toDecimal } from '../utils/index.js';
const zonedTimeToUtc = (v, tz) => toUtcFromLocal(v, tz, { mode: 'exact' });
const APP_TIMEZONE = config.appConfig?.timezone || 'Asia/Makassar';

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
        body: LedgerBulkCreateSchema,
        response: {
          201: zodToJsonSchema(
            SuccessResponseSchema(
              z.object({
                referenceNumber: z.string(),
                totalEntries: z.number(),
                ledgers: z.array(LedgerResponseSchema)
              })
            ),
            { title: 'LedgerBulkCreateResponse' }
          ),
          400: zodToJsonSchema(ErrorResponseSchema, { title: 'ValidationError' })
        }
      }
    },
    async (request, reply) => {
      try {
        // request.body is validated by fastify-type-provider-zod via route schema
        const { ledgers } = request.body;
        const referenceNumber = generateReferenceNumber();
        const userId = request.user.id;
        const now = new Date();

        // Check if all account details and generals exist
        const accountDetailIds = [...new Set(ledgers.map(l => l.accountDetailId))];
        const accountGeneralIds = [...new Set(ledgers.map(l => l.accountGeneralId))];

        const [existingAccountDetails, existingAccountGenerals] = await Promise.all([
          fastify.prisma.accountDetail.findMany({
            where: {
              id: { in: accountDetailIds }
            },
            select: { id: true, accountGeneralId: true }
          }),
          fastify.prisma.accountGeneral.findMany({
            where: {
              id: { in: accountGeneralIds }
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
        // Use Decimal for accurate balancing checks
        const totalsDec = ledgers.reduce(
          (acc, l) => {
            const amtDec = toDecimal(l.amount);
            if (l.transactionType === 'DEBIT') acc.debit = acc.debit.plus(amtDec);
            if (l.transactionType === 'CREDIT') acc.credit = acc.credit.plus(amtDec);
            return acc;
          },
          { debit: toDecimal(0), credit: toDecimal(0) }
        );

        const totals = {
          debit: Number(totalsDec.debit.toFixed(2)),
          credit: Number(totalsDec.credit.toFixed(2))
        };

        if (!totalsDec.debit.minus(totalsDec.credit).equals(0)) {
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
          // Store precise decimal string for Prisma Decimal fields
          amount: formatMoneyForDb(ledger.amount),
          description: ledger.description.trim(),
          accountDetailId: ledger.accountDetailId,
          accountGeneralId: ledger.accountGeneralId,
          ledgerType: ledger.ledgerType,
          transactionType: ledger.transactionType,
          ledgerDate: ledger.ledgerDate
            ? toUtcFromLocal(ledger.ledgerDate, APP_TIMEZONE, { mode: 'exact' })
            : new Date(),
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
              data: {
                id: ulid(),
                ...data
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
            ledgers: createdLedgers.map(l => ({ ...l, amount: roundMoney(l.amount) }))
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
      preHandler: [cacheControl(60, 'private')],
      schema: {
        tags: ['Ledgers'],
        summary: 'Get all ledger entries',
        description:
          'Retrieves all ledger entries with pagination and optional filtering. Requires Admin, Manager, or Accountant role.',
        querystring: LedgerQuerySchema,
        response: {
          200: zodToJsonSchema(SuccessResponseSchema(z.array(LedgerResponseSchema)), {
            title: 'LedgerListResponse'
          })
        }
      }
    },
    async (request, reply) => {
      try {
        // request.query is validated/coerced by fastify-type-provider-zod via route schema
        const { limit = 10, skip } = request.getPagination();
        // request.query still contains other filters validated by Zod
        const {
          // page intentionally omitted - handled by pagination plugin
          // page = 1,
          // limit = 10,
          search,
          ledgerType,
          transactionType,
          postingStatus,
          accountDetailId,
          accountGeneralId,
          startDate,
          endDate
        } = request.query;

        // Normalize date range to day boundaries when provided using date-fns
        // Interpret incoming date strings in the app timezone and convert to UTC instants
        const normalizedStart = startDate
          ? toUtcFromLocal(startDate, APP_TIMEZONE, { mode: 'startOfDay' })
          : undefined;
        const normalizedEnd = endDate
          ? toUtcFromLocal(endDate, APP_TIMEZONE, { mode: 'endOfDay' })
          : undefined;

        // Build where clause
        const where = {
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
            skip,
            take: limit
          })
        ]);
        return reply.paginate(
          ledgers.map(l => ({ ...l, amount: roundMoney(l.amount) })),
          total
        );
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
      preHandler: [cacheControl(60, 'private')],
      schema: {
        tags: ['Ledgers'],
        summary: 'Get ledger by ID',
        description:
          'Retrieves a specific ledger entry by ID. Requires Admin, Manager, or Accountant role.',
        params: IdParamSchema,
        response: {
          200: zodToJsonSchema(SuccessResponseSchema(LedgerResponseSchema), {
            title: 'LedgerGetResponse'
          }),
          404: zodToJsonSchema(ErrorResponseSchema, { title: 'NotFoundResponse' })
        }
      }
    },
    async (request, reply) => {
      try {
        const { id } = request.params; // validated by fastify-type-provider-zod

        const ledger = await fastify.prisma.ledger.findFirst({
          where: { id },
          include: {
            accountDetail: { select: { id: true, accountNumber: true, accountName: true } },
            accountGeneral: { select: { id: true, accountNumber: true, accountName: true } }
          }
        });

        if (!ledger) {
          return reply.code(404).send({
            success: false,
            error: { code: 'LEDGER_NOT_FOUND', message: 'Ledger entry not found' }
          });
        }

        reply.send({ success: true, data: { ...ledger, amount: roundMoney(ledger.amount) } });
      } catch (error) {
        request.log.error('Error fetching ledger:', error);
        reply.code(500).send({
          success: false,
          error: { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to fetch ledger entry' }
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
        params: IdParamSchema,
        body: LedgerUpdateSchema,
        response: {
          200: zodToJsonSchema(SuccessResponseSchema(LedgerResponseSchema), {
            title: 'LedgerUpdateResponse'
          })
        }
      }
    },
    async (request, reply) => {
      try {
        // request.params and request.body are validated by fastify-type-provider-zod
        const { id } = request.params;
        const updateData = request.body;

        // Check if ledger exists and is not deleted
        const existingLedger = await fastify.prisma.ledger.findFirst({
          where: {
            id
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
              amount: roundMoney(updateData.amount)
            }),
            ...(updateData.description && { description: updateData.description.trim() }),
            ...(updateData.ledgerDate && {
              ledgerDate:
                typeof updateData.ledgerDate === 'string'
                  ? toUtcFromLocal(updateData.ledgerDate, APP_TIMEZONE, { mode: 'exact' })
                  : updateData.ledgerDate
            }),
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
          data: { ...updatedLedger, amount: roundMoney(updatedLedger.amount) }
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
        params: IdParamSchema,
        response: {
          200: zodToJsonSchema(SuccessResponseSchema(z.object({ message: z.string() })), {
            title: 'LedgerDeleteResponse'
          })
        }
      }
    },
    async (request, reply) => {
      try {
        // request.params validated by fastify-type-provider-zod
        const { id } = request.params;

        // Check if ledger exists and is not already deleted
        const existingLedger = await fastify.prisma.ledger.findFirst({
          where: {
            id
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
        params: IdParamSchema,
        response: {
          200: zodToJsonSchema(
            SuccessResponseSchema(
              z.object({
                id: z.string(),
                postingStatus: z.string(),
                postingAt: z.string()
              })
            ),
            { title: 'LedgerPostResponse' }
          )
        }
      }
    },
    async (request, reply) => {
      try {
        // request.params validated by fastify-type-provider-zod
        const { id } = request.params;

        // Check if ledger exists and is not deleted
        const existingLedger = await fastify.prisma.ledger.findFirst({
          where: {
            id
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
          200: zodToJsonSchema(
            SuccessResponseSchema(
              z.object({
                id: z.string(),
                postingStatus: z.string(),
                postingAt: z.string().nullable()
              })
            ),
            { title: 'LedgerUnpostResponse' }
          )
        }
      }
    },
    async (request, reply) => {
      try {
        // request.params validated by fastify-type-provider-zod
        const { id } = request.params;

        // Check if ledger exists
        const existingLedger = await fastify.prisma.ledger.findFirst({
          where: {
            id
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
