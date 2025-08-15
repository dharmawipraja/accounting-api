/**
 * Account Detail Routes
 *
 * Routes for managing account details (sub-accounts under general accounts).
 * Access restricted to Admin, Manager (MANAJER), and Accountant (AKUNTAN) roles.
 */

import { z } from 'zod';
import { cacheControl } from '../middleware/caching.js';
import { authorize } from '../middleware/index.js';
// ...existing code...
import { accountsDetailController } from '../controllers/accountsDetailController.js';
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
      accountsDetailController.create
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
      accountsDetailController.list
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
      accountsDetailController.getById
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
      accountsDetailController.update
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
      accountsDetailController.remove
    );
  });
};
