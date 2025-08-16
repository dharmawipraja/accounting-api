/**
 * Ledgers Routes
 * Route definitions for ledger management
 */

import { z } from 'zod';
import { authenticate, requireAccountingAccess } from '../../core/middleware/auth.js';
import { cacheControl } from '../../core/middleware/caching.js';
import { parsePagination } from '../../core/middleware/pagination.js';
import { sensitiveRateLimitPlugin } from '../../core/security/rateLimiting.js';
import { CACHE_DURATION } from '../../shared/constants/index.js';
import {
  ErrorResponseSchema,
  IdParamSchema,
  PaginatedResponseSchema,
  SuccessResponseSchema
} from '../../shared/schemas/base.js';
import { LedgersController } from './controller.js';
import {
  LedgerBulkCreateSchema,
  LedgerQuerySchema,
  LedgerResponseSchema,
  LedgerUpdateSchema
} from './schemas.js';

export async function ledgersRoutes(fastify) {
  const ledgersController = new LedgersController(fastify.prisma);

  // Register sensitive operations rate limiting
  await fastify.register(sensitiveRateLimitPlugin);

  // Create bulk ledger entries - Admin, Manager, and Accountant only
  fastify.post(
    '/',
    {
      preHandler: [authenticate, requireAccountingAccess],
      schema: {
        description: 'Create multiple ledger entries in a transaction',
        tags: ['Ledgers'],
        summary: 'Create bulk ledger entries',
        security: [{ bearerAuth: [] }],
        body: LedgerBulkCreateSchema,
        response: {
          201: SuccessResponseSchema(
            z.object({
              referenceNumber: z.string(),
              totalEntries: z.number(),
              ledgers: z.array(LedgerResponseSchema)
            })
          ),
          400: ErrorResponseSchema,
          429: ErrorResponseSchema
        }
      }
    },
    ledgersController.createBulkLedgers.bind(ledgersController)
  );

  // Get all ledgers - Admin, Manager, and Accountant only
  fastify.get(
    '/',
    {
      preHandler: [
        authenticate,
        requireAccountingAccess,
        parsePagination(),
        cacheControl(CACHE_DURATION.SHORT, 'private')
      ],
      schema: {
        description: 'Get all ledger entries with pagination and filtering',
        tags: ['Ledgers'],
        summary: 'Get all ledger entries',
        security: [{ bearerAuth: [] }],
        querystring: LedgerQuerySchema,
        response: {
          200: PaginatedResponseSchema(LedgerResponseSchema),
          400: ErrorResponseSchema
        }
      }
    },
    ledgersController.getLedgers.bind(ledgersController)
  );

  // Get ledger by ID - Admin, Manager, and Accountant only
  fastify.get(
    '/:id',
    {
      preHandler: [
        authenticate,
        requireAccountingAccess,
        cacheControl(CACHE_DURATION.SHORT, 'private')
      ],
      schema: {
        description: 'Get ledger entry by ID',
        tags: ['Ledgers'],
        summary: 'Get ledger by ID',
        security: [{ bearerAuth: [] }],
        params: IdParamSchema,
        response: {
          200: SuccessResponseSchema(LedgerResponseSchema),
          404: ErrorResponseSchema
        }
      }
    },
    ledgersController.getLedgerById.bind(ledgersController)
  );

  // Update ledger - Admin, Manager, and Accountant only
  fastify.put(
    '/:id',
    {
      preHandler: [authenticate, requireAccountingAccess],
      schema: {
        description: 'Update ledger entry (only pending entries)',
        tags: ['Ledgers'],
        summary: 'Update ledger entry',
        security: [{ bearerAuth: [] }],
        params: IdParamSchema,
        body: LedgerUpdateSchema,
        response: {
          200: SuccessResponseSchema(LedgerResponseSchema),
          400: ErrorResponseSchema,
          404: ErrorResponseSchema
        }
      }
    },
    ledgersController.updateLedger.bind(ledgersController)
  );

  // Delete ledger - Admin, Manager, and Accountant only
  fastify.delete(
    '/:id',
    {
      preHandler: [authenticate, requireAccountingAccess],
      schema: {
        description: 'Delete ledger entry (only pending entries)',
        tags: ['Ledgers'],
        summary: 'Delete ledger entry',
        security: [{ bearerAuth: [] }],
        params: IdParamSchema,
        response: {
          200: SuccessResponseSchema(
            z.object({
              message: z.string()
            })
          ),
          400: ErrorResponseSchema,
          404: ErrorResponseSchema
        }
      }
    },
    ledgersController.deleteLedger.bind(ledgersController)
  );
}
