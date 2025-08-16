/**
 * Health Check Service
 * Business logic for health monitoring and system status
 */

import { checkDatabaseHealth, getDatabaseStats } from '../../core/database/utils.js';

export class HealthService {
  constructor(prisma) {
    this.prisma = prisma;
  }

  /**
   * Get comprehensive health status
   * @returns {Promise<Object>} Health status information
   */
  async getHealthStatus() {
    const memUsage = process.memoryUsage();
    const memTotal = memUsage.heapTotal;
    const memUsed = memUsage.heapUsed;

    // Get database info
    let dbInfo = { healthy: false };

    try {
      const dbHealth = await checkDatabaseHealth(this.prisma);
      dbInfo = { healthy: dbHealth.healthy };

      if (dbHealth.healthy) {
        try {
          const dbStats = await getDatabaseStats();
          dbInfo = {
            healthy: true,
            version: 'PostgreSQL',
            connections: dbStats.database.activeConnections,
            tableCount: dbStats.tables.total
          };
        } catch (error) {
          // Log warning but don't fail health check
          console.warn('Could not fetch database stats for health check:', error.message);
        }
      }
    } catch (error) {
      console.error('Database health check failed:', error.message);
      dbInfo = { healthy: false, error: 'Database unavailable' };
    }

    return {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: process.env.npm_package_version || '1.0.0',
      memory: {
        used: Math.round((memUsed / 1024 / 1024) * 100) / 100, // MB
        total: Math.round((memTotal / 1024 / 1024) * 100) / 100, // MB
        percentage: Math.round((memUsed / memTotal) * 10000) / 100
      },
      database: dbInfo
    };
  }

  /**
   * Get readiness status (for load balancers)
   * @returns {Promise<Object>} Readiness status
   */
  async getReadinessStatus() {
    const dbHealth = await checkDatabaseHealth(this.prisma);

    if (!dbHealth.healthy) {
      throw new Error('Database unavailable');
    }

    return {
      status: 'ready',
      timestamp: new Date().toISOString(),
      checks: {
        database: 'healthy'
      }
    };
  }

  /**
   * Get liveness status
   * @returns {Object} Liveness status
   */
  getLivenessStatus() {
    return {
      status: 'alive',
      timestamp: new Date().toISOString(),
      pid: process.pid
    };
  }

  /**
   * Get database statistics
   * @returns {Promise<Object>} Database statistics
   */
  async getDatabaseStatistics() {
    return getDatabaseStats();
  }
}
