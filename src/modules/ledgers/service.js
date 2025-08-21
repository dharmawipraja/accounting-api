/**
 * Ledgers Service
 * Business logic for ledger operations
 */

import { buildDateRangeFilter, formatMoneyForDb } from '../../core/database/utils.js';
import { generateId } from '../../shared/utils/id.js';

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

    // Validate all account references exist and get ID mappings
    await this.validateAccountReferences(ledgers);

    // Format ledger data for database
    const formattedLedgers = ledgers.map(ledger => ({
      id: generateId(),
      ...ledger,
      referenceNumber,
      amount: formatMoneyForDb(ledger.amount),
      ledgerDate: new Date(ledger.ledgerDate),
      postingStatus: 'PENDING',
      createdBy,
      updatedBy: createdBy,
      createdAt: new Date(),
      updatedAt: new Date()
    }));

    // Create all ledgers in a transaction
    const createdLedgers = await this.prisma.$transaction(async _prisma => {
      const results = [];
      for (const ledgerData of formattedLedgers) {
        const ledger = await this.prisma.ledger.create({
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
      ...(accountDetailId && { accountDetailAccountNumber: accountDetailId }),
      ...(accountGeneralId && { accountGeneralAccountNumber: accountGeneralId }),
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
   * Get all ledgers for a specific date with totals
   * @param {string} ledgerDate - Date string in format dd-mm-yy
   * @returns {Promise<Object>} Ledgers with totals for the specified date
   */
  async getLedgersByDate(ledgerDate) {
    // Get start and end of the target date for query
    const startOfDay = new Date(ledgerDate);
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date(ledgerDate);
    endOfDay.setHours(23, 59, 59, 999);

    // Find all ledgers for the specified date
    const ledgers = await this.prisma.ledger.findMany({
      where: {
        ledgerDate: {
          gte: startOfDay,
          lte: endOfDay
        },
        deletedAt: null
      },
      include: {
        accountDetail: {
          select: {
            id: true,
            accountNumber: true,
            accountName: true,
            accountCategory: true,
            reportType: true,
            transactionType: true
          }
        },
        accountGeneral: {
          select: {
            id: true,
            accountNumber: true,
            accountName: true,
            accountCategory: true,
            reportType: true,
            transactionType: true
          }
        }
      },
      orderBy: [{ createdAt: 'desc' }, { referenceNumber: 'asc' }]
    });

    if (ledgers.length === 0) {
      throw new Error('No ledgers found for the specified date');
    }

    // Calculate totals
    let totalAmountCredit = 0;
    let totalAmountDebit = 0;

    for (const ledger of ledgers) {
      const amount = parseFloat(ledger.amount) || 0;
      if (ledger.transactionType === 'CREDIT') {
        totalAmountCredit += amount;
      } else if (ledger.transactionType === 'DEBIT') {
        totalAmountDebit += amount;
      }
    }

    // Format ledgers response
    const formattedLedgers = ledgers.map(ledger => this.formatLedgerResponse(ledger));

    return {
      ledgerDate,
      totalEntries: ledgers.length,
      totalAmountCredit: parseFloat(totalAmountCredit.toFixed(2)),
      totalAmountDebit: parseFloat(totalAmountDebit.toFixed(2)),
      ledgers: formattedLedgers
    };
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
   * Post all pending ledgers for a specific date
   * @param {string} ledgerDate - Date string in format dd-mm-yyyy
   * @param {string} postedBy - ID of user posting the ledgers
   * @returns {Promise<Object>} Result of posting operation
   */
  async postLedgersByDate(ledgerDate, postedBy) {
    // Get start and end of the target date for query
    const startOfDay = new Date(ledgerDate);
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date(ledgerDate);
    endOfDay.setHours(23, 59, 59, 999);

    // Find all pending ledgers for the specified date
    const pendingLedgers = await this.prisma.ledger.findMany({
      where: {
        ledgerDate: {
          gte: startOfDay,
          lte: endOfDay
        },
        postingStatus: 'PENDING',
        deletedAt: null
      },
      include: {
        accountDetail: {
          select: {
            id: true,
            accountNumber: true,
            accountName: true,
            accountCategory: true,
            reportType: true,
            transactionType: true
          }
        },
        accountGeneral: {
          select: {
            id: true,
            accountNumber: true,
            accountName: true,
            accountCategory: true,
            reportType: true,
            transactionType: true
          }
        }
      }
    });

    if (pendingLedgers.length === 0) {
      throw new Error('No pending ledgers found for the specified date');
    }

    // Update all pending ledgers to POSTED status in a transaction
    const result = await this.prisma.$transaction(async prisma => {
      const postingTimestamp = new Date();

      // Update all pending ledgers for the date
      const updateResult = await prisma.ledger.updateMany({
        where: {
          ledgerDate: {
            gte: startOfDay,
            lte: endOfDay
          },
          postingStatus: 'PENDING',
          deletedAt: null
        },
        data: {
          postingStatus: 'POSTED',
          postingAt: postingTimestamp,
          updatedBy: postedBy,
          updatedAt: postingTimestamp
        }
      });

      // Create journal ledger entries for each posted ledger
      const journalEntries = pendingLedgers.map(ledger => ({
        id: generateId(),
        referenceNumber: ledger.referenceNumber,
        accountDetailAccountNumber: ledger.accountDetailAccountNumber,
        accountGeneralAccountNumber: ledger.accountGeneralAccountNumber,
        transactionType: ledger.transactionType,
        amount: ledger.amount,
        reportType: ledger.accountDetail.reportType,
        ledgerDate: ledger.ledgerDate,
        createdAt: postingTimestamp,
        createdBy: postedBy
      }));

      // Insert journal entries
      await prisma.journalLedger.createMany({
        data: journalEntries
      });

      // Update account balances
      await this.updateAccountBalances(prisma, pendingLedgers, postedBy);

      return {
        postedCount: updateResult.count,
        ledgers: pendingLedgers.map(ledger => this.formatLedgerResponse(ledger)),
        journalEntriesCreated: journalEntries.length,
        postingTimestamp
      };
    });

    return {
      message: `Successfully posted ${result.postedCount} ledger entries for ${ledgerDate}`,
      data: result
    };
  }

  /**
   * Unpost all posted ledgers for a specific date
   * @param {string} ledgerDate - Date string in ISO format
   * @param {string} unpostedBy - ID of user unposting the ledgers
   * @returns {Promise<Object>} Result of unposting operation
   */
  async unpostLedgersByDate(ledgerDate, unpostedBy) {
    // Get start and end of the target date for query
    const startOfDay = new Date(ledgerDate);
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date(ledgerDate);
    endOfDay.setHours(23, 59, 59, 999);

    // Find all posted ledgers for the specified date
    const postedLedgers = await this.prisma.ledger.findMany({
      where: {
        ledgerDate: {
          gte: startOfDay,
          lte: endOfDay
        },
        postingStatus: 'POSTED',
        deletedAt: null
      },
      include: {
        accountDetail: {
          select: {
            id: true,
            accountNumber: true,
            accountName: true,
            accountCategory: true,
            reportType: true,
            transactionType: true
          }
        },
        accountGeneral: {
          select: {
            id: true,
            accountNumber: true,
            accountName: true,
            accountCategory: true,
            reportType: true,
            transactionType: true
          }
        }
      }
    });

    if (postedLedgers.length === 0) {
      throw new Error('No posted ledgers found for the specified date');
    }

    // Unpost all posted ledgers for the date in a transaction
    const result = await this.prisma.$transaction(async prisma => {
      const unpostingTimestamp = new Date();

      // Update all posted ledgers to PENDING status
      const updateResult = await prisma.ledger.updateMany({
        where: {
          ledgerDate: {
            gte: startOfDay,
            lte: endOfDay
          },
          postingStatus: 'POSTED',
          deletedAt: null
        },
        data: {
          postingStatus: 'PENDING',
          postingAt: null,
          updatedBy: unpostedBy,
          updatedAt: unpostingTimestamp
        }
      });

      // Delete related journal ledger entries for the date
      const deleteJournalResult = await prisma.journalLedger.deleteMany({
        where: {
          ledgerDate: {
            gte: startOfDay,
            lte: endOfDay
          }
        }
      });

      // Revert account balance changes
      await this.revertAccountBalances(prisma, postedLedgers, unpostedBy);

      return {
        unpostedCount: updateResult.count,
        ledgers: postedLedgers.map(ledger => this.formatLedgerResponse(ledger)),
        journalEntriesDeleted: deleteJournalResult.count,
        unpostingTimestamp
      };
    });

    return {
      message: `Successfully unposted ${result.unpostedCount} ledger entries for ${ledgerDate}`,
      data: result
    };
  }

  /**
   * Validate that all account references exist and are active
   * @param {Array} ledgers - Array of ledger data
   * @returns {void} Throws error if accounts don't exist
   * @private
   */
  async validateAccountReferences(ledgers) {
    const accountDetailNumbers = [...new Set(ledgers.map(l => l.accountDetailId))];
    const accountGeneralNumbers = [...new Set(ledgers.map(l => l.accountGeneralId))];

    // Check detail accounts
    const detailAccounts = await this.prisma.accountDetail.findMany({
      where: {
        accountNumber: { in: accountDetailNumbers },
        deletedAt: null
      },
      select: { id: true, accountNumber: true }
    });

    if (detailAccounts.length !== accountDetailNumbers.length) {
      const foundNumbers = detailAccounts.map(acc => acc.accountNumber);
      const missingNumbers = accountDetailNumbers.filter(num => !foundNumbers.includes(num));
      throw new Error(`Detail account(s) not found: ${missingNumbers.join(', ')}`);
    }

    // Check general accounts
    const generalAccounts = await this.prisma.accountGeneral.findMany({
      where: {
        accountNumber: { in: accountGeneralNumbers },
        deletedAt: null
      },
      select: { id: true, accountNumber: true }
    });

    if (generalAccounts.length !== accountGeneralNumbers.length) {
      const foundNumbers = generalAccounts.map(acc => acc.accountNumber);
      const missingNumbers = accountGeneralNumbers.filter(num => !foundNumbers.includes(num));
      throw new Error(`General account(s) not found: ${missingNumbers.join(', ')}`);
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
   * Update account balances after posting ledgers
   * @param {Object} prisma - Prisma transaction client
   * @param {Array} ledgers - Array of ledger entries
   * @param {string} updatedBy - ID of user updating balances
   * @returns {Promise<void>}
   * @private
   */
  async updateAccountBalances(prisma, ledgers, updatedBy) {
    const updateTimestamp = new Date();

    // Group ledgers by account for batch updates
    const accountUpdates = new Map();

    for (const ledger of ledgers) {
      // Update detail account
      const detailKey = ledger.accountDetailAccountNumber;
      if (!accountUpdates.has(detailKey)) {
        accountUpdates.set(detailKey, {
          type: 'detail',
          creditAmount: 0,
          debitAmount: 0
        });
      }

      const detailUpdate = accountUpdates.get(detailKey);
      if (ledger.transactionType === 'CREDIT') {
        detailUpdate.creditAmount += parseFloat(ledger.amount);
      } else {
        detailUpdate.debitAmount += parseFloat(ledger.amount);
      }

      // Update general account
      const generalKey = ledger.accountGeneralAccountNumber;
      if (!accountUpdates.has(generalKey)) {
        accountUpdates.set(generalKey, {
          type: 'general',
          creditAmount: 0,
          debitAmount: 0
        });
      }

      const generalUpdate = accountUpdates.get(generalKey);
      if (ledger.transactionType === 'CREDIT') {
        generalUpdate.creditAmount += parseFloat(ledger.amount);
      } else {
        generalUpdate.debitAmount += parseFloat(ledger.amount);
      }
    }

    // Apply updates to accounts
    for (const [accountNumber, update] of accountUpdates) {
      if (update.type === 'detail') {
        await prisma.accountDetail.update({
          where: { accountNumber },
          data: {
            amountCredit: {
              increment: formatMoneyForDb(update.creditAmount)
            },
            amountDebit: {
              increment: formatMoneyForDb(update.debitAmount)
            },
            accumulationAmountCredit: {
              increment: formatMoneyForDb(update.creditAmount)
            },
            accumulationAmountDebit: {
              increment: formatMoneyForDb(update.debitAmount)
            },
            updatedBy,
            updatedAt: updateTimestamp
          }
        });
      } else {
        await prisma.accountGeneral.update({
          where: { accountNumber },
          data: {
            amountCredit: {
              increment: formatMoneyForDb(update.creditAmount)
            },
            amountDebit: {
              increment: formatMoneyForDb(update.debitAmount)
            },
            accumulationAmountCredit: {
              increment: formatMoneyForDb(update.creditAmount)
            },
            accumulationAmountDebit: {
              increment: formatMoneyForDb(update.debitAmount)
            },
            updatedBy,
            updatedAt: updateTimestamp
          }
        });
      }
    }
  }

  /**
   * Revert account balances after unposting ledgers
   * @param {Object} prisma - Prisma transaction client
   * @param {Array} ledgers - Array of ledger entries to revert
   * @param {string} updatedBy - ID of user updating balances
   * @returns {Promise<void>}
   * @private
   */
  async revertAccountBalances(prisma, ledgers, updatedBy) {
    const updateTimestamp = new Date();

    // Group ledgers by account for batch updates
    const accountUpdates = new Map();

    for (const ledger of ledgers) {
      // Update detail account
      const detailKey = ledger.accountDetailAccountNumber;
      if (!accountUpdates.has(detailKey)) {
        accountUpdates.set(detailKey, {
          type: 'detail',
          creditAmount: 0,
          debitAmount: 0
        });
      }

      const detailUpdate = accountUpdates.get(detailKey);
      if (ledger.transactionType === 'CREDIT') {
        detailUpdate.creditAmount += parseFloat(ledger.amount);
      } else {
        detailUpdate.debitAmount += parseFloat(ledger.amount);
      }

      // Update general account
      const generalKey = ledger.accountGeneralAccountNumber;
      if (!accountUpdates.has(generalKey)) {
        accountUpdates.set(generalKey, {
          type: 'general',
          creditAmount: 0,
          debitAmount: 0
        });
      }

      const generalUpdate = accountUpdates.get(generalKey);
      if (ledger.transactionType === 'CREDIT') {
        generalUpdate.creditAmount += parseFloat(ledger.amount);
      } else {
        generalUpdate.debitAmount += parseFloat(ledger.amount);
      }
    }

    // Apply reverse updates to accounts (decrement instead of increment)
    for (const [accountNumber, update] of accountUpdates) {
      if (update.type === 'detail') {
        await prisma.accountDetail.update({
          where: { accountNumber },
          data: {
            amountCredit: {
              decrement: formatMoneyForDb(update.creditAmount)
            },
            amountDebit: {
              decrement: formatMoneyForDb(update.debitAmount)
            },
            accumulationAmountCredit: {
              decrement: formatMoneyForDb(update.creditAmount)
            },
            accumulationAmountDebit: {
              decrement: formatMoneyForDb(update.debitAmount)
            },
            updatedBy,
            updatedAt: updateTimestamp
          }
        });
      } else {
        await prisma.accountGeneral.update({
          where: { accountNumber },
          data: {
            amountCredit: {
              decrement: formatMoneyForDb(update.creditAmount)
            },
            amountDebit: {
              decrement: formatMoneyForDb(update.debitAmount)
            },
            accumulationAmountCredit: {
              decrement: formatMoneyForDb(update.creditAmount)
            },
            accumulationAmountDebit: {
              decrement: formatMoneyForDb(update.debitAmount)
            },
            updatedBy,
            updatedAt: updateTimestamp
          }
        });
      }
    }
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
