/**
 * Health Routes
 * Route definitions for health monitoring endpoints
 */

import { z } from 'zod';
import { HealthController } from './controller.js';

export async function healthRoutes(fastify) {
  const healthController = new HealthController(fastify.prisma);

  // Comprehensive health check
  fastify.get(
    '/health',
    {
      schema: {
        description: 'Comprehensive health check including database and memory status',
        tags: ['Health'],
        response: {
          200: z.object({
            status: z.string(),
            timestamp: z.string(),
            uptime: z.number(),
            version: z.string(),
            memory: z.object({
              used: z.number(),
              total: z.number(),
              percentage: z.number()
            }),
            database: z.object({
              healthy: z.boolean(),
              version: z.string().optional(),
              connections: z.number().optional(),
              tableCount: z.number().optional()
            })
          })
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
          200: z.object({
            status: z.string(),
            timestamp: z.string(),
            checks: z.object({
              database: z.string()
            })
          }),
          503: z.object({
            error: z.string(),
            timestamp: z.string()
          })
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
          200: z.object({
            status: z.string(),
            timestamp: z.string(),
            pid: z.number()
          })
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
