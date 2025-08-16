/**
 * Test Setup
 * Global test configuration and utilities
 */

import { config } from 'dotenv';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';

// Load test environment variables
config({ path: '.env.test' });

// Global test setup
beforeAll(async () => {
  // Setup code that runs once before all tests
  console.log('🧪 Starting test suite...');
});

afterAll(async () => {
  // Cleanup code that runs once after all tests
  console.log('✅ Test suite completed');
});

beforeEach(async () => {
  // Setup code that runs before each test
});

afterEach(async () => {
  // Cleanup code that runs after each test
});

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
