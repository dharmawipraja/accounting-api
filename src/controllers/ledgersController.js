import { ulid } from 'ulid';
import config from '../config/index.js';
import { ledgerService } from '../services/ledgerService.js';
import { toUtcFromLocal } from '../utils/date.js';
import { formatMoneyForDb, roundMoney, toDecimal } from '../utils/index.js';

const APP_TIMEZONE = config.appConfig?.timezone || 'Asia/Makassar';

/**
 * Generate unique reference number with prefix
 */
const generateReferenceNumber = () => {
  const prefix = 'LED';
  const timestamp = Date.now().toString(36).toUpperCase();
  const randomId = ulid().slice(-6).toUpperCase();
  return `${prefix}-${timestamp}-${randomId}`;
};

/**
 * Controller handlers for ledger endpoints.
 * Keeps routing definitions declarative and moves business logic here.
 */
export const ledgersController = {
  async createBulk(request, reply) {
    try {
      const { ledgers } = request.body;
      const referenceNumber = generateReferenceNumber();
      const userId = request.user.id;
      const now = new Date();

      const accountDetailIds = [...new Set(ledgers.map(l => l.accountDetailId))];
      const accountGeneralIds = [...new Set(ledgers.map(l => l.accountGeneralId))];

      const [existingAccountDetails, existingAccountGenerals] = await Promise.all([
        request.server.prisma.accountDetail.findMany({
          where: { id: { in: accountDetailIds } },
          select: { id: true, accountGeneralId: true }
        }),
        request.server.prisma.accountGeneral.findMany({
          where: { id: { in: accountGeneralIds } },
          select: { id: true }
        })
      ]);

      const detailMap = new Map(existingAccountDetails.map(acc => [acc.id, acc.accountGeneralId]));
      const foundGeneralIds = new Set(existingAccountGenerals.map(acc => acc.id));

      const missingDetailIds = accountDetailIds.filter(id => !detailMap.has(id));
      const missingGeneralIds = accountGeneralIds.filter(id => !foundGeneralIds.has(id));

      if (missingDetailIds.length > 0 || missingGeneralIds.length > 0) {
        return reply.code(400).send({
          success: false,
          error: {
            code: 'ACCOUNTS_NOT_FOUND',
            message: 'Some accounts were not found',
            details: [
              ...(missingDetailIds.length > 0
                ? [`Account Details not found: ${missingDetailIds.join(', ')}`]
                : []),
              ...(missingGeneralIds.length > 0
                ? [`Account Generals not found: ${missingGeneralIds.join(', ')}`]
                : [])
            ]
          }
        });
      }

      const mismatches = [];
      for (const item of ledgers) {
        const expectedGeneral = detailMap.get(item.accountDetailId);
        if (!expectedGeneral || expectedGeneral !== item.accountGeneralId) {
          mismatches.push(
            `Detail ${item.accountDetailId} does not belong to General ${item.accountGeneralId}`
          );
        }
      }
      if (mismatches.length) {
        return reply.code(400).send({
          success: false,
          error: {
            code: 'ACCOUNT_RELATION_MISMATCH',
            message: 'Account detail and general mismatch',
            details: mismatches
          }
        });
      }

      const totalsDec = ledgers.reduce(
        (acc, l) => {
          const amtDec = toDecimal(l.amount);
          if (l.transactionType === 'DEBIT') acc.debit = acc.debit.plus(amtDec);
          if (l.transactionType === 'CREDIT') acc.credit = acc.credit.plus(amtDec);
          return acc;
        },
        { debit: toDecimal(0), credit: toDecimal(0) }
      );

      const totals = {
        debit: Number(totalsDec.debit.toFixed(2)),
        credit: Number(totalsDec.credit.toFixed(2))
      };

      if (!totalsDec.debit.minus(totalsDec.credit).equals(0)) {
        return reply.code(400).send({
          success: false,
          error: {
            code: 'UNBALANCED_JOURNAL',
            message: `Unbalanced entries: debit ${totals.debit.toFixed(2)} != credit ${totals.credit.toFixed(2)}`
          }
        });
      }

      const existingRef = await ledgerService.findFirst(
        request.server.prisma,
        { referenceNumber },
        undefined
      );

      if (existingRef) {
        throw new Error('Reference number already exists');
      }

      const ledgerData = ledgers.map(ledger => ({
        referenceNumber,
        amount: formatMoneyForDb(ledger.amount),
        description: ledger.description.trim(),
        accountDetailId: ledger.accountDetailId,
        accountGeneralId: ledger.accountGeneralId,
        ledgerType: ledger.ledgerType,
        transactionType: ledger.transactionType,
        ledgerDate: ledger.ledgerDate
          ? toUtcFromLocal(ledger.ledgerDate, APP_TIMEZONE, { mode: 'exact' })
          : new Date(),
        postingStatus: 'PENDING',
        postingAt: null,
        createdBy: userId,
        updatedBy: userId,
        createdAt: now,
        updatedAt: now
      }));

      const createdLedgers = await ledgerService.transaction(
        request.server.prisma,
        async prisma => {
          const results = [];
          for (const data of ledgerData) {
            const created = await prisma.ledger.create({
              data: { id: ulid(), ...data },
              select: {
                id: true,
                referenceNumber: true,
                amount: true,
                description: true,
                ledgerType: true,
                transactionType: true,
                postingStatus: true,
                ledgerDate: true,
                postingAt: true,
                accountDetailId: true,
                accountGeneralId: true,
                createdAt: true,
                createdBy: true
              }
            });
            results.push(created);
          }
          return results;
        }
      );

      reply.code(201).send({
        success: true,
        message: `Successfully created ${createdLedgers.length} ledger entries`,
        data: {
          referenceNumber,
          totalEntries: createdLedgers.length,
          ledgers: createdLedgers.map(l => ({ ...l, amount: roundMoney(l.amount) }))
        }
      });
    } catch (error) {
      request.log.error('Error creating bulk ledgers:', error);

      if (error.message === 'Reference number already exists') {
        return reply.code(409).send({
          success: false,
          error: {
            code: 'REFERENCE_NUMBER_EXISTS',
            message: 'Reference number already exists, please retry'
          }
        });
      }

      if (
        error.code === 'P2002' &&
        Array.isArray(error.meta?.target) &&
        error.meta.target.includes('referenceNumber')
      ) {
        return reply.code(409).send({
          success: false,
          error: {
            code: 'REFERENCE_NUMBER_EXISTS',
            message: 'Reference number already exists, please retry'
          }
        });
      }

      reply.code(500).send({
        success: false,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to create ledger entries'
        }
      });
    }
  },

  async list(request, reply) {
    try {
      const { limit = 10, skip } = request.getPagination();
      const {
        search,
        ledgerType,
        transactionType,
        postingStatus,
        accountDetailId,
        accountGeneralId,
        startDate,
        endDate
      } = request.query;

      const normalizedStart = startDate
        ? toUtcFromLocal(startDate, APP_TIMEZONE, { mode: 'startOfDay' })
        : undefined;
      const normalizedEnd = endDate
        ? toUtcFromLocal(endDate, APP_TIMEZONE, { mode: 'endOfDay' })
        : undefined;

      const where = {
        ...(search && {
          OR: [
            { referenceNumber: { contains: search, mode: 'insensitive' } },
            { description: { contains: search, mode: 'insensitive' } }
          ]
        }),
        ...(ledgerType && { ledgerType }),
        ...(transactionType && { transactionType }),
        ...(postingStatus && { postingStatus }),
        ...(accountDetailId && { accountDetailId }),
        ...(accountGeneralId && { accountGeneralId }),
        ...((normalizedStart || normalizedEnd) && {
          ledgerDate: {
            ...(normalizedStart && { gte: normalizedStart }),
            ...(normalizedEnd && { lte: normalizedEnd })
          }
        })
      };

      const [total, ledgers] = await Promise.all([
        ledgerService.count(request.server.prisma, where),
        ledgerService.findMany(request.server.prisma, {
          where,
          include: {
            accountDetail: {
              select: {
                accountNumber: true,
                accountName: true
              }
            },
            accountGeneral: {
              select: {
                accountNumber: true,
                accountName: true
              }
            }
          },
          orderBy: [{ ledgerDate: 'desc' }, { createdAt: 'desc' }],
          skip,
          take: limit
        })
      ]);

      return reply.paginate(
        ledgers.map(l => ({ ...l, amount: roundMoney(l.amount) })),
        total
      );
    } catch (error) {
      request.log.error('Error fetching ledgers:', error);
      reply.code(500).send({
        success: false,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to fetch ledger entries'
        }
      });
    }
  },

  async getById(request, reply) {
    try {
      const { id } = request.params;

      const ledger = await ledgerService.findFirst(
        request.server.prisma,
        { id },
        {
          include: {
            accountDetail: { select: { id: true, accountNumber: true, accountName: true } },
            accountGeneral: { select: { id: true, accountNumber: true, accountName: true } }
          }
        }
      );

      if (!ledger) {
        return reply.code(404).send({
          success: false,
          error: { code: 'LEDGER_NOT_FOUND', message: 'Ledger entry not found' }
        });
      }

      reply.send({ success: true, data: { ...ledger, amount: roundMoney(ledger.amount) } });
    } catch (error) {
      request.log.error('Error fetching ledger:', error);
      reply.code(500).send({
        success: false,
        error: { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to fetch ledger entry' }
      });
    }
  },

  async update(request, reply) {
    try {
      const { id } = request.params;
      const updateData = request.body;

      const existingLedger = await ledgerService.findFirst(request.server.prisma, { id });

      if (!existingLedger) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'LEDGER_NOT_FOUND',
            message: 'Ledger entry not found'
          }
        });
      }

      if (existingLedger.postingStatus === 'POSTED') {
        return reply.code(409).send({
          success: false,
          error: {
            code: 'LEDGER_ALREADY_POSTED',
            message: 'Cannot edit posted ledger entries'
          }
        });
      }

      await ledgerService.update(
        request.server.prisma,
        { id },
        {
          ...updateData,
          ...(typeof updateData.amount === 'number' && {
            amount: roundMoney(updateData.amount)
          }),
          ...(updateData.description && { description: updateData.description.trim() }),
          ...(updateData.ledgerDate && {
            ledgerDate:
              typeof updateData.ledgerDate === 'string'
                ? toUtcFromLocal(updateData.ledgerDate, APP_TIMEZONE, { mode: 'exact' })
                : updateData.ledgerDate
          }),
          updatedBy: request.user.id,
          updatedAt: new Date()
        }
      );

      const result = await ledgerService.findFirst(request.server.prisma, { id }, undefined);

      reply.send({
        success: true,
        message: 'Ledger entry updated successfully',
        data: { ...result, amount: roundMoney(result.amount) }
      });
    } catch (error) {
      request.log.error('Error updating ledger:', error);
      reply.code(500).send({
        success: false,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update ledger entry'
        }
      });
    }
  },

  async remove(request, reply) {
    try {
      const { id } = request.params;

      const existingLedger = await ledgerService.findFirst(request.server.prisma, { id });

      if (!existingLedger) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'LEDGER_NOT_FOUND',
            message: 'Ledger entry not found'
          }
        });
      }

      if (existingLedger.postingStatus === 'POSTED') {
        return reply.code(409).send({
          success: false,
          error: {
            code: 'LEDGER_ALREADY_POSTED',
            message: 'Cannot delete posted ledger entries'
          }
        });
      }

      await ledgerService.update(
        request.server.prisma,
        { id },
        {
          deletedAt: new Date(),
          updatedBy: request.user.id,
          updatedAt: new Date()
        }
      );

      reply.send({
        success: true,
        message: 'Ledger entry deleted successfully'
      });
    } catch (error) {
      request.log.error('Error deleting ledger:', error);
      reply.code(500).send({
        success: false,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to delete ledger entry'
        }
      });
    }
  },

  async post(request, reply) {
    try {
      const { id } = request.params;

      const existingLedger = await ledgerService.findFirst(request.server.prisma, { id });

      if (!existingLedger) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'LEDGER_NOT_FOUND',
            message: 'Ledger entry not found'
          }
        });
      }

      if (existingLedger.postingStatus === 'POSTED') {
        return reply.code(409).send({
          success: false,
          error: {
            code: 'LEDGER_ALREADY_POSTED',
            message: 'Ledger entry is already posted'
          }
        });
      }

      const now = new Date();

      const updatedLedger = await ledgerService.update(
        request.server.prisma,
        { id },
        {
          postingStatus: 'POSTED',
          postingAt: now,
          updatedBy: request.user.id,
          updatedAt: now
        }
      );

      reply.send({
        success: true,
        message: 'Ledger entry posted successfully',
        data: {
          id: updatedLedger.id,
          postingStatus: updatedLedger.postingStatus,
          postingAt: updatedLedger.postingAt
        }
      });
    } catch (error) {
      request.log.error('Error posting ledger:', error);
      reply.code(500).send({
        success: false,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to post ledger entry'
        }
      });
    }
  },

  async unpost(request, reply) {
    try {
      const { id } = request.params;

      const existingLedger = await ledgerService.findFirst(request.server.prisma, { id });

      if (!existingLedger) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'LEDGER_NOT_FOUND',
            message: 'Ledger entry not found'
          }
        });
      }

      if (existingLedger.postingStatus === 'PENDING') {
        return reply.code(409).send({
          success: false,
          error: {
            code: 'LEDGER_NOT_POSTED',
            message: 'Ledger entry is not posted'
          }
        });
      }

      const updatedLedger = await ledgerService.update(
        request.server.prisma,
        { id },
        {
          postingStatus: 'PENDING',
          postingAt: null,
          updatedBy: request.user.id,
          updatedAt: new Date()
        }
      );

      reply.send({
        success: true,
        message: 'Ledger entry unposted successfully',
        data: {
          id: updatedLedger.id,
          postingStatus: updatedLedger.postingStatus,
          postingAt: updatedLedger.postingAt
        }
      });
    } catch (error) {
      request.log.error('Error unposting ledger:', error);
      reply.code(500).send({
        success: false,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to unpost ledger entry'
        }
      });
    }
  }
};
