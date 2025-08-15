/**
 * Ledger Routes
 *
 * Routes for managing ledger entries (journal entries).
 * Access restricted to Admin, Manager (MANAJER), and Accountant (AKUNTAN) roles.
 */

import { z } from 'zod';
import { cacheControl } from '../middleware/caching.js';
import { authorize } from '../middleware/index.js';
// ...existing code...
import {
  ErrorResponseSchema,
  IdParamSchema,
  LedgerBulkCreateSchema,
  LedgerQuerySchema,
  LedgerResponseSchema,
  LedgerUpdateSchema,
  SuccessResponseSchema
} from '../schemas/index.js';

import { ledgersController } from '../controllers/ledgersController.js';

/**
 * Authorization middleware for ledger operations
 * Only Admin, Manager, and Accountant can manage ledgers
 */
const requireLedgerAccess = authorize('ADMIN', 'MANAJER', 'AKUNTAN');

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
          201: SuccessResponseSchema(
            z.object({
              referenceNumber: z.string(),
              totalEntries: z.number(),
              ledgers: z.array(LedgerResponseSchema)
            })
          ),
          400: ErrorResponseSchema
        }
      }
    },
    ledgersController.createBulk
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
          200: SuccessResponseSchema(z.array(LedgerResponseSchema))
        }
      }
    },
    ledgersController.list
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
          200: SuccessResponseSchema(LedgerResponseSchema),
          404: ErrorResponseSchema
        }
      }
    },
    ledgersController.getById
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
          200: SuccessResponseSchema(LedgerResponseSchema)
        }
      }
    },
    ledgersController.update
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
          200: SuccessResponseSchema(z.object({ message: z.string() }))
        }
      }
    },
    ledgersController.remove
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
          200: SuccessResponseSchema(
            z.object({ id: z.string(), postingStatus: z.string(), postingAt: z.string() })
          )
        }
      }
    },
    ledgersController.post
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
        params: IdParamSchema,
        response: {
          200: SuccessResponseSchema(
            z.object({
              id: z.string(),
              postingStatus: z.string(),
              postingAt: z.string().nullable()
            })
          )
        }
      }
    },
    ledgersController.unpost
  );
};
