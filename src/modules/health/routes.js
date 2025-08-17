/**
 * Health Routes
 * Route definitions for health monitoring endpoints
 */

import { z } from 'zod';
import { prisma } from '../../config/database.js';
import { HealthController } from './controller.js';
import { ComprehensiveHealthSchema, ReadinessSchema, SimpleHealthSchema } from './schemas.js';

export async function healthRoutes(fastify) {
  const healthController = new HealthController(prisma);

  // Comprehensive health check
  fastify.get(
    '/health',
    {
      schema: {
        description: 'Comprehensive health check including database and memory status',
        tags: ['Health'],
        response: {
          200: ComprehensiveHealthSchema
        }
      }
    },
    healthController.getHealth.bind(healthController)
  );

  // Readiness check for load balancers
  fastify.get(
    '/ready',
    {
      schema: {
        description: 'Readiness check for load balancers',
        tags: ['Health'],
        response: {
          200: ReadinessSchema,
          503: ReadinessSchema
        }
      }
    },
    healthController.getReadiness.bind(healthController)
  );

  // Liveness check
  fastify.get(
    '/live',
    {
      schema: {
        description: 'Liveness check for container orchestration',
        tags: ['Health'],
        response: {
          200: SimpleHealthSchema
        }
      }
    },
    healthController.getLiveness.bind(healthController)
  );

  // Database statistics (optional, for monitoring)
  fastify.get(
    '/db-stats',
    {
      schema: {
        description: 'Database statistics for monitoring',
        tags: ['Health'],
        response: {
          200: z.object({
            success: z.boolean(),
            data: z.record(z.any())
          })
        }
      }
    },
    healthController.getDatabaseStats.bind(healthController)
  );
}
