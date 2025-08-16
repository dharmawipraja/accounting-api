/**
 * Test Utilities
 * Common utilities for testing
 */

import { expect } from 'vitest';
import { build } from '../src/app.js';

/**
 * Create a test application instance
 */
export async function createTestApp(options = {}) {
  const app = build({
    logger: false,
    ...options
  });

  // Initialize the app instead of calling ready()
  try {
    await app.listen({ port: 0, host: '127.0.0.1' });
    return app;
  } catch (error) {
    console.error('Failed to start test app:', error);
    throw error;
  }
}

/**
 * Generate test user data
 */
export function generateTestUser(overrides = {}) {
  const defaultUser = {
    username: `testuser_${Date.now()}`,
    password: 'testpassword123',
    name: 'Test User',
    role: 'NASABAH',
    status: 'ACTIVE'
  };

  return { ...defaultUser, ...overrides };
}

/**
 * Generate test account data
 */
export function generateTestAccountGeneral(overrides = {}) {
  const defaultAccount = {
    accountNumber: `ACC${Date.now()}`,
    accountName: 'Test Account',
    accountCategory: 'ASSET',
    reportType: 'NERACA',
    transactionType: 'DEBIT'
  };

  return { ...defaultAccount, ...overrides };
}

/**
 * Generate test account detail data
 */
export function generateTestAccountDetail(accountGeneralId, overrides = {}) {
  const defaultDetail = {
    accountNumber: `DETAIL${Date.now()}`,
    accountName: 'Test Detail Account',
    accountCategory: 'ASSET',
    reportType: 'NERACA',
    transactionType: 'DEBIT',
    amountCredit: 0,
    amountDebit: 0,
    accountGeneralId
  };

  return { ...defaultDetail, ...overrides };
}

/**
 * Generate test ledger data
 */
export function generateTestLedger(accountDetailId, accountGeneralId, overrides = {}) {
  const defaultLedger = {
    amount: 100.5,
    description: 'Test ledger entry',
    accountDetailId,
    accountGeneralId,
    ledgerType: 'KAS_MASUK',
    transactionType: 'DEBIT',
    ledgerDate: new Date(),
    referenceNumber: `REF${Date.now()}`,
    postingStatus: 'UNPOSTED'
  };

  return { ...defaultLedger, ...overrides };
}

/**
 * Clean database tables (for integration tests)
 */
export async function cleanDatabase(prisma) {
  await prisma.ledger.deleteMany();
  await prisma.accountDetail.deleteMany();
  await prisma.accountGeneral.deleteMany();
  await prisma.user.deleteMany();
}

/**
 * Create test JWT token
 */
export function createTestToken(app, user) {
  return app.jwt.sign({
    userId: user.id,
    username: user.username,
    role: user.role
  });
}

/**
 * Make authenticated request
 */
export function authenticatedRequest(app, token) {
  return app.inject.bind(app, {
    headers: {
      authorization: `Bearer ${token}`
    }
  });
}

/**
 * Assert response success
 */
export function assertSuccess(response) {
  const payload = JSON.parse(response.payload);
  expect(response.statusCode).toBe(200);
  expect(payload.success).toBe(true);
  return payload;
}

/**
 * Assert response error
 */
export function assertError(response, expectedStatus = 400) {
  const payload = JSON.parse(response.payload);
  expect(response.statusCode).toBe(expectedStatus);
  expect(payload.success).toBe(false);
  return payload;
}

/**
 * Wait for a specified amount of time
 */
export function wait(ms) {
  // eslint-disable-next-line no-undef
  return new Promise(resolve => setTimeout(resolve, ms));
}
