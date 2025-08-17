/**
 * Test Setup
 * Global test configuration and utilities
 */

import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { build } from '../src/app.js';

// Load test environment variables
config({ path: '.env.test' });

// Global test variables
let globalTestApp;
let globalPrismaClient;

// Global test setup
beforeAll(async () => {
  console.log('🧪 Starting test suite...');

  // Initialize test database connection
  globalPrismaClient = new PrismaClient({
    datasources: {
      db: {
        url: process.env.DATABASE_URL
      }
    },
    log: ['error']
  });

  try {
    // Test database connection
    await globalPrismaClient.$connect();
    console.log('✅ Test database connected');
  } catch (error) {
    console.warn('⚠️  Test database connection failed:', error.message);
    console.log('ℹ️  Integration tests will be skipped');
  }
});

afterAll(async () => {
  // Cleanup global resources
  if (globalTestApp) {
    await globalTestApp.close();
  }

  if (globalPrismaClient) {
    await globalPrismaClient.$disconnect();
  }

  console.log('✅ Test suite completed');
});

beforeEach(async () => {
  // Setup code that runs before each test
});

afterEach(async () => {
  // Cleanup code that runs after each test
});

/**
 * Create a test app instance for integration tests
 */
export async function createTestApp(options = {}) {
  try {
    const app = await build({
      logger: false,
      ...options
    });

    await app.ready();
    return app;
  } catch (error) {
    console.error('Failed to create test app:', error);
    throw error;
  }
}

/**
 * Get the global Prisma client for tests
 */
export function getTestPrismaClient() {
  return globalPrismaClient;
}

/**
 * Check if database is available for integration tests
 */
export async function isDatabaseAvailable() {
  if (!globalPrismaClient) return false;

  try {
    await globalPrismaClient.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

/**
 * Clean up test data (useful for integration tests)
 */
export async function cleanupTestData() {
  if (!globalPrismaClient) return;

  try {
    // Add cleanup logic here based on your database schema
    // Example:
    // await globalPrismaClient.account.deleteMany({});
    // await globalPrismaClient.user.deleteMany({});
    console.log('🧹 Test data cleaned up');
  } catch (error) {
    console.warn('Warning: Failed to cleanup test data:', error.message);
  }
}

// Mock console methods in test environment to reduce noise
if (process.env.NODE_ENV === 'test') {
  global.console = {
    ...console,
    log: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: console.error // Keep error logs for debugging
  };
}
