/**
 * accountGeneralService
 * Encapsulates all Prisma DB operations for accountGeneral entities.
 * Keeps DB access centralized so controllers and routes remain thin.
 */
export const accountGeneralService = {
  async create(prisma, data) {
    return prisma.accountGeneral.create({ data });
  },

  async count(prisma, where) {
    return prisma.accountGeneral.count({ where });
  },

  async findMany(prisma, opts) {
    // opts: { where, skip, take, orderBy, select }
    return prisma.accountGeneral.findMany(opts);
  },

  async findFirst(prisma, where, include = undefined) {
    return prisma.accountGeneral.findFirst({ where, include });
  },

  async update(prisma, where, data) {
    return prisma.accountGeneral.update({ where, data });
  },

  async softDelete(prisma, where, data) {
    return prisma.accountGeneral.update({ where, data });
  }
};
