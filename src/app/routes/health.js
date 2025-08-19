/**
 * Health Check Routes
 * Standardized health and readiness endpoints
 */

import container from '../../core/container/index.js';

/**
 * Setup health check routes
 * @param {express.Application} app - Express application
 */
export function setupHealthChecks(app) {
  // Health check endpoint
  app.get('/health', async (req, res) => {
    const healthData = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      environment: process.env.NODE_ENV || 'development',
      version: process.env.npm_package_version || '1.0.0'
    };

    res.json(healthData);
  });

  // Readiness check endpoint
  app.get('/ready', async (req, res) => {
    try {
      // Check if container is initialized
      if (!container.isInitialized()) {
        throw new Error('Container not initialized');
      }

      // Check database connectivity
      const prisma = container.get('prisma');
      await prisma.$queryRaw`SELECT 1`;

      const readinessData = {
        status: 'ready',
        timestamp: new Date().toISOString(),
        services: {
          database: 'connected',
          container: 'initialized'
        }
      };

      res.json(readinessData);
    } catch (error) {
      const errorData = {
        status: 'not ready',
        timestamp: new Date().toISOString(),
        error: error.message,
        services: {
          database: 'disconnected',
          container: container.isInitialized() ? 'initialized' : 'not initialized'
        }
      };

      res.status(503).json(errorData);
    }
  });

  // Liveness probe
  app.get('/live', (req, res) => {
    res.json({
      status: 'alive',
      timestamp: new Date().toISOString()
    });
  });
}
