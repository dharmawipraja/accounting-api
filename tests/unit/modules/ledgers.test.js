/**
 * Ledgers Module Unit Tests
 * Tests for ledger functionality
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LedgersService } from '../../../src/modules/ledgers/service.js';

describe('Ledgers Module', () => {
  let mockPrisma;
  let ledgersService;

  beforeEach(() => {
    mockPrisma = {
      ledger: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        count: vi.fn()
      },
      accountDetail: {
        findFirst: vi.fn(),
        findMany: vi.fn()
      },
      accountGeneral: {
        findFirst: vi.fn(),
        findMany: vi.fn()
      },
      $transaction: vi.fn(callback => callback(mockPrisma))
    };

    ledgersService = new LedgersService(mockPrisma);
  });

  describe('createBulkLedgers', () => {
    it('should create multiple ledger entries successfully', async () => {
      const ledgerData = {
        ledgers: [
          {
            accountDetailId: 'detail1',
            accountGeneralId: 'general1',
            amount: 1000,
            description: 'Test transaction 1',
            ledgerType: 'KAS_MASUK',
            transactionType: 'DEBIT',
            ledgerDate: '2025-08-16T00:00:00.000Z'
          },
          {
            accountDetailId: 'detail2',
            accountGeneralId: 'general2',
            amount: 1000,
            description: 'Test transaction 2',
            ledgerType: 'KAS_KELUAR',
            transactionType: 'CREDIT',
            ledgerDate: '2025-08-16T00:00:00.000Z'
          }
        ]
      };

      // Mock account validation
      mockPrisma.accountDetail.findMany.mockResolvedValueOnce([
        { id: 'detail1' },
        { id: 'detail2' }
      ]);
      mockPrisma.accountGeneral.findMany.mockResolvedValueOnce([
        { id: 'general1' },
        { id: 'general2' }
      ]);

      // Mock ledger creation
      const mockCreatedLedger = {
        id: 'ledger123',
        referenceNumber: expect.any(String),
        amount: 1000,
        description: 'Test transaction 1',
        accountDetail: { id: 'detail1', accountNumber: 'DET001' }
      };
      mockPrisma.ledger.create.mockResolvedValue(mockCreatedLedger);

      const result = await ledgersService.createBulkLedgers(ledgerData, 'user123');

      expect(mockPrisma.accountDetail.findMany).toHaveBeenCalled();
      expect(mockPrisma.accountGeneral.findMany).toHaveBeenCalled();
      expect(mockPrisma.$transaction).toHaveBeenCalled();
      expect(result).toHaveProperty('referenceNumber');
      expect(result).toHaveProperty('ledgers');
    });

    it('should throw error when account references are invalid', async () => {
      const ledgerData = {
        ledgers: [
          {
            accountDetailId: 'nonexistent',
            accountGeneralId: 'general1',
            amount: 1000,
            description: 'Test transaction',
            ledgerType: 'KAS_MASUK',
            transactionType: 'DEBIT',
            ledgerDate: '2025-08-16T00:00:00.000Z'
          }
        ]
      };

      // Mock that some accounts don't exist
      mockPrisma.accountDetail.findMany.mockResolvedValueOnce([]);
      mockPrisma.accountGeneral.findMany.mockResolvedValueOnce([{ id: 'general1' }]);

      await expect(ledgersService.createBulkLedgers(ledgerData, 'user123')).rejects.toThrow(
        'One or more detail accounts not found or inactive'
      );
    });
  });

  describe('getLedgers', () => {
    it('should return paginated ledgers with filters', async () => {
      const filters = {
        accountDetailId: 'detail1',
        ledgerType: 'KAS_MASUK',
        startDate: '2025-08-01',
        endDate: '2025-08-31',
        limit: 10,
        skip: undefined
      };

      const mockLedgers = [
        {
          id: 'ledger1',
          referenceNumber: 'REF001',
          amount: 1000,
          description: 'Test ledger 1',
          ledgerType: 'KAS_MASUK',
          accountDetail: { id: 'detail1', accountNumber: 'DET001' }
        }
      ];

      mockPrisma.ledger.findMany.mockResolvedValueOnce(mockLedgers);
      mockPrisma.ledger.count.mockResolvedValueOnce(1);

      const result = await ledgersService.getLedgers(filters);

      expect(mockPrisma.ledger.findMany).toHaveBeenCalledWith({
        where: {
          accountDetailId: 'detail1',
          ledgerType: 'KAS_MASUK',
          ledgerDate: {
            gte: new Date('2025-08-01T00:00:00.000Z'),
            lte: new Date('2025-08-31T00:00:00.000Z')
          }
        },
        include: undefined,
        orderBy: { ledgerDate: 'desc' },
        skip: undefined,
        take: 10
      });

      expect(result).toHaveProperty('ledgers');
      expect(result).toHaveProperty('total', 1);
    });
  });
});
