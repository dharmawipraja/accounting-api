/**
 * Account Detail Routes
 *
 * Routes for managing account details (sub-accounts under general accounts).
 * Access restricted to Admin, Manager (MANAJER), and Accountant (AKUNTAN) roles.
 */

import { ulid } from 'ulid';
import { z } from 'zod';
import { cacheControl } from '../middleware/caching.js';
import { authorize } from '../middleware/index.js';
// ...existing code...
import {
  AccountCategorySchema,
  AccountDetailCreateSchema,
  AccountDetailUpdateSchema,
  AccountResponseSchema,
  BooleanishSchema,
  ErrorResponseSchema,
  IdParamSchema,
  PaginationSchema,
  ReportTypeSchema,
  SuccessResponseSchema,
  TransactionTypeSchema,
  UUIDSchema
} from '../schemas/index.js';
import { formatMoneyForDb, roundMoney } from '../utils/index.js';

/**
 * Authorization middleware for account detail operations
 * Only Admin, Manager, and Accountant can manage account details
 */
const requireAccountDetailAccess = authorize('ADMIN', 'MANAJER', 'AKUNTAN');

/**
 * Account Detail Routes Plugin
 */
export const accountDetailRoutes = async fastify => {
  // Prefix all routes with /accounts-detail
  await fastify.register(async fastify => {
    // Apply authentication middleware to all routes in this group
    fastify.addHook('onRequest', requireAccountDetailAccess);

    const AccountDetailListQuerySchema = PaginationSchema.extend({
      search: z.string().optional(),
      accountCategory: AccountCategorySchema.optional(),
      reportType: ReportTypeSchema.optional(),
      transactionType: TransactionTypeSchema.optional(),
      accountGeneralId: UUIDSchema.optional(),
      includeDeleted: BooleanishSchema
    });

    const AccountDetailGetQuerySchema = z.object({
      includeDeleted: BooleanishSchema.default(false),
      includeLedgers: BooleanishSchema.default(false)
    });

    /**
     * Create Account Detail
     * POST /accounts-detail
     *
     * Creates a new account detail entry under a general account.
     * Only accessible by Admin, Manager, and Accountant.
     */
    fastify.post(
      '/',
      {
        schema: {
          tags: ['Account Detail'],
          summary: 'Create a new account detail',
          description:
            'Creates a new account detail entry under a general account. Requires Admin, Manager, or Accountant role.',
          // Use Zod route-level schema (fastify-type-provider-zod)
          body: AccountDetailCreateSchema.omit({ createdBy: true, updatedBy: true }),
          response: {
            201: SuccessResponseSchema(AccountResponseSchema),
            400: ErrorResponseSchema,
            409: ErrorResponseSchema
          }
        }
      },
      async (request, reply) => {
        const userId = request.user.id;
        const validatedData = {
          ...request.body,
          accountType: 'DETAIL', // Always set to DETAIL for account details
          createdBy: userId,
          updatedBy: userId,
          updatedAt: new Date()
        };

        try {
          // request.body is already validated by fastify-type-provider-zod via route schema
          // Round monetary amounts for API and prepare DB-friendly strings
          validatedData.amountCredit = roundMoney(validatedData.amountCredit);
          validatedData.amountDebit = roundMoney(validatedData.amountDebit);

          // Check if account number already exists
          const existingAccount = await fastify.prisma.accountDetail.findUnique({
            where: { accountNumber: validatedData.accountNumber }
          });

          if (existingAccount) {
            return reply.status(409).send({
              success: false,
              message: 'Account number already exists'
            });
          }

          // Verify the general account exists
          const generalAccount = await fastify.prisma.accountGeneral.findFirst({
            where: {
              id: validatedData.accountGeneralId
            }
          });

          if (!generalAccount) {
            return reply.status(400).send({
              success: false,
              message: 'Parent general account not found or has been deleted'
            });
          }

          // Create the account detail
          const accountDetail = await fastify.prisma.accountDetail.create({
            data: {
              id: ulid(),
              ...validatedData,
              amountCredit: formatMoneyForDb(validatedData.amountCredit),
              amountDebit: formatMoneyForDb(validatedData.amountDebit)
            },
            include: {
              accountGeneral: {
                select: {
                  id: true,
                  accountNumber: true,
                  accountName: true
                }
              }
            }
          });

          reply.status(201).send({
            success: true,
            message: 'Account detail created successfully',
            data: {
              ...accountDetail,
              amountCredit: roundMoney(accountDetail.amountCredit),
              amountDebit: roundMoney(accountDetail.amountDebit)
            }
          });
        } catch (error) {
          request.log.error('Account detail creation failed:', error);

          if (error.code === 'P2002') {
            return reply.status(409).send({
              success: false,
              message: 'Account number must be unique'
            });
          }

          throw error;
        }
      }
    );

    /**
     * Get All Account Details
     * GET /accounts-detail
     *
     * Retrieves all account details with optional filtering and pagination.
     * Only accessible by Admin, Manager, and Accountant.
     */
    fastify.get(
      '/',
      {
        preHandler: [cacheControl(300, 'private')],
        schema: {
          tags: ['Account Detail'],
          summary: 'Get all account details',
          description:
            'Retrieves all account details with optional filtering and pagination. Requires Admin, Manager, or Accountant role.',
          querystring: AccountDetailListQuerySchema,
          response: {
            200: SuccessResponseSchema(z.array(AccountResponseSchema))
          }
        }
      },
      async (request, reply) => {
        try {
          // Use pagination helper
          const { limit, skip } = request.getPagination();
          const {
            // page intentionally handled by plugin
            // page = 1,
            // limit = 10,
            search,
            accountCategory,
            reportType,
            transactionType,
            accountGeneralId,
            includeDeleted
          } = request.query;

          const includeDeletedBool = !!includeDeleted;

          // Build where clause
          const where = {
            ...(accountCategory && { accountCategory }),
            ...(reportType && { reportType }),
            ...(transactionType && { transactionType }),
            ...(accountGeneralId && { accountGeneralId }),
            ...(search && {
              OR: [
                {
                  accountNumber: {
                    contains: search,
                    mode: 'insensitive'
                  }
                },
                {
                  accountName: {
                    contains: search,
                    mode: 'insensitive'
                  }
                }
              ]
            })
          };

          // Get total count for pagination
          // Use raw client if includeDeleted requested to bypass the soft-delete extension
          const total = includeDeletedBool
            ? await fastify.prisma.withSoftDeleted(p => p.accountDetail.count({ where }))
            : await fastify.prisma.accountDetail.count({ where });

          // Get account details with relations
          let accountDetails;
          if (includeDeletedBool) {
            accountDetails = await fastify.prisma.withSoftDeleted(p =>
              p.accountDetail.findMany({
                where,
                include: {
                  accountGeneral: {
                    select: {
                      id: true,
                      accountNumber: true,
                      accountName: true
                    }
                  }
                },
                orderBy: [{ accountNumber: 'asc' }, { accountName: 'asc' }],
                skip,
                take: limit
              })
            );
          } else {
            accountDetails = await fastify.prisma.accountDetail.findMany({
              where,
              include: {
                accountGeneral: {
                  select: {
                    id: true,
                    accountNumber: true,
                    accountName: true
                  }
                }
              },
              orderBy: [{ accountNumber: 'asc' }, { accountName: 'asc' }],
              skip,
              take: limit
            });
          }

          return reply.paginate(
            accountDetails.map(a => ({
              ...a,
              amountCredit: roundMoney(a.amountCredit),
              amountDebit: roundMoney(a.amountDebit)
            })),
            total
          );
        } catch (error) {
          request.log.error('Failed to retrieve account details:', error);
          throw error;
        }
      }
    );

    /**
     * Get Single Account Detail
     * GET /accounts-detail/:id
     *
     * Retrieves a specific account detail by ID.
     * Only accessible by Admin, Manager, and Accountant.
     */
    fastify.get(
      '/:id',
      {
        preHandler: [cacheControl(300, 'private')],
        schema: {
          tags: ['Account Detail'],
          summary: 'Get account detail by ID',
          description:
            'Retrieves a specific account detail by ID. Requires Admin, Manager, or Accountant role.',
          params: IdParamSchema,
          querystring: AccountDetailGetQuerySchema,
          response: {
            200: SuccessResponseSchema(AccountResponseSchema),
            404: ErrorResponseSchema
          }
        }
      },
      async (request, reply) => {
        try {
          // request.params and request.query are validated/coerced by fastify-type-provider-zod
          const { id } = request.params;
          const { includeDeleted: includeDeletedBool, includeLedgers: includeLedgersBool } =
            request.query;

          // When includeDeletedBool is true we need to bypass the extension to include deleted rows
          const accountDetail = includeDeletedBool
            ? await fastify.prisma.withSoftDeleted(p =>
                p.accountDetail.findUnique({
                  where: { id },
                  include: {
                    accountGeneral: {
                      select: {
                        id: true,
                        accountNumber: true,
                        accountName: true,
                        accountCategory: true,
                        reportType: true,
                        transactionType: true
                      }
                    },
                    ...(includeLedgersBool && {
                      ledgers: {
                        select: {
                          id: true,
                          referenceNumber: true,
                          amount: true,
                          description: true,
                          ledgerType: true,
                          transactionType: true,
                          postingStatus: true,
                          ledgerDate: true,
                          createdAt: true
                        },
                        orderBy: { createdAt: 'desc' },
                        take: 10
                      }
                    })
                  }
                })
              )
            : await fastify.prisma.accountDetail.findFirst({
                where: { id },
                include: {
                  accountGeneral: {
                    select: {
                      id: true,
                      accountNumber: true,
                      accountName: true,
                      accountCategory: true,
                      reportType: true,
                      transactionType: true
                    }
                  },
                  ...(includeLedgersBool && {
                    ledgers: {
                      select: {
                        id: true,
                        referenceNumber: true,
                        amount: true,
                        description: true,
                        ledgerType: true,
                        transactionType: true,
                        postingStatus: true,
                        ledgerDate: true,
                        createdAt: true
                      },
                      orderBy: { createdAt: 'desc' },
                      take: 10
                    }
                  })
                }
              });

          if (!accountDetail) {
            return reply.status(404).send({
              success: false,
              message: 'Account detail not found'
            });
          }

          reply.send({
            success: true,
            message: 'Account detail retrieved successfully',
            data: {
              ...accountDetail,
              amountCredit: roundMoney(accountDetail.amountCredit),
              amountDebit: roundMoney(accountDetail.amountDebit),
              ...(accountDetail.ledgers && {
                ledgers: accountDetail.ledgers.map(l => ({
                  ...l,
                  amount: roundMoney(l.amount)
                }))
              })
            }
          });
        } catch (error) {
          request.log.error('Failed to retrieve account detail:', error);

          throw error;
        }
      }
    );

    /**
     * Edit Account Detail
     * PUT /accounts-detail/:id
     *
     * Updates an existing account detail.
     * Only accessible by Admin, Manager, and Accountant.
     */
    fastify.put(
      '/:id',
      {
        schema: {
          tags: ['Account Detail'],
          summary: 'Update account detail',
          description:
            'Updates an existing account detail. Requires Admin, Manager, or Accountant role.',
          params: IdParamSchema,
          body: AccountDetailUpdateSchema,
          response: {
            200: SuccessResponseSchema(AccountResponseSchema),
            400: ErrorResponseSchema,
            404: ErrorResponseSchema
          }
        }
      },
      async (request, reply) => {
        try {
          const userId = request.user.id;

          // request.params and request.body are validated/coerced by fastify-type-provider-zod
          const { id } = request.params;
          const updateData = {
            ...request.body,
            updatedBy: userId,
            updatedAt: new Date()
          };

          // Round monetary amounts if provided
          if (typeof updateData.amountCredit === 'number') {
            updateData.amountCredit = roundMoney(updateData.amountCredit);
            updateData.amountCredit = formatMoneyForDb(updateData.amountCredit);
          }
          if (typeof updateData.amountDebit === 'number') {
            updateData.amountDebit = roundMoney(updateData.amountDebit);
            updateData.amountDebit = formatMoneyForDb(updateData.amountDebit);
          }

          // Check if account detail exists and is not deleted
          const existingAccountDetail = await fastify.prisma.accountDetail.findFirst({
            where: {
              id
            }
          });

          if (!existingAccountDetail) {
            return reply.status(404).send({
              success: false,
              message: 'Account detail not found or has been deleted'
            });
          }

          // Update the account detail
          const updatedAccountDetail = await fastify.prisma.accountDetail.update({
            where: { id },
            data: updateData,
            include: {
              accountGeneral: {
                select: {
                  id: true,
                  accountNumber: true,
                  accountName: true
                }
              }
            }
          });

          reply.send({
            success: true,
            message: 'Account detail updated successfully',
            data: {
              ...updatedAccountDetail,
              amountCredit: roundMoney(updatedAccountDetail.amountCredit),
              amountDebit: roundMoney(updatedAccountDetail.amountDebit)
            }
          });
        } catch (error) {
          request.log.error('Account detail update failed:', error);

          if (error.code === 'P2025') {
            return reply.status(404).send({
              success: false,
              message: 'Account detail not found'
            });
          }

          throw error;
        }
      }
    );

    /**
     * Delete Account Detail (Soft Delete)
     * DELETE /accounts-detail/:id
     *
     * Soft deletes an account detail by setting deletedAt timestamp.
     * Only accessible by Admin, Manager, and Accountant.
     */
    fastify.delete(
      '/:id',
      {
        schema: {
          tags: ['Account Detail'],
          summary: 'Soft delete account detail',
          description:
            'Soft deletes an account detail by setting deletedAt timestamp. Requires Admin, Manager, or Accountant role.',
          params: IdParamSchema,
          response: {
            200: SuccessResponseSchema(AccountResponseSchema),
            400: ErrorResponseSchema,
            404: ErrorResponseSchema
          }
        }
      },
      async (request, reply) => {
        try {
          // request.params is validated by fastify-type-provider-zod
          const { id } = request.params;

          // Check if account detail exists
          const existingAccountDetail = await fastify.prisma.accountDetail.findFirst({
            where: {
              id
            }
          });

          if (!existingAccountDetail) {
            return reply.status(404).send({
              success: false,
              message: 'Account detail not found or has already been deleted'
            });
          }

          // Check if account detail has related ledger entries
          const relatedLedgers = await fastify.prisma.ledger.findFirst({
            where: {
              accountDetailId: id
            }
          });

          if (relatedLedgers) {
            return reply.status(400).send({
              success: false,
              message:
                'Cannot delete account detail with existing ledger entries. Please delete or move the ledger entries first.'
            });
          }

          // Perform soft delete
          const deletedAccountDetail = await fastify.prisma.accountDetail.update({
            where: { id },
            data: {
              accountNumber: `${existingAccountDetail.accountNumber}-DELETED-${ulid().slice(-6).toUpperCase()}`,
              deletedAt: new Date(),
              updatedBy: request.user.id,
              updatedAt: new Date()
            },
            select: {
              id: true,
              accountNumber: true,
              accountName: true,
              deletedAt: true
            }
          });

          reply.send({
            success: true,
            message: 'Account detail deleted successfully',
            data: deletedAccountDetail
          });
        } catch (error) {
          request.log.error('Account detail deletion failed:', error);

          if (error.code === 'P2025') {
            return reply.status(404).send({
              success: false,
              message: 'Account detail not found'
            });
          }

          throw error;
        }
      }
    );
  });
};
