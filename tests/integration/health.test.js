/**
 * Health Module Integration Tests
 * Testing health monitoring endpoints
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIntegrationTestApp, skipIfNoDatabaseAvailable } from '../utils.js';

describe('Health Module Integration', () => {
  let app;

  beforeAll(async () => {
    // Check if database is available
    const shouldSkip = await skipIfNoDatabaseAvailable();
    if (shouldSkip) {
      app = null;
      return;
    }

    try {
      app = await createIntegrationTestApp();
    } catch (error) {
      console.warn('Failed to create test app:', error.message);
      app = null;
    }
  });

  afterAll(async () => {
    if (app && app.close) {
      await app.close();
    }
  });

  describe('GET /health', () => {
    it('should return comprehensive health status', async () => {
      if (!app) {
        console.log('⚠️  Skipping health test - app not available');
        return;
      }

      const response = await app.inject({
        method: 'GET',
        url: '/health',
        headers: {
          origin: 'http://localhost:3000' // Add origin header for CORS
        }
      });

      expect(response.statusCode).toBe(200);

      const payload = JSON.parse(response.payload);
      expect(payload).toHaveProperty('status');
      expect(payload).toHaveProperty('timestamp');
      expect(payload).toHaveProperty('uptime');
      expect(payload).toHaveProperty('version');
      expect(payload).toHaveProperty('memory');
      expect(payload).toHaveProperty('database');

      // Verify memory object structure
      expect(payload.memory).toHaveProperty('used');
      expect(payload.memory).toHaveProperty('total');
      expect(payload.memory).toHaveProperty('percentage');
      expect(typeof payload.memory.percentage).toBe('number');
      expect(payload.memory.percentage).toBeGreaterThanOrEqual(0);
      expect(payload.memory.percentage).toBeLessThanOrEqual(100);

      // Verify database object structure
      expect(payload.database).toHaveProperty('healthy');
      expect(typeof payload.database.healthy).toBe('boolean');
    });

    it('should have valid timestamp format', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
        headers: {
          origin: 'http://localhost:3000' // Add origin header for CORS
        }
      });

      const payload = JSON.parse(response.payload);
      const timestamp = new Date(payload.timestamp);

      expect(timestamp).toBeInstanceOf(Date);
      expect(timestamp.getTime()).not.toBeNaN();
    });
  });

  describe('GET /ready', () => {
    it('should return readiness status', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/ready',
        headers: {
          origin: 'http://localhost:3000' // Add origin header for CORS
        }
      });

      // Should be either 200 (ready) or 503 (not ready)
      expect([200, 503]).toContain(response.statusCode);

      const payload = JSON.parse(response.payload);

      if (response.statusCode === 200) {
        expect(payload).toHaveProperty('ready', true);
        expect(payload).toHaveProperty('services');
        expect(payload.services).toHaveProperty('database');
        expect(payload.services).toHaveProperty('memory');
      } else {
        expect(payload).toHaveProperty('ready', false);
      }
    });
  });

  describe('GET /live', () => {
    it('should return liveness status', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/live',
        headers: {
          origin: 'http://localhost:3000' // Add origin header for CORS
        }
      });

      expect(response.statusCode).toBe(200);

      const payload = JSON.parse(response.payload);
      expect(payload).toHaveProperty('status');
      expect(payload).toHaveProperty('timestamp');

      // Verify timestamp is recent (within last 5 seconds)
      const timestamp = new Date(payload.timestamp);
      const now = new Date();
      const diffInSeconds = (now - timestamp) / 1000;
      expect(diffInSeconds).toBeLessThan(5);
    });
  });

  describe('Health response schema validation', () => {
    it('should match expected health response schema', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
        headers: {
          origin: 'http://localhost:3000' // Add origin header for CORS
        }
      });

      const payload = JSON.parse(response.payload);

      // Validate required fields exist and have correct types
      expect(typeof payload.status).toBe('string');
      expect(typeof payload.timestamp).toBe('string');
      expect(typeof payload.uptime).toBe('number');
      expect(typeof payload.version).toBe('string');
      expect(typeof payload.memory).toBe('object');
      expect(typeof payload.database).toBe('object');

      // Validate memory schema
      expect(typeof payload.memory.used).toBe('number');
      expect(typeof payload.memory.total).toBe('number');
      expect(typeof payload.memory.percentage).toBe('number');

      // Validate database schema
      expect(typeof payload.database.healthy).toBe('boolean');
    });
  });
});
