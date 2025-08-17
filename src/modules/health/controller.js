/**
 * Health Controller
 * HTTP request handlers for health and monitoring endpoints
 */

import AppError from '../../core/errors/AppError.js';
import { HTTP_STATUS } from '../../shared/constants/index.js';
import { createSuccessResponse } from '../../shared/utils/response.js';
import { HealthService } from './service.js';

export class HealthController {
  constructor(prisma) {
    this.healthService = new HealthService(prisma);
  }

  /**
   * Handle health check request
   * @param {Object} request - Fastify request object
   * @param {Object} reply - Fastify reply object
   */
  async getHealth(request, reply) {
    try {
      const healthStatus = await this.healthService.getHealthStatus();
      reply.status(HTTP_STATUS.OK).send(healthStatus);
    } catch (error) {
      request.log.error('Health check failed:', error);
      throw new AppError('Health check failed', 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Handle readiness check request
   * @param {Object} request - Fastify request object
   * @param {Object} reply - Fastify reply object
   */
  async getReadiness(request, reply) {
    try {
      const readinessStatus = await this.healthService.getReadinessStatus();

      if (readinessStatus.ready === false) {
        reply.status(503).send(readinessStatus);
      } else {
        reply.status(HTTP_STATUS.OK).send(readinessStatus);
      }
    } catch (error) {
      request.log.error('Readiness check failed:', error);

      // Return 503 for readiness failures (not ready)
      const notReadyResponse = {
        ready: false,
        services: {
          database: false,
          memory: true
        }
      };
      reply.status(503).send(notReadyResponse);
    }
  }

  /**
   * Handle liveness check request
   * @param {Object} request - Fastify request object
   * @param {Object} reply - Fastify reply object
   */
  async getLiveness(request, reply) {
    try {
      const livenessStatus = this.healthService.getLivenessStatus();
      reply.status(HTTP_STATUS.OK).send(livenessStatus);
    } catch (error) {
      request.log.error('Liveness check failed:', error);
      throw new AppError('Liveness check failed', 500, 'INTERNAL_ERROR');
    }
  }

  /**
   * Handle database statistics request
   * @param {Object} request - Fastify request object
   * @param {Object} reply - Fastify reply object
   */
  async getDatabaseStats(request, reply) {
    try {
      const stats = await this.healthService.getDatabaseStatistics();
      const response = createSuccessResponse(stats);
      reply.status(HTTP_STATUS.OK).send(response);
    } catch (error) {
      request.log.error('Failed to get database statistics:', error);
      throw new AppError('Failed to retrieve database statistics', 500, 'INTERNAL_ERROR');
    }
  }
}
