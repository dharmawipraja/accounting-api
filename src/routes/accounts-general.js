/**
 * Account General Routes
 *
 * Routes for managing account general (chart of accounts).
 * Access restricted to Admin, Manager (MANAJER), and Accountant (AKUNTAN) roles.
 */

import { z } from 'zod';
import { cacheControl } from '../middleware/caching.js';
import { authorize } from '../middleware/index.js';
// ...existing code...
import { accountsGeneralController } from '../controllers/accountsGeneralController.js';
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
            201: SuccessResponseSchema(AccountResponseSchema),
            400: ErrorResponseSchema,
            409: ErrorResponseSchema
          }
        }
      },
      accountsGeneralController.create
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
            200: SuccessResponseSchema(z.array(AccountResponseSchema))
          }
        }
      },
      accountsGeneralController.list
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
            200: SuccessResponseSchema(AccountResponseSchema),
            404: ErrorResponseSchema
          }
        }
      },
      accountsGeneralController.getById
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
            200: SuccessResponseSchema(AccountResponseSchema),
            404: ErrorResponseSchema
          }
        }
      },
      accountsGeneralController.update
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
            200: SuccessResponseSchema(z.object({ message: z.string() })),
            404: ErrorResponseSchema,
            409: ErrorResponseSchema
          }
        }
      },
      accountsGeneralController.remove
    );
  });
};
