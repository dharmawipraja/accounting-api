import { PrismaService } from '../src/common/prisma/prisma.service';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('Soft-delete extension hardening (integration)', () => {
  let db: TestDb;
  let prisma: PrismaService;

  beforeAll(async () => {
    db = await startTestDb();
    prisma = makePrismaOverride(db.url);
    await prisma.$connect();
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await db?.stop();
  });

  const newPartner = (code: string) =>
    prisma.client.businessPartner.create({
      data: { code, name: `P-${code}`, isCustomer: true },
    });

  it('a raw update cannot mutate a soft-deleted row (P2025)', async () => {
    const p = await newPartner('SD-UPD');
    await prisma.client.businessPartner.softDelete({ id: p.id }, 'tester');
    await expect(
      prisma.client.businessPartner.update({
        where: { id: p.id },
        data: { name: 'HACKED' },
      }),
    ).rejects.toThrow(); // 0 rows match {id, deletedAt: null} -> P2025
  });

  it('updateMany skips soft-deleted rows (count 0)', async () => {
    const p = await newPartner('SD-UPDM');
    await prisma.client.businessPartner.softDelete({ id: p.id }, 'tester');
    const res = await prisma.client.businessPartner.updateMany({
      where: { id: p.id },
      data: { name: 'HACKED' },
    });
    expect(res.count).toBe(0);
  });

  it('aggregate excludes soft-deleted rows', async () => {
    const before = await prisma.client.businessPartner.aggregate({
      _count: { _all: true },
    });
    const p = await newPartner('SD-AGG');
    const mid = await prisma.client.businessPartner.aggregate({
      _count: { _all: true },
    });
    expect(mid._count._all).toBe(before._count._all + 1);
    await prisma.client.businessPartner.softDelete({ id: p.id }, 'tester');
    const after = await prisma.client.businessPartner.aggregate({
      _count: { _all: true },
    });
    expect(after._count._all).toBe(before._count._all); // deleted one no longer counted
  });

  it('upsert is forbidden on a soft-delete model', async () => {
    await expect(
      prisma.client.businessPartner.upsert({
        where: { id: '00000000-0000-0000-0000-000000000000' },
        create: { code: 'SD-UPS', name: 'x', isCustomer: true },
        update: { name: 'y' },
      }),
    ).rejects.toThrow(/upsert/i);
  });

  it('a live row can still be updated normally', async () => {
    const p = await newPartner('SD-LIVE');
    const updated = await prisma.client.businessPartner.update({
      where: { id: p.id },
      data: { name: 'Renamed' },
    });
    expect(updated.name).toBe('Renamed');
  });
});
