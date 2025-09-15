/**
 * Posting Service
 * Business logic for posting operations
 */

import { formatMoneyForDb } from '../../core/database/utils.js';
import { t } from '../../shared/i18n/index.js';
import { generateId } from '../../shared/utils/id.js';

export class PostingService {
  constructor(prisma) {
    this.prisma = prisma;
  }

  /**
   * Post all pending ledgers for a specific date
   * @param {string} ledgerDate - Date string in ISO format (YYYY-MM-DD)
   * @param {string} postedBy - ID of user posting the ledgers
   * @returns {Promise<Object>} Result of posting operation
   */
  async postLedgersByDate(ledgerDate, postedBy) {
    // Get start and end of the target date for query
    const startOfDay = new Date(ledgerDate);
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date(ledgerDate);
    endOfDay.setHours(23, 59, 59, 999);

    // Check if there are already posted ledgers for this date
    const existingPostedLedgers = await this.prisma.ledger.findFirst({
      where: {
        ledgerDate: {
          gte: startOfDay,
          lte: endOfDay
        },
        postingStatus: 'POSTED',
        deletedAt: null
      }
    });

    if (existingPostedLedgers) {
      throw new Error(t('posting.ledgersAlreadyPosted', { date: ledgerDate }));
    }

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
      throw new Error(t('posting.noPendingLedgersFound'));
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

      // Group ledgers by account detail account number and sum amounts
      const accountGroups = new Map();

      for (const ledger of pendingLedgers) {
        const accountKey = ledger.accountDetailAccountNumber;

        if (!accountGroups.has(accountKey)) {
          accountGroups.set(accountKey, {
            accountDetailAccountNumber: ledger.accountDetailAccountNumber,
            accountGeneralAccountNumber: ledger.accountGeneralAccountNumber,
            ledgerDate: ledger.ledgerDate,
            totalDebit: 0,
            totalCredit: 0
          });
        }

        const group = accountGroups.get(accountKey);
        const amount = parseFloat(ledger.amount) || 0;

        if (ledger.transactionType === 'DEBIT') {
          group.totalDebit += amount;
        } else if (ledger.transactionType === 'KREDIT') {
          group.totalCredit += amount;
        }
      }

      // Create journal ledger entries - one per account with summed amounts
      const journalEntries = Array.from(accountGroups.values()).map(group => ({
        id: generateId(),
        accountDetailAccountNumber: group.accountDetailAccountNumber,
        accountGeneralAccountNumber: group.accountGeneralAccountNumber,
        debit: formatMoneyForDb(group.totalDebit),
        credit: formatMoneyForDb(group.totalCredit),
        amountDebit: formatMoneyForDb(group.totalDebit),
        amountCredit: formatMoneyForDb(group.totalCredit),
        ledgerDate: group.ledgerDate,
        postingStatus: 'PENDING',
        createdAt: postingTimestamp,
        createdBy: postedBy
      }));

      // Insert journal entries
      await prisma.journalLedger.createMany({
        data: journalEntries
      });

      return {
        postedCount: updateResult.count,
        ledgers: pendingLedgers.map(ledger => this.formatLedgerResponse(ledger)),
        journalEntriesCreated: journalEntries.length,
        accountsGrouped: accountGroups.size,
        postingTimestamp
      };
    });

    return {
      message:
        t('posting.ledgersPostedSuccessfully', { date: ledgerDate }) +
        ` (${result.postedCount} entri, ${result.accountsGrouped} jurnal)`,
      data: result
    };
  }

  /**
   * Post balance by updating AccountDetail amounts from JournalLedger entries
   * @param {string} date - Date string in format dd-mm-yyyy
   * @param {string} postedBy - ID of user posting the balance
   * @returns {Promise<Object>} Result of balance posting operation
   */
  async postBalanceByDate(date, postedBy) {
    // Parse date from dd-mm-yyyy format to Date object
    const [day, month, year] = date.split('-');
    const targetDate = new Date(year, month - 1, day);
    targetDate.setHours(23, 59, 59, 999); // End of day

    // Check if there are already posted journal ledgers for this date
    const existingPostedJournalLedgers = await this.prisma.journalLedger.findFirst({
      where: {
        ledgerDate: {
          lte: targetDate
        },
        postingStatus: 'POSTED'
      }
    });

    if (existingPostedJournalLedgers) {
      throw new Error(
        `Balance for date ${date} has already been posted. Cannot post the same date twice.`
      );
    }

    // Find all pending journal ledger entries up to the specified date
    const pendingJournalLedgers = await this.prisma.journalLedger.findMany({
      where: {
        ledgerDate: {
          lte: targetDate
        },
        postingStatus: 'PENDING'
      },
      orderBy: {
        accountDetailAccountNumber: 'asc'
      }
    });

    if (pendingJournalLedgers.length === 0) {
      throw new Error(t('posting.noPendingJournalLedgers'));
    }

    // Execute updates in a transaction
    const result = await this.prisma.$transaction(async prisma => {
      const postingTimestamp = new Date();
      const updatedAccounts = [];

      // Use the modified updateAccountBalances function for journal ledger entries
      await this.updateAccountBalances(prisma, pendingJournalLedgers, postedBy, updatedAccounts);

      // Update all journal ledger entries to POSTED status
      const updateResult = await prisma.journalLedger.updateMany({
        where: {
          ledgerDate: {
            lte: targetDate
          },
          postingStatus: 'PENDING'
        },
        data: {
          postingStatus: 'POSTED',
          postingAt: postingTimestamp
        }
      });

      return {
        postedCount: updateResult.count,
        updatedAccounts,
        postingTimestamp,
        targetDate: date
      };
    });

    return {
      message: t('posting.balancePostedSuccessfully', { count: result.postedCount, date }),
      data: result
    };
  }

  /**
   * Unpost all posted ledgers for a specific date
   * @param {string} ledgerDate - Date string in ISO format (YYYY-MM-DD)
   * @param {string} unpostedBy - ID of user unposting the ledgers
   * @returns {Promise<Object>} Result of unposting operation
   */
  async unpostLedgersByDate(ledgerDate, unpostedBy) {
    // Get start and end of the target date for query
    const startOfDay = new Date(ledgerDate);
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date(ledgerDate);
    endOfDay.setHours(23, 59, 59, 999);

    // Check if there are any posted journal ledger entries for this date
    const existingPostedJournalLedgers = await this.prisma.journalLedger.findFirst({
      where: {
        ledgerDate: {
          gte: startOfDay,
          lte: endOfDay
        },
        postingStatus: 'POSTED'
      }
    });

    if (existingPostedJournalLedgers) {
      throw new Error(
        `Cannot unpost ledgers for date ${ledgerDate} because journal entries for this date have already been posted. Please unpost the balance first.`
      );
    }

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
      throw new Error(t('posting.noPostedLedgersFound'));
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

      // Delete only the pending journal ledger entries for the date
      const deleteJournalResult = await prisma.journalLedger.deleteMany({
        where: {
          ledgerDate: {
            gte: startOfDay,
            lte: endOfDay
          },
          postingStatus: 'PENDING'
        }
      });

      return {
        unpostedCount: updateResult.count,
        ledgers: postedLedgers.map(ledger => this.formatLedgerResponse(ledger)),
        journalEntriesDeleted: deleteJournalResult.count,
        unpostingTimestamp
      };
    });

    return {
      message: t('posting.ledgerUnpostedSuccessfully', {
        count: result.unpostedCount,
        date: ledgerDate
      }),
      data: result
    };
  }

  /**
   * Unpost balance entries for a specific date only
   * @param {string} date - Date string in format dd-mm-yyyy
   * @param {string} unpostedBy - ID of user unposting the balance
   * @returns {Promise<Object>} Result of unposting operation
   */
  async unpostBalanceByDate(date, unpostedBy) {
    // Parse date from dd-mm-yyyy format to Date object
    const [day, month, year] = date.split('-');
    const targetDate = new Date(year, month - 1, day);
    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0); // Start of day

    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999); // End of day

    // Find all posted journal ledger entries for the specific date only
    const postedJournalLedgers = await this.prisma.journalLedger.findMany({
      where: {
        ledgerDate: {
          gte: startOfDay,
          lte: endOfDay
        },
        postingStatus: 'POSTED'
      },
      orderBy: {
        accountDetailAccountNumber: 'asc'
      }
    });

    if (postedJournalLedgers.length === 0) {
      throw new Error(`No posted balance entries found for ${date}`);
    }

    // Execute updates in a transaction
    const result = await this.prisma.$transaction(async prisma => {
      const unpostingTimestamp = new Date();
      const updatedAccounts = [];

      // Revert account balance changes for journal ledger entries
      await this.revertAccountBalances(prisma, postedJournalLedgers, unpostedBy, updatedAccounts);

      // Update all journal ledger entries to PENDING status for the specific date only
      const updateResult = await prisma.journalLedger.updateMany({
        where: {
          ledgerDate: {
            gte: startOfDay,
            lte: endOfDay
          },
          postingStatus: 'POSTED'
        },
        data: {
          postingStatus: 'PENDING',
          postingAt: null
        }
      });

      return {
        unpostedCount: updateResult.count,
        updatedAccounts,
        unpostingTimestamp,
        targetDate: date
      };
    });

    return {
      message: t('posting.balanceUnpostedSuccessfully', { count: result.unpostedCount, date }),
      data: result
    };
  }

  /**
   * Update account balances after posting journal ledger entries
   * @param {Object} prisma - Prisma transaction client
   * @param {Array} journalEntries - Array of journal ledger entries with debit/credit fields
   * @param {string} updatedBy - ID of user updating balances
   * @param {Array} [updatedAccounts] - Optional array to collect updated account info
   * @returns {Promise<void>}
   * @private
   */
  async updateAccountBalances(prisma, journalEntries, updatedBy, updatedAccounts = null) {
    const updateTimestamp = new Date();

    // Group entries by account for batch updates (only detail accounts)
    const accountUpdates = new Map();

    for (const entry of journalEntries) {
      const accountNumber = entry.accountDetailAccountNumber;

      if (!accountUpdates.has(accountNumber)) {
        accountUpdates.set(accountNumber, {
          creditAmount: 0,
          debitAmount: 0
        });
      }

      const update = accountUpdates.get(accountNumber);

      // Journal ledger entries have debit and credit fields
      update.debitAmount += parseFloat(entry.debit || 0);
      update.creditAmount += parseFloat(entry.credit || 0);
    }

    // Apply updates to AccountDetail only
    for (const [accountNumber, update] of accountUpdates) {
      // Check if account exists
      const accountDetail = await prisma.accountDetail.findUnique({
        where: { accountNumber },
        select: {
          id: true,
          accountNumber: true,
          accountName: true,
          amountDebit: true,
          amountCredit: true
        }
      });

      if (!accountDetail) {
        throw new Error(t('posting.accountDetailNotFound', { accountNumber }));
      }

      // Update account balances
      const updatedAccount = await prisma.accountDetail.update({
        where: { accountNumber },
        data: {
          amountCredit: {
            increment: formatMoneyForDb(update.creditAmount)
          },
          amountDebit: {
            increment: formatMoneyForDb(update.debitAmount)
          },
          updatedBy,
          updatedAt: updateTimestamp
        },
        select: {
          accountNumber: true,
          accountName: true,
          amountDebit: true,
          amountCredit: true
        }
      });

      // If updatedAccounts array is provided, collect the results
      if (updatedAccounts) {
        updatedAccounts.push({
          ...updatedAccount,
          addedDebit: update.debitAmount,
          addedCredit: update.creditAmount
        });
      }
    }
  }

  /**
   * Revert account balances after unposting journal ledger entries
   * @param {Object} prisma - Prisma transaction client
   * @param {Array} journalEntries - Array of journal ledger entries with debit/credit fields
   * @param {string} updatedBy - ID of user updating balances
   * @param {Array} [updatedAccounts] - Optional array to collect updated account info
   * @returns {Promise<void>}
   * @private
   */
  async revertAccountBalances(prisma, journalEntries, updatedBy, updatedAccounts = null) {
    const updateTimestamp = new Date();

    // Group entries by account for batch updates (only detail accounts)
    const accountUpdates = new Map();

    for (const entry of journalEntries) {
      const accountNumber = entry.accountDetailAccountNumber;

      if (!accountUpdates.has(accountNumber)) {
        accountUpdates.set(accountNumber, {
          creditAmount: 0,
          debitAmount: 0
        });
      }

      const update = accountUpdates.get(accountNumber);

      // Journal ledger entries have debit and credit fields
      update.debitAmount += parseFloat(entry.debit || 0);
      update.creditAmount += parseFloat(entry.credit || 0);
    }

    // Apply reverse updates to AccountDetail only (decrement instead of increment)
    for (const [accountNumber, update] of accountUpdates) {
      // Check if account exists and get current values
      const accountDetail = await prisma.accountDetail.findUnique({
        where: { accountNumber },
        select: {
          id: true,
          accountNumber: true,
          accountName: true,
          amountDebit: true,
          amountCredit: true
        }
      });

      if (!accountDetail) {
        throw new Error(t('posting.accountDetailNotFound', { accountNumber }));
      }

      // Update account balances (decrement for unposting)
      const updatedAccount = await prisma.accountDetail.update({
        where: { accountNumber },
        data: {
          amountCredit: {
            decrement: formatMoneyForDb(update.creditAmount)
          },
          amountDebit: {
            decrement: formatMoneyForDb(update.debitAmount)
          },
          updatedBy,
          updatedAt: updateTimestamp
        },
        select: {
          accountNumber: true,
          accountName: true,
          amountDebit: true,
          amountCredit: true
        }
      });

      // If updatedAccounts array is provided, collect the results
      if (updatedAccounts) {
        updatedAccounts.push({
          ...updatedAccount,
          revertedDebit: update.debitAmount,
          revertedCredit: update.creditAmount
        });
      }
    }
  }

  /**
   * Calculate neraca balance (SHU calculation) without saving to database
   * Calculates SHU by summing current balances of all LABA_RUGI account details
   * @param {string} date - Date string in format dd-mm-yyyy (used for year calculation)
   * @returns {Promise<Object>} Result of neraca balance calculation
   */
  async calculateNeracaBalance(date) {
    // Parse date from dd-mm-yyyy format to Date object
    const [day, month, year] = date.split('-');
    const targetDate = new Date(year, month - 1, day);
    targetDate.setHours(23, 59, 59, 999); // End of target day

    // Check if SHU for this year already exists
    const existingSHU = await this.prisma.sisaHasilUsaha.findFirst({
      where: {
        year
      }
    });

    // Find all account details with ReportType LABA_RUGI
    const labaRugiAccounts = await this.prisma.accountDetail.findMany({
      where: {
        reportType: 'LABA_RUGI',
        deletedAt: null
      },
      select: {
        id: true,
        accountNumber: true,
        accountName: true,
        accountCategory: true,
        transactionType: true,
        amountCredit: true,
        amountDebit: true
      }
    });

    if (labaRugiAccounts.length === 0) {
      throw new Error(t('posting.noLabaRugiAccounts'));
    }

    // Calculate total SHU amount from AccountDetail balances
    let totalPendapatan = 0; // KREDIT transaction type accounts (revenue)
    let totalBiaya = 0; // DEBIT transaction type accounts (expenses)

    for (const account of labaRugiAccounts) {
      if (account.transactionType === 'KREDIT') {
        // For KREDIT accounts (revenue), use amountCredit
        totalPendapatan += parseFloat(account.amountCredit) || 0;
      } else if (account.transactionType === 'DEBIT') {
        // For DEBIT accounts (expenses), use amountDebit
        totalBiaya += parseFloat(account.amountDebit) || 0;
      }
    }

    // SHU = Total Pendapatan - Total Biaya
    const sisaHasilUsaha = totalPendapatan - totalBiaya;

    return {
      message: `Successfully calculated Sisa Hasil Usaha for year ${year}`,
      data: {
        calculationDetails: {
          totalPendapatan: formatMoneyForDb(totalPendapatan),
          totalBiaya: formatMoneyForDb(totalBiaya),
          sisaHasilUsaha: formatMoneyForDb(sisaHasilUsaha),
          accountsProcessed: labaRugiAccounts.length,
          year,
          calculationDate: targetDate.toISOString().split('T')[0]
        },
        existingRecord: existingSHU
          ? {
              id: existingSHU.id,
              currentAmount: formatMoneyForDb(parseFloat(existingSHU.amount)),
              accountingClose: existingSHU.accountingClose,
              createdAt: existingSHU.createdAt,
              updatedAt: existingSHU.updatedAt
            }
          : null,
        canSave: !existingSHU || !existingSHU.accountingClose
      }
    };
  }

  /**
   * Post neraca balance (SHU) to database
   * Saves or updates the calculated SHU value to database
   * @param {string} date - Date string in format dd-mm-yyyy (used for year calculation)
   * @param {number} sisaHasilUsahaAmount - The calculated SHU amount to save
   * @param {string} postedBy - ID of user posting the balance
   * @returns {Promise<Object>} Result of neraca balance posting operation
   */
  async postNeracaBalance(date, sisaHasilUsahaAmount, postedBy) {
    // Parse date from dd-mm-yyyy format to Date object
    const [day, month, year] = date.split('-');
    const targetDate = new Date(year, month - 1, day);
    targetDate.setHours(23, 59, 59, 999); // End of target day

    // Validate sisaHasilUsahaAmount parameter
    if (typeof sisaHasilUsahaAmount !== 'number' || isNaN(sisaHasilUsahaAmount)) {
      throw new Error(t('posting.invalidShuAmount'));
    }

    // Check if SHU for this year already exists
    const existingSHU = await this.prisma.sisaHasilUsaha.findFirst({
      where: {
        year
      }
    });

    if (existingSHU && existingSHU.accountingClose) {
      throw new Error(
        `Sisa Hasil Usaha for year ${year} has been closed and cannot be modified. Please contact administrator.`
      );
    }

    // Find account detail 3203 (SHU)
    const shuAccount = await this.prisma.accountDetail.findUnique({
      where: {
        accountNumber: '3203'
      }
    });

    if (!shuAccount) {
      throw new Error(t('posting.shuAccountNotFound'));
    }

    // Execute updates in a transaction
    const result = await this.prisma.$transaction(async prisma => {
      const postingTimestamp = new Date();
      let sisaHasilUsahaRecord;

      if (existingSHU) {
        // Update existing SHU record
        sisaHasilUsahaRecord = await prisma.sisaHasilUsaha.update({
          where: {
            id: existingSHU.id
          },
          data: {
            amount: formatMoneyForDb(sisaHasilUsahaAmount),
            accountDetailAccountNumber: shuAccount.accountNumber,
            accountGeneralAccountNumber: shuAccount.accountGeneralAccountNumber,
            updatedAt: postingTimestamp
          }
        });
      } else {
        // Create new SHU record
        sisaHasilUsahaRecord = await prisma.sisaHasilUsaha.create({
          data: {
            id: generateId(),
            year,
            amount: formatMoneyForDb(sisaHasilUsahaAmount),
            accountDetailAccountNumber: shuAccount.accountNumber,
            accountGeneralAccountNumber: shuAccount.accountGeneralAccountNumber,
            accountingClose: false,
            createdAt: postingTimestamp,
            updatedAt: postingTimestamp
          }
        });
      }

      // Update accumulationAmountCredit for account 3203 (SHU) - overwrite instead of increment
      const updatedShuAccount = await prisma.accountDetail.update({
        where: {
          accountNumber: '3203'
        },
        data: {
          accumulationAmountCredit: formatMoneyForDb(
            sisaHasilUsahaAmount > 0 ? sisaHasilUsahaAmount : 0
          ),
          accumulationAmountDebit: formatMoneyForDb(
            sisaHasilUsahaAmount < 0 ? Math.abs(sisaHasilUsahaAmount) : 0
          ),
          updatedBy: postedBy,
          updatedAt: postingTimestamp
        }
      });

      return {
        sisaHasilUsahaRecord,
        updatedShuAccount,
        postingDetails: {
          sisaHasilUsaha: formatMoneyForDb(sisaHasilUsahaAmount),
          operation: existingSHU ? 'updated' : 'created',
          year,
          postingDate: targetDate.toISOString().split('T')[0]
        },
        postingTimestamp
      };
    });

    return {
      message: t('posting.shuCalculatedSuccessful', {
        action: t(existingSHU ? 'posting.shuUpdated' : 'posting.shuCalculated'),
        year
      }),
      data: result
    };
  }

  /**
   * Post neraca akhir by updating AccountGeneral amounts from AccountDetail sums
   * @param {string} date - Date string in format dd-mm-yyyy
   * @param {string} postedBy - ID of user posting the neraca akhir
   * @returns {Promise<Object>} Result of neraca akhir posting operation
   */
  async postNeracaAkhir(date, postedBy) {
    // Parse date from dd-mm-yyyy format to Date object for logging purposes
    const [day, month, year] = date.split('-');
    const targetDate = new Date(year, month - 1, day);
    targetDate.setHours(23, 59, 59, 999); // End of day

    // Get all AccountDetail records that are not soft deleted
    const accountDetails = await this.prisma.accountDetail.findMany({
      where: {
        deletedAt: null
      },
      select: {
        accountNumber: true,
        accountName: true,
        accountGeneralAccountNumber: true,
        amountCredit: true,
        amountDebit: true
      }
    });

    if (accountDetails.length === 0) {
      throw new Error(t('posting.noAccountDetailsFound'));
    }

    // Group account details by accountGeneralAccountNumber and sum their amounts
    const accountGeneralSums = new Map();

    for (const detail of accountDetails) {
      const generalAccountNumber = detail.accountGeneralAccountNumber;

      if (!accountGeneralSums.has(generalAccountNumber)) {
        accountGeneralSums.set(generalAccountNumber, {
          totalAmountCredit: 0,
          totalAmountDebit: 0,
          detailAccounts: []
        });
      }

      const sum = accountGeneralSums.get(generalAccountNumber);
      sum.totalAmountCredit += parseFloat(detail.amountCredit) || 0;
      sum.totalAmountDebit += parseFloat(detail.amountDebit) || 0;
      sum.detailAccounts.push({
        accountNumber: detail.accountNumber,
        accountName: detail.accountName,
        amountCredit: parseFloat(detail.amountCredit) || 0,
        amountDebit: parseFloat(detail.amountDebit) || 0
      });
    }

    // Execute updates in a transaction
    const result = await this.prisma.$transaction(async prisma => {
      const postingTimestamp = new Date();
      const updatedAccountGenerals = [];

      // Update each AccountGeneral with the summed amounts
      for (const [generalAccountNumber, sums] of accountGeneralSums) {
        // Check if AccountGeneral exists
        const accountGeneral = await prisma.accountGeneral.findUnique({
          where: {
            accountNumber: generalAccountNumber,
            deletedAt: null
          },
          select: {
            id: true,
            accountNumber: true,
            accountName: true,
            amountCredit: true,
            amountDebit: true
          }
        });

        if (!accountGeneral) {
          throw new Error(`Account General with number ${generalAccountNumber} not found`);
        }

        // Update AccountGeneral with the summed amounts
        const updatedAccountGeneral = await prisma.accountGeneral.update({
          where: { accountNumber: generalAccountNumber },
          data: {
            amountCredit: formatMoneyForDb(sums.totalAmountCredit),
            amountDebit: formatMoneyForDb(sums.totalAmountDebit),
            updatedBy: postedBy,
            updatedAt: postingTimestamp
          },
          select: {
            accountNumber: true,
            accountName: true,
            amountCredit: true,
            amountDebit: true
          }
        });

        updatedAccountGenerals.push({
          ...updatedAccountGeneral,
          summedFromDetails: {
            totalAmountCredit: sums.totalAmountCredit,
            totalAmountDebit: sums.totalAmountDebit,
            detailAccountsCount: sums.detailAccounts.length,
            detailAccounts: sums.detailAccounts
          }
        });
      }

      return {
        updatedAccountGenerals,
        postingTimestamp,
        targetDate: date,
        totalAccountGeneralUpdated: accountGeneralSums.size,
        totalAccountDetailProcessed: accountDetails.length
      };
    });

    return {
      message: t('posting.neracaAkhirPostedSuccessfully', {
        generalCount: result.totalAccountGeneralUpdated,
        detailCount: result.totalAccountDetailProcessed,
        date
      }),
      data: result
    };
  }

  /**
   * Format ledger response to ensure consistent number formatting
   * @param {Object} ledger - Raw ledger data from database
   * @returns {Object} Formatted ledger data
   * @private
   */
  formatLedgerResponse(ledger) {
    return {
      ...ledger,
      amount: parseFloat(ledger.amount) || 0
    };
  }
}
