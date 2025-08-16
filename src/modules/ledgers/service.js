/**
 * Ledgers Service
 * Business logic for ledger operations
 */

import { ulid } from 'ulid';
import { buildDateRangeFilter, formatMoneyForDb } from '../../core/database/utils.js';

export class LedgersService {
  constructor(prisma) {
    this.prisma = prisma;
  }

  /**
   * Create multiple ledger entries in a transaction
   * @param {Object} ledgerData - Bulk ledger data
   * @param {string} createdBy - ID of user creating these ledgers
   * @returns {Promise<Object>} Created ledgers with reference number
   */
  async createBulkLedgers(ledgerData, createdBy) {
    const { ledgers } = ledgerData;

    // Generate a unique reference number for this batch
    const referenceNumber = this.generateReferenceNumber();

    // Validate all account references exist
    await this.validateAccountReferences(ledgers);

    // Format ledger data for database
    const formattedLedgers = ledgers.map(ledger => ({
      id: ulid(),
      ...ledger,
      referenceNumber,
      amount: formatMoneyForDb(ledger.amount),
      postingStatus: 'PENDING',
      createdBy,
      updatedBy: createdBy,
      createdAt: new Date(),
      updatedAt: new Date()
    }));

    // Create all ledgers in a transaction
    const createdLedgers = await this.prisma.$transaction(async prisma => {
      const results = [];
      for (const ledgerData of formattedLedgers) {
        const ledger = await prisma.ledger.create({
          data: ledgerData,
          include: {
            accountDetail: {
              select: { id: true, accountNumber: true, accountName: true }
            },
            accountGeneral: {
              select: { id: true, accountNumber: true, accountName: true }
            }
          }
        });
        results.push(ledger);
      }
      return results;
    });

    return {
      referenceNumber,
      totalEntries: createdLedgers.length,
      ledgers: createdLedgers.map(ledger => this.formatLedgerResponse(ledger))
    };
  }

  /**
   * Get ledgers with pagination and filtering
   * @param {Object} options - Query options
   * @returns {Promise<Object>} Ledgers and pagination info
   */
  async getLedgers({
    limit,
    skip,
    search,
    referenceNumber,
    ledgerType,
    transactionType,
    postingStatus,
    accountDetailId,
    accountGeneralId,
    startDate,
    endDate,
    includeAccounts = false
  }) {
    // Build where clause
    const where = {
      ...(search && {
        OR: [
          { referenceNumber: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } }
        ]
      }),
      ...(referenceNumber && { referenceNumber }),
      ...(ledgerType && { ledgerType }),
      ...(transactionType && { transactionType }),
      ...(postingStatus && { postingStatus }),
      ...(accountDetailId && { accountDetailId }),
      ...(accountGeneralId && { accountGeneralId }),
      ...buildDateRangeFilter(startDate, endDate, 'ledgerDate')
    };

    // Build include clause
    const include = includeAccounts
      ? {
          accountDetail: {
            select: { id: true, accountNumber: true, accountName: true }
          },
          accountGeneral: {
            select: { id: true, accountNumber: true, accountName: true }
          }
        }
      : undefined;

    // Execute queries in parallel
    const [ledgers, total] = await Promise.all([
      this.prisma.ledger.findMany({
        where,
        include,
        skip,
        take: limit,
        orderBy: { ledgerDate: 'desc' }
      }),
      this.prisma.ledger.count({ where })
    ]);

    return {
      ledgers: ledgers.map(ledger => this.formatLedgerResponse(ledger)),
      total
    };
  }

  /**
   * Get ledger by ID
   * @param {string} ledgerId - Ledger ID
   * @returns {Promise<Object|null>} Ledger data or null
   */
  async getLedgerById(ledgerId) {
    const ledger = await this.prisma.ledger.findUnique({
      where: { id: ledgerId },
      include: {
        accountDetail: {
          select: { id: true, accountNumber: true, accountName: true }
        },
        accountGeneral: {
          select: { id: true, accountNumber: true, accountName: true }
        }
      }
    });

    return ledger ? this.formatLedgerResponse(ledger) : null;
  }

  /**
   * Update ledger
   * @param {string} ledgerId - Ledger ID
   * @param {Object} updateData - Data to update
   * @param {string} updatedBy - ID of user making the update
   * @returns {Promise<Object>} Updated ledger
   */
  async updateLedger(ledgerId, updateData, updatedBy) {
    // Check if ledger exists
    const existingLedger = await this.prisma.ledger.findUnique({
      where: { id: ledgerId }
    });

    if (!existingLedger) {
      throw new Error('Ledger not found');
    }

    // Don't allow updates to posted ledgers
    if (existingLedger.postingStatus === 'POSTED') {
      throw new Error('Cannot update posted ledger entries');
    }

    // Format monetary amounts if provided
    const formattedData = {
      ...updateData
    };

    if (updateData.amount !== undefined) {
      formattedData.amount = formatMoneyForDb(updateData.amount);
    }

    // Set posting timestamp if status is being changed to POSTED
    if (updateData.postingStatus === 'POSTED' && existingLedger.postingStatus !== 'POSTED') {
      formattedData.postingAt = new Date();
    }

    const updatedLedger = await this.prisma.ledger.update({
      where: { id: ledgerId },
      data: {
        ...formattedData,
        updatedBy,
        updatedAt: new Date()
      },
      include: {
        accountDetail: {
          select: { id: true, accountNumber: true, accountName: true }
        },
        accountGeneral: {
          select: { id: true, accountNumber: true, accountName: true }
        }
      }
    });

    return this.formatLedgerResponse(updatedLedger);
  }

  /**
   * Delete ledger (soft delete or hard delete based on posting status)
   * @param {string} ledgerId - Ledger ID
   * @param {string} _deletedBy - ID of user performing deletion (unused but kept for API consistency)
   * @returns {Promise<Object>} Result of deletion
   */
  async deleteLedger(ledgerId, _deletedBy) {
    // Check if ledger exists
    const existingLedger = await this.prisma.ledger.findUnique({
      where: { id: ledgerId }
    });

    if (!existingLedger) {
      throw new Error('Ledger not found');
    }

    // Don't allow deletion of posted ledgers
    if (existingLedger.postingStatus === 'POSTED') {
      throw new Error('Cannot delete posted ledger entries');
    }

    // Hard delete pending ledgers (they haven't affected balances yet)
    await this.prisma.ledger.delete({
      where: { id: ledgerId }
    });

    return { message: 'Ledger entry deleted successfully' };
  }

  /**
   * Validate that all account references exist and are active
   * @param {Array} ledgers - Array of ledger data
   * @private
   */
  async validateAccountReferences(ledgers) {
    const accountDetailIds = [...new Set(ledgers.map(l => l.accountDetailId))];
    const accountGeneralIds = [...new Set(ledgers.map(l => l.accountGeneralId))];

    // Check detail accounts
    const detailAccounts = await this.prisma.accountDetail.findMany({
      where: {
        id: { in: accountDetailIds },
        deletedAt: null
      },
      select: { id: true }
    });

    if (detailAccounts.length !== accountDetailIds.length) {
      throw new Error('One or more detail accounts not found or inactive');
    }

    // Check general accounts
    const generalAccounts = await this.prisma.accountGeneral.findMany({
      where: {
        id: { in: accountGeneralIds },
        deletedAt: null
      },
      select: { id: true }
    });

    if (generalAccounts.length !== accountGeneralIds.length) {
      throw new Error('One or more general accounts not found or inactive');
    }
  }

  /**
   * Generate a unique reference number
   * @returns {string} Reference number
   * @private
   */
  generateReferenceNumber() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const timestamp = now.getTime().toString().slice(-6); // Last 6 digits

    return `REF${year}${month}${day}${timestamp}`;
  }

  /**
   * Format ledger response to ensure consistent number formatting
   * @param {Object} ledger - Raw ledger data from database
   * @returns {Object} Formatted ledger data
   */
  formatLedgerResponse(ledger) {
    return {
      ...ledger,
      amount: parseFloat(ledger.amount) || 0
    };
  }
}
