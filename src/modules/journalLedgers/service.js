/**
 * Journal Ledgers Service
 * Business logic for journal ledger operations
 */

import { buildDateRangeFilter } from '../../core/database/utils.js';

export class JournalLedgersService {
  constructor(prisma) {
    this.prisma = prisma;
  }

  /**
   * Get journal ledgers with pagination and filtering
   * @param {Object} options - Query options
   * @returns {Promise<Object>} Journal ledgers and pagination info
   */
  async getJournalLedgers({
    limit,
    skip,
    search,
    accountDetailId,
    accountGeneralId,
    postingStatus,
    startDate,
    endDate,
    includeAccounts = false
  }) {
    // Build where clause
    const where = {
      ...(search && {
        OR: [
          {
            accountDetailAccountNumber: {
              contains: search,
              mode: 'insensitive'
            }
          },
          {
            accountGeneralAccountNumber: {
              contains: search,
              mode: 'insensitive'
            }
          }
        ]
      }),
      ...(postingStatus && { postingStatus }),
      ...(accountDetailId && { accountDetailAccountNumber: accountDetailId }),
      ...(accountGeneralId && { accountGeneralAccountNumber: accountGeneralId }),
      ...buildDateRangeFilter(startDate, endDate, 'ledgerDate')
    };

    // Build include clause for account details if requested
    const include = includeAccounts
      ? {
          // Note: JournalLedger doesn't have direct relations to AccountDetail/AccountGeneral
          // We'll need to fetch account details separately if needed
        }
      : undefined;

    // Execute queries in parallel
    const [journalLedgers, total] = await Promise.all([
      this.prisma.journalLedger.findMany({
        where,
        include,
        skip,
        take: limit,
        orderBy: { ledgerDate: 'desc' }
      }),
      this.prisma.journalLedger.count({ where })
    ]);

    // If includeAccounts is true, fetch account details separately
    let enrichedJournalLedgers = journalLedgers;
    if (includeAccounts && journalLedgers.length > 0) {
      enrichedJournalLedgers = await this.enrichWithAccountDetails(journalLedgers);
    }

    return {
      journalLedgers: enrichedJournalLedgers.map(journalLedger =>
        this.formatJournalLedgerResponse(journalLedger)
      ),
      total
    };
  }

  /**
   * Get journal ledger by ID
   * @param {string} journalLedgerId - Journal ledger ID
   * @returns {Promise<Object|null>} Journal ledger data or null
   */
  async getJournalLedgerById(journalLedgerId) {
    const journalLedger = await this.prisma.journalLedger.findUnique({
      where: { id: journalLedgerId }
    });

    if (!journalLedger) {
      return null;
    }

    // Enrich with account details
    const enrichedJournalLedgers = await this.enrichWithAccountDetails([journalLedger]);
    return this.formatJournalLedgerResponse(enrichedJournalLedgers[0]);
  }

  /**
   * Enrich journal ledgers with account details
   * @param {Array} journalLedgers - Array of journal ledgers
   * @returns {Promise<Array>} Journal ledgers with account details
   * @private
   */
  async enrichWithAccountDetails(journalLedgers) {
    // Get unique account numbers
    const detailAccountNumbers = [
      ...new Set(journalLedgers.map(jl => jl.accountDetailAccountNumber))
    ];
    const generalAccountNumbers = [
      ...new Set(journalLedgers.map(jl => jl.accountGeneralAccountNumber))
    ];

    // Fetch account details in parallel
    const [detailAccounts, generalAccounts] = await Promise.all([
      this.prisma.accountDetail.findMany({
        where: {
          accountNumber: { in: detailAccountNumbers },
          deletedAt: null
        },
        select: {
          id: true,
          accountNumber: true,
          accountName: true,
          accountCategory: true,
          transactionType: true
        }
      }),
      this.prisma.accountGeneral.findMany({
        where: {
          accountNumber: { in: generalAccountNumbers },
          deletedAt: null
        },
        select: {
          id: true,
          accountNumber: true,
          accountName: true,
          accountCategory: true,
          transactionType: true
        }
      })
    ]);

    // Create lookup maps
    const detailAccountMap = new Map(detailAccounts.map(acc => [acc.accountNumber, acc]));
    const generalAccountMap = new Map(generalAccounts.map(acc => [acc.accountNumber, acc]));

    // Enrich journal ledgers with account details
    return journalLedgers.map(journalLedger => ({
      ...journalLedger,
      accountDetail: detailAccountMap.get(journalLedger.accountDetailAccountNumber) || null,
      accountGeneral: generalAccountMap.get(journalLedger.accountGeneralAccountNumber) || null
    }));
  }

  /**
   * Format journal ledger response to ensure consistent number formatting
   * @param {Object} journalLedger - Raw journal ledger data from database
   * @returns {Object} Formatted journal ledger data
   */
  formatJournalLedgerResponse(journalLedger) {
    return {
      ...journalLedger,
      debit: parseFloat(journalLedger.debit) || 0,
      credit: parseFloat(journalLedger.credit) || 0,
      amountDebit: parseFloat(journalLedger.amountDebit) || 0,
      amountCredit: parseFloat(journalLedger.amountCredit) || 0
    };
  }
}
