/**
 * Account Detail Routes
 * Route definitions for detailed account management
 */

import { z } from 'zod';
import { authenticate, requireAccountingAccess } from '../../../core/middleware/auth.js';
import { cacheControl } from '../../../core/middleware/caching.js';
import { parsePagination } from '../../../core/middleware/pagination.js';
import { CACHE_DURATION } from '../../../shared/constants/index.js';
import {
  IdParamSchema,
  PaginatedResponseSchema,
  SuccessResponseSchema
} from '../../../shared/schemas/base.js';
import { AccountDetailController } from './controller.js';
import {
  AccountDetailCreateSchema,
  AccountDetailQuerySchema,
  AccountDetailResponseSchema,
  AccountDetailUpdateSchema
} from './schemas.js';

export async function accountDetailRoutes(fastify) {
  const accountDetailController = new AccountDetailController(fastify.prisma);

  // Create detail account - Admin, Manager, and Accountant only
  fastify.post(
    '/',
    {
      preHandler: [authenticate, requireAccountingAccess],
      schema: {
        description: 'Create a new detail account',
        tags: ['Account Detail'],
        security: [{ bearerAuth: [] }],
        body: AccountDetailCreateSchema,
        response: {
          201: SuccessResponseSchema(AccountDetailResponseSchema)
        }
      }
    },
    accountDetailController.createAccount.bind(accountDetailController)
  );

  // Get all detail accounts - Admin, Manager, and Accountant only
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
        description: 'Get all detail accounts with pagination and filtering',
        tags: ['Account Detail'],
        security: [{ bearerAuth: [] }],
        querystring: AccountDetailQuerySchema,
        response: {
          200: PaginatedResponseSchema(AccountDetailResponseSchema)
        }
      }
    },
    accountDetailController.getAccounts.bind(accountDetailController)
  );

  // Get detail account by ID - Admin, Manager, and Accountant only
  fastify.get(
    '/:id',
    {
      preHandler: [
        authenticate,
        requireAccountingAccess,
        cacheControl(CACHE_DURATION.MEDIUM, 'private')
      ],
      schema: {
        description: 'Get detail account by ID',
        tags: ['Account Detail'],
        security: [{ bearerAuth: [] }],
        params: IdParamSchema,
        querystring: z.object({
          includeDeleted: z.boolean().default(false),
          includeLedgers: z.boolean().default(false)
        }),
        response: {
          200: SuccessResponseSchema(AccountDetailResponseSchema)
        }
      }
    },
    accountDetailController.getAccountById.bind(accountDetailController)
  );

  // Update detail account - Admin, Manager, and Accountant only
  fastify.put(
    '/:id',
    {
      preHandler: [authenticate, requireAccountingAccess],
      schema: {
        description: 'Update detail account',
        tags: ['Account Detail'],
        security: [{ bearerAuth: [] }],
        params: IdParamSchema,
        body: AccountDetailUpdateSchema,
        response: {
          200: SuccessResponseSchema(AccountDetailResponseSchema)
        }
      }
    },
    accountDetailController.updateAccount.bind(accountDetailController)
  );

  // Delete detail account (soft delete) - Admin, Manager, and Accountant only
  fastify.delete(
    '/:id',
    {
      preHandler: [authenticate, requireAccountingAccess],
      schema: {
        description: 'Delete detail account (soft delete)',
        tags: ['Account Detail'],
        security: [{ bearerAuth: [] }],
        params: IdParamSchema,
        response: {
          200: SuccessResponseSchema(AccountDetailResponseSchema)
        }
      }
    },
    accountDetailController.deleteAccount.bind(accountDetailController)
  );
}
