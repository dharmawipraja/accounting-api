import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/common/prisma/prisma.service';

/**
 * Builds a PrismaService pointed at a testcontainer URL. NestJS freezes
 * ConfigModule's view of process.env at require() time, so e2e tests override
 * PrismaService rather than mutating process.env.DATABASE_URL. Non-DATABASE_URL
 * keys (JWT secrets/TTLs from setup-env.ts) fall through to process.env.
 */
export function makePrismaOverride(url: string): PrismaService {
  const mockConfig = {
    getOrThrow: (key: string) =>
      key === 'DATABASE_URL' ? url : (process.env[key] as string),
    get: (key: string) => (key === 'DATABASE_URL' ? url : process.env[key]),
  } as unknown as ConfigService;
  return new PrismaService(mockConfig);
}
