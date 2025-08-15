/**
 * Account General Routes
 *
 * Routes for managing account general (chart of accounts).
 * Access restricted to Admin, Manager (MANAJER), and Accountant (AKUNTAN) roles.
 */

import { nanoid } from 'nanoid';
import { z } from 'zod';
import { cacheControl } from '../middleware/caching.js';
import { authorize } from '../middleware/index.js';
import { zodToJsonSchema } from '../middleware/validation.js';
import {
  AccountCategorySchema,
  AccountGeneralCreateSchema,
  AccountGeneralUpdateSchema,
  AccountResponseSchema,
  ErrorResponseSchema,
  IdParamSchema,
  ReportTypeSchema,
  SuccessResponseSchema
} from '../schemas/index.js';
import { formatMoneyForDb, roundMoney } from '../utils/index.js';

/**
 * Authorization middleware for account general operations
 * Only Admin, Manager, and Accountant can manage account general
 */
const requireAccountGeneralAccess = authorize('ADMIN', 'MANAJER', 'AKUNTAN');

/**
 * Account General Routes Plugin
 */
export const accountGeneralRoutes = async fastify => {
  // Prefix all routes with /accounts-general
  await fastify.register(async fastify => {
    // Apply authentication middleware to all routes in this group
    fastify.addHook('onRequest', requireAccountGeneralAccess);

    // Local query schema with default limit 20 to preserve current API behavior
    const GeneralListQuerySchema = z.object({
      page: z
        .string()
        .or(z.number())
        .optional()
        .transform(val => (val ? parseInt(String(val)) : 1))
        .refine(val => val >= 1, 'Page must be >= 1'),
      limit: z
        .string()
        .or(z.number())
        .optional()
        .transform(val => (val ? parseInt(String(val)) : 20))
        .refine(val => val >= 1 && val <= 100, 'Limit must be between 1 and 100'),
      accountCategory: AccountCategorySchema.optional(),
      reportType: ReportTypeSchema.optional(),
      search: z.string().optional()
    });

    /**
     * Create Account General
     * POST /accounts-general
     *
     * Creates a new account general entry.
     * Only accessible by Admin, Manager, and Accountant.
     */
    fastify.post(
      '/',
      {
        schema: {
          tags: ['Account General'],
          summary: 'Create a new account general',
          description:
            'Creates a new account general entry. Requires Admin, Manager, or Accountant role.',
          // Use Zod schema for request body validation
          body: AccountGeneralCreateSchema.omit({ createdBy: true, updatedBy: true }),
          response: {
            201: zodToJsonSchema(SuccessResponseSchema(AccountResponseSchema), {
              title: 'AccountGeneralCreateResponse'
            }),
            400: zodToJsonSchema(ErrorResponseSchema, { title: 'ValidationError' }),
            409: zodToJsonSchema(ErrorResponseSchema, { title: 'ConflictResponse' })
          }
        }
      },
      async (request, reply) => {
        try {
          const userId = request.user.id;

          // Request body is validated by fastify-type-provider-zod and available as request.body
          const accountData = request.body;

          // Round monetary amounts to 2 decimals
          const roundedAccountData = {
            ...accountData,
            // Keep rounded values for API-level numbers, but store precise strings to DB
            amountCredit: roundMoney(accountData.amountCredit),
            amountDebit: roundMoney(accountData.amountDebit)
          };

          // Check if account number already exists
          const existingAccount = await fastify.prisma.accountGeneral.findUnique({
            where: {
              accountNumber: roundedAccountData.accountNumber
            }
          });

          if (existingAccount) {
            return reply.status(409).send({
              success: false,
              message: 'Account number already exists'
            });
          }

          // Create account general
          const newAccount = await fastify.prisma.accountGeneral.create({
            data: {
              ...roundedAccountData,
              // Write precise decimal strings to the DB
              amountCredit: formatMoneyForDb(roundedAccountData.amountCredit),
              amountDebit: formatMoneyForDb(roundedAccountData.amountDebit),
              accountType: 'GENERAL',
              createdBy: userId,
              updatedBy: userId,
              updatedAt: new Date()
            }
          });

          return reply.status(201).send({
            success: true,
            message: 'Account general created successfully',
            data: {
              ...newAccount,
              amountCredit: roundMoney(newAccount.amountCredit),
              amountDebit: roundMoney(newAccount.amountDebit)
            }
          });
        } catch (error) {
          request.log.error('Error creating account general:', error);
          return reply.status(500).send({
            success: false,
            message: 'Internal server error'
          });
        }
      }
    );

    /**
     * Get All Account General
     * GET /accounts-general
     *
     * Retrieves all account general entries with pagination.
     * Only accessible by Admin, Manager, and Accountant.
     */
    fastify.get(
      '/',
      {
        preHandler: [cacheControl(300, 'private')],
        schema: {
          tags: ['Account General'],
          summary: 'Get all account general',
          description:
            'Retrieves all account general entries with pagination. Requires Admin, Manager, or Accountant role.',
          // Use Zod schema for querystring validation and transformation
          querystring: GeneralListQuerySchema,
          response: {
            200: zodToJsonSchema(SuccessResponseSchema(z.array(AccountResponseSchema)), {
              title: 'AccountGeneralListResponse'
            })
          }
        }
      },
      async (request, reply) => {
        try {
          // Use pagination helper
          const { limit, skip } = request.getPagination();
          const { accountCategory, reportType, search } = request.query;

          // Build where clause
          const where = {
            ...(accountCategory && { accountCategory }),
            ...(reportType && { reportType }),
            ...(search && {
              OR: [
                { accountNumber: { contains: search, mode: 'insensitive' } },
                { accountName: { contains: search, mode: 'insensitive' } }
              ]
            })
          };

          // Get total count
          const total = await fastify.prisma.accountGeneral.count({ where });

          // Get paginated data
          const accounts = await fastify.prisma.accountGeneral.findMany({
            where,
            skip,
            take: limit,
            orderBy: { accountNumber: 'asc' },
            select: {
              id: true,
              accountNumber: true,
              accountName: true,
              accountCategory: true,
              accountType: true,
              reportType: true,
              transactionType: true,
              amountCredit: true,
              amountDebit: true,
              createdAt: true,
              updatedAt: true
            }
          });

          return reply.paginate(
            accounts.map(a => ({
              ...a,
              amountCredit: roundMoney(a.amountCredit),
              amountDebit: roundMoney(a.amountDebit)
            })),
            total
          );
        } catch (error) {
          request.log.error('Error retrieving account general list:', error);
          return reply.status(500).send({
            success: false,
            message: 'Internal server error'
          });
        }
      }
    );

    /**
     * Get Account General by ID
     * GET /accounts-general/:id
     *
     * Retrieves account general details by ID.
     * Only accessible by Admin, Manager, and Accountant.
     */
    fastify.get(
      '/:id',
      {
        preHandler: [cacheControl(300, 'private')],
        schema: {
          tags: ['Account General'],
          summary: 'Get account general by ID',
          description:
            'Retrieves account general details by ID. Requires Admin, Manager, or Accountant role.',
          params: IdParamSchema,
          response: {
            200: zodToJsonSchema(SuccessResponseSchema(AccountResponseSchema), {
              title: 'AccountGeneralGetResponse'
            }),
            404: zodToJsonSchema(ErrorResponseSchema, { title: 'NotFoundResponse' })
          }
        }
      },
      async (request, reply) => {
        try {
          // request.params validated by fastify-type-provider-zod via route schema
          const { id } = request.params;

          // Get account general with related counts
          const account = await fastify.prisma.accountGeneral.findFirst({
            where: {
              id
            },
            include: {
              _count: {
                select: {
                  accountsDetail: true,
                  ledgers: true
                }
              }
            }
          });

          if (!account) {
            return reply.status(404).send({
              success: false,
              message: 'Account general not found'
            });
          }

          return reply.send({
            success: true,
            message: 'Account general details retrieved successfully',
            data: {
              ...account,
              amountCredit: roundMoney(account.amountCredit),
              amountDebit: roundMoney(account.amountDebit)
            }
          });
        } catch (error) {
          request.log.error('Error retrieving account general:', error);
          return reply.status(500).send({
            success: false,
            message: 'Internal server error'
          });
        }
      }
    );

    /**
     * Update Account General
     * PUT /accounts-general/:id
     *
     * Updates account general information.
     * Only accessible by Admin, Manager, and Accountant.
     */
    fastify.put(
      '/:id',
      {
        schema: {
          tags: ['Account General'],
          summary: 'Update account general',
          description:
            'Updates account general information. Requires Admin, Manager, or Accountant role.',
          params: IdParamSchema,
          // Use Zod schema for request body validation
          body: AccountGeneralUpdateSchema.omit({ updatedBy: true }),

          response: {
            200: zodToJsonSchema(SuccessResponseSchema(AccountResponseSchema), {
              title: 'AccountGeneralUpdateResponse'
            }),
            404: zodToJsonSchema(ErrorResponseSchema, { title: 'NotFoundResponse' })
          }
        }
      },
      async (request, reply) => {
        try {
          // request.params and request.body are validated by fastify-type-provider-zod via route schema
          const { id } = request.params;
          const validatedBody = request.body;

          const userId = request.user.id;
          const updateData = {
            ...validatedBody,
            ...(typeof validatedBody.amountCredit === 'number' && {
              amountCredit: roundMoney(validatedBody.amountCredit)
            }),
            ...(typeof validatedBody.amountDebit === 'number' && {
              amountDebit: roundMoney(validatedBody.amountDebit)
            })
          };

          // Check if account exists and not deleted
          const existingAccount = await request.server.prisma.accountGeneral.findFirst({
            where: {
              id
            }
          });

          if (!existingAccount) {
            return reply.status(404).send({
              success: false,
              message: 'Account general not found'
            });
          }

          // Update account general
          const updatedAccount = await fastify.prisma.accountGeneral.update({
            where: { id },
            data: {
              ...updateData,
              updatedBy: userId,
              updatedAt: new Date()
            }
          });

          return reply.send({
            success: true,
            message: 'Account general updated successfully',
            data: {
              ...updatedAccount,
              amountCredit: roundMoney(updatedAccount.amountCredit),
              amountDebit: roundMoney(updatedAccount.amountDebit)
            }
          });
        } catch (error) {
          request.log.error('Error updating account general:', error);
          return reply.status(500).send({
            success: false,
            message: 'Internal server error'
          });
        }
      }
    );

    /**
     * Delete Account General (Soft Delete)
     * DELETE /accounts-general/:id
     *
     * Soft deletes an account general by setting deletedAt timestamp.
     * Only accessible by Admin, Manager, and Accountant.
     */
    fastify.delete(
      '/:id',
      {
        schema: {
          tags: ['Account General'],
          summary: 'Delete account general',
          description:
            'Soft deletes an account general. Requires Admin, Manager, or Accountant role.',
          params: IdParamSchema,
          response: {
            200: zodToJsonSchema(SuccessResponseSchema(z.object({ message: z.string() })), {
              title: 'AccountGeneralDeleteResponse'
            }),
            404: zodToJsonSchema(ErrorResponseSchema, { title: 'NotFoundResponse' }),
            409: zodToJsonSchema(ErrorResponseSchema, { title: 'ConflictResponse' })
          }
        }
      },
      async (request, reply) => {
        try {
          // Params are validated by route-level Zod schema
          const { id } = request.params;

          // Check if account exists and not already deleted
          const existingAccount = await fastify.prisma.accountGeneral.findFirst({
            where: {
              id
            },
            include: {
              _count: {
                select: {
                  accountsDetail: true,
                  ledgers: true
                }
              }
            }
          });

          if (!existingAccount) {
            return reply.status(404).send({
              success: false,
              message: 'Account general not found'
            });
          }

          // Check if account has associated records
          const hasAssociatedRecords =
            existingAccount._count.accountsDetail > 0 || existingAccount._count.ledgers > 0;

          if (hasAssociatedRecords) {
            return reply.status(409).send({
              success: false,
              message: 'Cannot delete account with associated records',
              details: `Account has ${existingAccount._count.accountsDetail} detail accounts and ${existingAccount._count.ledgers} ledger entries`
            });
          }

          // Soft delete the account
          // Archive account number to free uniqueness before soft delete
          await fastify.prisma.accountGeneral.update({
            where: { id },
            data: {
              accountNumber: `${existingAccount.accountNumber}-DELETED-${nanoid(6)}`,
              deletedAt: new Date()
            }
          });

          return reply.send({
            success: true,
            message: 'Account general deleted successfully'
          });
        } catch (error) {
          request.log.error('Error deleting account general:', error);
          return reply.status(500).send({
            success: false,
            message: 'Internal server error'
          });
        }
      }
    );
  });
};
