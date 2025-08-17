/**
 * Account General Routes
 * Route definitions for general account management
 */

import { z } from 'zod';
import { prisma } from '../../../config/database.js';
import { authenticate, requireAccountingAccess } from '../../../core/middleware/auth.js';
import { cacheControl } from '../../../core/middleware/caching.js';
import { parsePagination } from '../../../core/middleware/pagination.js';
import { CACHE_DURATION } from '../../../shared/constants/index.js';
import {
  IdParamSchema,
  PaginatedResponseSchema,
  SuccessResponseSchema
} from '../../../shared/schemas/base.js';
import { AccountGeneralController } from './controller.js';
import {
  AccountGeneralCreateSchema,
  AccountGeneralQuerySchema,
  AccountGeneralResponseSchema,
  AccountGeneralUpdateSchema
} from './schemas.js';

export async function accountGeneralRoutes(fastify) {
  const accountGeneralController = new AccountGeneralController(prisma);

  // Create general account - Admin, Manager, and Accountant only
  fastify.post(
    '/',
    {
      preHandler: [authenticate, requireAccountingAccess],
      schema: {
        description: 'Create a new general account',
        tags: ['Account General'],
        security: [{ bearerAuth: [] }],
        body: AccountGeneralCreateSchema,
        response: {
          201: SuccessResponseSchema(AccountGeneralResponseSchema)
        }
      }
    },
    accountGeneralController.createAccount.bind(accountGeneralController)
  );

  // Get all general accounts - Admin, Manager, and Accountant only
  fastify.get(
    '/',
    {
      preHandler: [
        authenticate,
        requireAccountingAccess,
        parsePagination(),
        cacheControl(CACHE_DURATION.MEDIUM, 'private')
      ],
      schema: {
        description: 'Get all general accounts with pagination and filtering',
        tags: ['Account General'],
        security: [{ bearerAuth: [] }],
        querystring: AccountGeneralQuerySchema,
        response: {
          200: PaginatedResponseSchema(AccountGeneralResponseSchema)
        }
      }
    },
    accountGeneralController.getAccounts.bind(accountGeneralController)
  );

  // Get general account by ID - Admin, Manager, and Accountant only
  fastify.get(
    '/:id',
    {
      preHandler: [
        authenticate,
        requireAccountingAccess,
        cacheControl(CACHE_DURATION.MEDIUM, 'private')
      ],
      schema: {
        description: 'Get general account by ID',
        tags: ['Account General'],
        security: [{ bearerAuth: [] }],
        params: IdParamSchema,
        querystring: z.object({
          includeDeleted: z.boolean().default(false)
        }),
        response: {
          200: SuccessResponseSchema(AccountGeneralResponseSchema)
        }
      }
    },
    accountGeneralController.getAccountById.bind(accountGeneralController)
  );

  // Update general account - Admin, Manager, and Accountant only
  fastify.put(
    '/:id',
    {
      preHandler: [authenticate, requireAccountingAccess],
      schema: {
        description: 'Update general account',
        tags: ['Account General'],
        security: [{ bearerAuth: [] }],
        params: IdParamSchema,
        body: AccountGeneralUpdateSchema,
        response: {
          200: SuccessResponseSchema(AccountGeneralResponseSchema)
        }
      }
    },
    accountGeneralController.updateAccount.bind(accountGeneralController)
  );

  // Delete general account (soft delete) - Admin, Manager, and Accountant only
  fastify.delete(
    '/:id',
    {
      preHandler: [authenticate, requireAccountingAccess],
      schema: {
        description: 'Delete general account (soft delete)',
        tags: ['Account General'],
        security: [{ bearerAuth: [] }],
        params: IdParamSchema,
        response: {
          200: SuccessResponseSchema(AccountGeneralResponseSchema)
        }
      }
    },
    accountGeneralController.deleteAccount.bind(accountGeneralController)
  );
}
