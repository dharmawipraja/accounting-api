/**
 * Test Fixtures
 * Pre-defined test data for consistent testing
 */

export const validUser = {
  username: 'testuser123',
  password: 'password123',
  name: 'Test User',
  role: 'NASABAH'
};

export const validUserUpdate = {
  name: 'Updated Test User',
  role: 'KASIR'
};

export const invalidUser = {
  username: 'ab', // Too short
  password: '123', // Too short
  name: 'T', // Too short
  role: 'INVALID_ROLE'
};

export const validAccountGeneral = {
  accountNumber: 'ACC001',
  accountName: 'Test General Account',
  accountCategory: 'ASSET',
  reportType: 'NERACA',
  transactionType: 'DEBIT'
};

export const validAccountDetail = {
  accountNumber: 'DETAIL001',
  accountName: 'Test Detail Account',
  accountCategory: 'ASSET',
  reportType: 'NERACA',
  transactionType: 'DEBIT',
  amountCredit: 0,
  amountDebit: 1000.5
};

export const validLedgerEntry = {
  amount: 500.75,
  description: 'Test ledger entry for validation',
  ledgerType: 'KAS_MASUK',
  transactionType: 'DEBIT',
  ledgerDate: new Date('2025-01-15'),
  referenceNumber: 'REF001'
};

export const validBulkLedgers = [
  {
    amount: 100.0,
    description: 'Bulk entry 1',
    ledgerType: 'KAS_MASUK',
    transactionType: 'DEBIT',
    ledgerDate: new Date('2025-01-15')
  },
  {
    amount: 200.0,
    description: 'Bulk entry 2',
    ledgerType: 'KAS_KELUAR',
    transactionType: 'CREDIT',
    ledgerDate: new Date('2025-01-16')
  }
];

export const validLoginCredentials = {
  username: 'testuser123',
  password: 'password123'
};

export const invalidLoginCredentials = {
  username: 'wronguser',
  password: 'wrongpassword'
};

export const validPasswordChange = {
  currentPassword: 'password123',
  newPassword: 'newpassword123',
  confirmPassword: 'newpassword123'
};

export const invalidPasswordChange = {
  currentPassword: 'wrongpassword',
  newPassword: 'new123',
  confirmPassword: 'different123'
};

export const validPaginationQuery = {
  limit: 10,
  skip: 0,
  page: 1
};

export const validSearchQuery = {
  search: 'test',
  limit: 5
};

export const validFilterQuery = {
  filters: [
    {
      field: 'status',
      operator: 'eq',
      value: 'ACTIVE'
    }
  ],
  sort: [
    {
      field: 'createdAt',
      direction: 'desc'
    }
  ]
};
