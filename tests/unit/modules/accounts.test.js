/**
 * Accounts Module Unit Tests
 * Tests for account detail and general functionality
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountDetailService } from '../../../src/modules/accounts/detail/service.js';
import { AccountGeneralService } from '../../../src/modules/accounts/general/service.js';

describe('Accounts Module', () => {
  let mockPrisma;
  let accountDetailService;
  let accountGeneralService;

  beforeEach(() => {
    mockPrisma = {
      accountDetail: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        count: vi.fn()
      },
      accountGeneral: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        count: vi.fn()
      },
      $transaction: vi.fn(callback => callback(mockPrisma))
    };

    accountDetailService = new AccountDetailService(mockPrisma);
    accountGeneralService = new AccountGeneralService(mockPrisma);
  });

  describe('AccountDetailService', () => {
    describe('createAccount', () => {
      it('should create a detail account successfully', async () => {
        const accountData = {
          accountNumber: 'DET001',
          accountName: 'Test Detail Account',
          accountGeneralId: 'gen123',
          accountCategory: 'ASSET',
          transactionType: 'DEBIT',
          reportType: 'NERACA',
          amountCredit: 0,
          amountDebit: 1000
        };

        // Mock that account number doesn't exist
        mockPrisma.accountDetail.findFirst.mockResolvedValueOnce(null);

        // Mock that general account exists
        mockPrisma.accountGeneral.findFirst.mockResolvedValueOnce({
          id: 'gen123',
          accountName: 'Test General'
        });

        // Mock account creation
        const mockCreatedAccount = {
          id: 'detail123',
          ...accountData,
          accountType: 'DETAIL', // Service adds this automatically
          createdAt: new Date(),
          updatedAt: new Date()
        };
        mockPrisma.accountDetail.create.mockResolvedValueOnce(mockCreatedAccount);

        const result = await accountDetailService.createAccount(accountData, 'user123');

        expect(mockPrisma.accountDetail.findFirst).toHaveBeenCalledWith({
          where: {
            accountNumber: 'DET001',
            deletedAt: null
          }
        });
        expect(mockPrisma.accountGeneral.findFirst).toHaveBeenCalledWith({
          where: {
            id: 'gen123',
            deletedAt: null
          }
        });
        expect(mockPrisma.accountDetail.create).toHaveBeenCalled();
        expect(result).toEqual(mockCreatedAccount);
      });

      it('should throw error when account number already exists', async () => {
        const accountData = {
          accountNumber: 'DET001',
          accountName: 'Test Detail Account',
          accountGeneralId: 'gen123'
        };

        // Mock that account number exists
        mockPrisma.accountDetail.findFirst.mockResolvedValueOnce({
          id: 'existing123',
          accountNumber: 'DET001'
        });

        await expect(accountDetailService.createAccount(accountData, 'user123')).rejects.toThrow(
          'Account number already exists'
        );
      });

      it('should throw error when general account not found', async () => {
        const accountData = {
          accountNumber: 'DET001',
          accountName: 'Test Detail Account',
          accountGeneralId: 'nonexistent'
        };

        // Mock that account number doesn't exist
        mockPrisma.accountDetail.findFirst.mockResolvedValueOnce(null);

        // Mock that general account doesn't exist
        mockPrisma.accountGeneral.findFirst.mockResolvedValueOnce(null);

        await expect(accountDetailService.createAccount(accountData, 'user123')).rejects.toThrow(
          'General account not found'
        );
      });
    });

    describe('getAccounts', () => {
      it('should return paginated accounts with filters', async () => {
        const filters = {
          accountCategory: 'ASSET',
          limit: 10,
          skip: undefined // Service handles pagination differently
        };

        const mockAccounts = [
          {
            id: 'detail1',
            accountNumber: 'DET001',
            accountName: 'Test Account 1',
            accountCategory: 'ASSET'
          },
          {
            id: 'detail2',
            accountNumber: 'DET002',
            accountName: 'Test Account 2',
            accountCategory: 'ASSET'
          }
        ];

        mockPrisma.accountDetail.findMany.mockResolvedValueOnce(mockAccounts);
        mockPrisma.accountDetail.count.mockResolvedValueOnce(2);

        const result = await accountDetailService.getAccounts(filters);

        expect(mockPrisma.accountDetail.findMany).toHaveBeenCalledWith({
          where: {
            accountCategory: 'ASSET',
            deletedAt: null
          },
          include: {
            accountGeneral: {
              select: {
                id: true,
                accountNumber: true,
                accountName: true
              }
            }
          },
          orderBy: { accountNumber: 'asc' },
          skip: undefined,
          take: 10
        });

        expect(result).toHaveProperty('accounts');
        expect(result).toHaveProperty('total', 2);
      });
    });
  });

  describe('AccountGeneralService', () => {
    describe('createAccount', () => {
      it('should create a general account successfully', async () => {
        const accountData = {
          accountNumber: 'GEN001',
          accountName: 'Test General Account',
          accountCategory: 'ASSET',
          transactionType: 'DEBIT',
          reportType: 'NERACA',
          amountCredit: 0,
          amountDebit: 5000
        };

        // Mock that account number doesn't exist
        mockPrisma.accountGeneral.findFirst.mockResolvedValueOnce(null);

        // Mock account creation
        const mockCreatedAccount = {
          id: 'general123',
          ...accountData,
          accountType: 'GENERAL', // Service adds this automatically
          createdAt: new Date(),
          updatedAt: new Date()
        };
        mockPrisma.accountGeneral.create.mockResolvedValueOnce(mockCreatedAccount);

        const result = await accountGeneralService.createAccount(accountData, 'user123');

        expect(mockPrisma.accountGeneral.findFirst).toHaveBeenCalledWith({
          where: {
            accountNumber: 'GEN001',
            deletedAt: null
          }
        });
        expect(mockPrisma.accountGeneral.create).toHaveBeenCalled();
        expect(result).toEqual(mockCreatedAccount);
      });

      it('should throw error when account number already exists', async () => {
        const accountData = {
          accountNumber: 'GEN001',
          accountName: 'Test General Account'
        };

        // Mock that account number exists
        mockPrisma.accountGeneral.findFirst.mockResolvedValueOnce({
          id: 'existing123',
          accountNumber: 'GEN001'
        });

        await expect(accountGeneralService.createAccount(accountData, 'user123')).rejects.toThrow(
          'Account number already exists'
        );
      });
    });
  });
});
