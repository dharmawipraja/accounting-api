/**
 * Account Detail Routes
 *
 * Routes for managing account details (sub-accounts under general accounts).
 * Access restricted to Admin, Manager (MANAJER), and Accountant (AKUNTAN) roles.
 */

import { nanoid } from 'nanoid';
import { z } from 'zod';
import { authorize } from '../middleware/index.js';
import {
  AccountCategorySchema,
  AccountDetailCreateSchema,
  AccountDetailUpdateSchema,
  BooleanishSchema,
  IdParamSchema,
  PaginationSchema,
  ReportTypeSchema,
  TransactionTypeSchema,
  UUIDSchema
} from '../schemas/index.js';

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
          body: {
            type: 'object',
            properties: {
              accountNumber: {
                type: 'string',
                minLength: 1,
                maxLength: 20,
                pattern: '^[0-9\\-]+$',
                description: 'Account number (numbers and hyphens only)'
              },
              accountName: {
                type: 'string',
                minLength: 3,
                maxLength: 100,
                description: 'Account name'
              },
              accountGeneralId: {
                type: 'string',
                description: 'ID of the parent general account'
              },
              accountCategory: {
                type: 'string',
                enum: ['ASSET', 'HUTANG', 'MODAL', 'PENDAPATAN', 'BIAYA'],
                description: 'Account category'
              },
              reportType: {
                type: 'string',
                enum: ['NERACA', 'LABA_RUGI'],
                description: 'Report type'
              },
              transactionType: {
                type: 'string',
                enum: ['DEBIT', 'CREDIT'],
                description: 'Transaction type'
              },
              amountCredit: {
                type: 'number',
                minimum: 0,
                maximum: 99999999.99,
                default: 0,
                description: 'Credit amount'
              },
              amountDebit: {
                type: 'number',
                minimum: 0,
                maximum: 99999999.99,
                default: 0,
                description: 'Debit amount'
              }
            },
            required: [
              'accountNumber',
              'accountName',
              'accountGeneralId',
              'accountCategory',
              'reportType',
              'transactionType'
            ]
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
                    id: { type: 'string' },
                    accountNumber: { type: 'string' },
                    accountName: { type: 'string' },
                    accountType: { type: 'string' },
                    accountGeneralId: { type: 'string' },
                    accountCategory: { type: 'string' },
                    reportType: { type: 'string' },
                    transactionType: { type: 'string' },
                    amountCredit: { type: 'number' },
                    amountDebit: { type: 'number' },
                    createdAt: { type: 'string', format: 'date-time' },
                    updatedAt: { type: 'string', format: 'date-time' },
                    createdBy: { type: 'string' },
                    updatedBy: { type: 'string' }
                  }
                }
              }
            },
            400: {
              type: 'object',
              properties: {
                success: { type: 'boolean', default: false },
                message: { type: 'string' },
                errors: {
                  type: 'array',
                  items: { type: 'object' }
                }
              }
            },
            409: {
              type: 'object',
              properties: {
                success: { type: 'boolean', default: false },
                message: { type: 'string' }
              }
            }
          }
        }
      },
      async (request, reply) => {
        const userId = request.user.id;
        const accountDetailData = {
          ...request.body,
          accountType: 'DETAIL', // Always set to DETAIL for account details
          createdBy: userId,
          updatedBy: userId,
          updatedAt: new Date()
        };

        try {
          // Validate the request body
          const validation = AccountDetailCreateSchema.safeParse(accountDetailData);
          if (!validation.success) {
            return reply.status(400).send({
              success: false,
              message: 'Validation failed',
              errors: validation.error.errors
            });
          }
          const validatedData = validation.data;
          // Round monetary amounts to 2 decimals
          validatedData.amountCredit =
            Math.round(Number(validatedData.amountCredit || 0) * 100) / 100;
          validatedData.amountDebit =
            Math.round(Number(validatedData.amountDebit || 0) * 100) / 100;

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

          // Verify the general account exists and is not deleted
          const generalAccount = await fastify.prisma.accountGeneral.findFirst({
            where: {
              id: validatedData.accountGeneralId,
              deletedAt: null
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
            data: validatedData,
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
            data: accountDetail
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
        schema: {
          tags: ['Account Detail'],
          summary: 'Get all account details',
          description:
            'Retrieves all account details with optional filtering and pagination. Requires Admin, Manager, or Accountant role.',
          querystring: {
            type: 'object',
            properties: {
              page: {
                type: 'integer',
                minimum: 1,
                default: 1,
                description: 'Page number for pagination'
              },
              limit: {
                type: 'integer',
                minimum: 1,
                maximum: 100,
                default: 10,
                description: 'Number of items per page'
              },
              search: {
                type: 'string',
                minLength: 1,
                description: 'Search in account number or name'
              },
              accountCategory: {
                type: 'string',
                enum: ['ASSET', 'HUTANG', 'MODAL', 'PENDAPATAN', 'BIAYA'],
                description: 'Filter by account category'
              },
              reportType: {
                type: 'string',
                enum: ['NERACA', 'LABA_RUGI'],
                description: 'Filter by report type'
              },
              transactionType: {
                type: 'string',
                enum: ['DEBIT', 'CREDIT'],
                description: 'Filter by transaction type'
              },
              accountGeneralId: {
                type: 'string',
                description: 'Filter by parent general account'
              },
              includeDeleted: {
                type: ['boolean', 'string'],
                default: false,
                description: 'Include soft deleted records'
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
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      accountNumber: { type: 'string' },
                      accountName: { type: 'string' },
                      accountType: { type: 'string' },
                      accountGeneralId: { type: 'string' },
                      accountCategory: { type: 'string' },
                      reportType: { type: 'string' },
                      transactionType: { type: 'string' },
                      amountCredit: { type: 'number' },
                      amountDebit: { type: 'number' },
                      createdAt: { type: 'string', format: 'date-time' },
                      updatedAt: { type: 'string', format: 'date-time' },
                      deletedAt: {
                        type: ['string', 'null'],
                        format: 'date-time'
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
                },
                pagination: {
                  type: 'object',
                  properties: {
                    page: { type: 'integer' },
                    limit: { type: 'integer' },
                    total: { type: 'integer' },
                    totalPages: { type: 'integer' },
                    hasNextPage: { type: 'boolean' },
                    hasPreviousPage: { type: 'boolean' }
                  }
                }
              }
            }
          }
        }
      },
      async (request, reply) => {
        try {
          // Validate and normalize query params
          const qValidation = AccountDetailListQuerySchema.safeParse(request.query);
          if (!qValidation.success) {
            return reply.status(400).send({
              success: false,
              message: 'Invalid query parameters',
              errors: qValidation.error.errors
            });
          }
          const {
            page,
            limit,
            search,
            accountCategory,
            reportType,
            transactionType,
            accountGeneralId,
            includeDeleted
          } = qValidation.data;

          const includeDeletedBool = !!includeDeleted;

          const skip = (page - 1) * limit;

          // Build where clause
          const where = {
            ...(includeDeletedBool ? {} : { deletedAt: null }),
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
          const total = await fastify.prisma.accountDetail.count({
            where
          });

          // Get account details with relations
          const accountDetails = await fastify.prisma.accountDetail.findMany({
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

          const totalPages = Math.ceil(total / limit);

          reply.send({
            success: true,
            message: 'Account details retrieved successfully',
            data: accountDetails,
            pagination: {
              page,
              limit,
              total,
              totalPages,
              hasNextPage: page < totalPages,
              hasPreviousPage: page > 1
            }
          });
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
        schema: {
          tags: ['Account Detail'],
          summary: 'Get account detail by ID',
          description:
            'Retrieves a specific account detail by ID. Requires Admin, Manager, or Accountant role.',
          params: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: 'Account detail ID'
              }
            },
            required: ['id']
          },
          querystring: {
            type: 'object',
            properties: {
              includeDeleted: {
                type: ['boolean', 'string'],
                default: false,
                description: 'Include if the record is soft deleted'
              },
              includeLedgers: {
                type: ['boolean', 'string'],
                default: false,
                description: 'Include related ledger entries'
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
                    accountNumber: { type: 'string' },
                    accountName: { type: 'string' },
                    accountType: { type: 'string' },
                    accountGeneralId: { type: 'string' },
                    accountCategory: { type: 'string' },
                    reportType: { type: 'string' },
                    transactionType: { type: 'string' },
                    amountCredit: { type: 'number' },
                    amountDebit: { type: 'number' },
                    createdAt: { type: 'string', format: 'date-time' },
                    updatedAt: { type: 'string', format: 'date-time' },
                    deletedAt: {
                      type: ['string', 'null'],
                      format: 'date-time'
                    },
                    accountGeneral: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        accountNumber: { type: 'string' },
                        accountName: { type: 'string' },
                        accountCategory: { type: 'string' },
                        reportType: { type: 'string' },
                        transactionType: { type: 'string' }
                      }
                    },
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
                          ledgerDate: { type: 'string', format: 'date-time' },
                          createdAt: { type: 'string', format: 'date-time' }
                        }
                      }
                    }
                  }
                }
              }
            },
            404: {
              type: 'object',
              properties: {
                success: { type: 'boolean', default: false },
                message: { type: 'string' }
              }
            }
          }
        }
      },
      async (request, reply) => {
        try {
          // Validate params and query
          const paramsValidation = IdParamSchema.safeParse(request.params);
          if (!paramsValidation.success) {
            return reply.status(400).send({
              success: false,
              message: 'Invalid account detail ID format'
            });
          }
          const { id } = paramsValidation.data;

          const queryValidation = AccountDetailGetQuerySchema.safeParse(request.query);
          if (!queryValidation.success) {
            return reply.status(400).send({
              success: false,
              message: 'Invalid query parameters',
              errors: queryValidation.error.errors
            });
          }
          const { includeDeleted: includeDeletedBool, includeLedgers: includeLedgersBool } =
            queryValidation.data;

          const accountDetail = await fastify.prisma.accountDetail.findFirst({
            where: {
              id,
              ...(includeDeletedBool ? {} : { deletedAt: null })
            },
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
                  where: { deletedAt: null },
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
                  take: 10 // Limit to recent 10 ledger entries
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
            data: accountDetail
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
          params: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: 'Account detail ID'
              }
            },
            required: ['id']
          },
          body: {
            type: 'object',
            properties: {
              accountName: {
                type: 'string',
                minLength: 3,
                maxLength: 100,
                description: 'Account name'
              },
              accountCategory: {
                type: 'string',
                enum: ['ASSET', 'HUTANG', 'MODAL', 'PENDAPATAN', 'BIAYA'],
                description: 'Account category'
              },
              reportType: {
                type: 'string',
                enum: ['NERACA', 'LABA_RUGI'],
                description: 'Report type'
              },
              transactionType: {
                type: 'string',
                enum: ['DEBIT', 'CREDIT'],
                description: 'Transaction type'
              },
              amountCredit: {
                type: 'number',
                minimum: 0,
                maximum: 99999999.99,
                description: 'Credit amount'
              },
              amountDebit: {
                type: 'number',
                minimum: 0,
                maximum: 99999999.99,
                description: 'Debit amount'
              }
            },
            minProperties: 1,
            additionalProperties: false
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
                    accountNumber: { type: 'string' },
                    accountName: { type: 'string' },
                    accountType: { type: 'string' },
                    accountGeneralId: { type: 'string' },
                    accountCategory: { type: 'string' },
                    reportType: { type: 'string' },
                    transactionType: { type: 'string' },
                    amountCredit: { type: 'number' },
                    amountDebit: { type: 'number' },
                    createdAt: { type: 'string', format: 'date-time' },
                    updatedAt: { type: 'string', format: 'date-time' },
                    updatedBy: { type: 'string' }
                  }
                }
              }
            },
            400: {
              type: 'object',
              properties: {
                success: { type: 'boolean', default: false },
                message: { type: 'string' },
                errors: {
                  type: 'array',
                  items: { type: 'object' }
                }
              }
            },
            404: {
              type: 'object',
              properties: {
                success: { type: 'boolean', default: false },
                message: { type: 'string' }
              }
            }
          }
        }
      },
      async (request, reply) => {
        try {
          const userId = request.user.id;

          // Validate params
          const paramsValidation = IdParamSchema.safeParse(request.params);
          if (!paramsValidation.success) {
            return reply.status(400).send({
              success: false,
              message: 'Invalid account detail ID format'
            });
          }
          const { id } = paramsValidation.data;

          // Validate update data
          const updateValidation = AccountDetailUpdateSchema.safeParse({
            ...request.body,
            updatedBy: userId,
            updatedAt: new Date()
          });
          if (!updateValidation.success) {
            return reply.status(400).send({
              success: false,
              message: 'Validation failed',
              errors: updateValidation.error.errors
            });
          }
          const updateData = updateValidation.data;

          // Round monetary amounts if provided
          if (typeof updateData.amountCredit === 'number') {
            updateData.amountCredit = Math.round(Number(updateData.amountCredit) * 100) / 100;
          }
          if (typeof updateData.amountDebit === 'number') {
            updateData.amountDebit = Math.round(Number(updateData.amountDebit) * 100) / 100;
          }

          // Check if account detail exists and is not deleted
          const existingAccountDetail = await fastify.prisma.accountDetail.findFirst({
            where: {
              id,
              deletedAt: null
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
            data: updatedAccountDetail
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
          params: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: 'Account detail ID'
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
                    accountNumber: { type: 'string' },
                    accountName: { type: 'string' },
                    deletedAt: { type: 'string', format: 'date-time' }
                  }
                }
              }
            },
            400: {
              type: 'object',
              properties: {
                success: { type: 'boolean', default: false },
                message: { type: 'string' }
              }
            },
            404: {
              type: 'object',
              properties: {
                success: { type: 'boolean', default: false },
                message: { type: 'string' }
              }
            }
          }
        }
      },
      async (request, reply) => {
        try {
          // Validate params
          const paramsValidation = IdParamSchema.safeParse(request.params);
          if (!paramsValidation.success) {
            return reply.status(400).send({
              success: false,
              message: 'Invalid account detail ID format'
            });
          }
          const { id } = paramsValidation.data;

          // Check if account detail exists and is not already deleted
          const existingAccountDetail = await fastify.prisma.accountDetail.findFirst({
            where: {
              id,
              deletedAt: null
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
              accountDetailId: id,
              deletedAt: null
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
              accountNumber: `${existingAccountDetail.accountNumber}-DELETED-${nanoid(6)}`,
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
