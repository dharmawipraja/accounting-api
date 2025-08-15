/**
 * ledgerService
 * Encapsulates all Prisma DB operations for ledger entities.
 * Keeps DB access centralized so controllers and routes remain thin.
 */
export const ledgerService = {
  async create(prisma, data) {
    return prisma.ledger.create({ data });
  },

  async createMany(prisma, data) {
    return prisma.ledger.createMany({ data });
  },

  async count(prisma, where) {
    return prisma.ledger.count({ where });
  },

  async findMany(prisma, opts) {
    // opts: { where, skip, take, orderBy, select, include }
    return prisma.ledger.findMany(opts);
  },

  async findFirst(prisma, where, include = undefined) {
    return prisma.ledger.findFirst({ where, include });
  },

  async update(prisma, where, data) {
    return prisma.ledger.update({ where, data });
  },

  async transaction(prisma, callback) {
    return prisma.$transaction(callback);
  }
};
