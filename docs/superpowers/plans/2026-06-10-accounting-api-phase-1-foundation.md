# Accounting API — Phase 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a production-ready NestJS + Prisma + PostgreSQL foundation with config, Docker, a `Money` value object, a soft-delete Prisma extension, a consistent error envelope, and JWT authentication with role-based access control.

**Architecture:** A NestJS modular monolith. A single `PrismaService` wraps an extended Prisma client (soft-delete filtering applied globally). Auth uses Passport JWT with access + refresh tokens; RBAC is enforced by a metadata-driven `RolesGuard`. All money arithmetic goes through a `Money` value object backed by `decimal.js`. Integration tests run against a real PostgreSQL via testcontainers — no mocked database for data-access logic.

**Tech Stack:** TypeScript, NestJS 10, Prisma 5+, PostgreSQL, `decimal.js`, `argon2`, `@nestjs/jwt` + `passport-jwt`, `class-validator`/`class-transformer`, `helmet`, `@nestjs/throttler`, `nestjs-pino`, `@nestjs/swagger`, Jest, `@testcontainers/postgresql`.

**Spec:** `docs/superpowers/specs/2026-06-10-indonesian-accounting-api-design.md`

---

## File Structure (Phase 1)

```
accounting-api/
├── package.json
├── tsconfig.json
├── nest-cli.json
├── .gitignore
├── .env.example
├── Dockerfile
├── docker-compose.yml
├── prisma/
│   └── schema.prisma
├── src/
│   ├── main.ts                         # bootstrap: helmet, pino, swagger, validation, shutdown
│   ├── app.module.ts                   # root module wiring
│   ├── config/
│   │   └── env.validation.ts           # validate() for env vars (class-validator)
│   ├── common/
│   │   ├── money/
│   │   │   └── money.ts                # Money value object (decimal.js)
│   │   ├── prisma/
│   │   │   ├── prisma.module.ts
│   │   │   ├── prisma.service.ts       # base client + lifecycle + extended `.client`
│   │   │   └── soft-delete.extension.ts
│   │   ├── errors/
│   │   │   └── domain-errors.ts        # DomainError base + concrete errors
│   │   └── filters/
│   │       └── all-exceptions.filter.ts
│   ├── health/
│   │   └── health.controller.ts        # /health, /ready
│   ├── users/
│   │   ├── users.module.ts
│   │   └── users.service.ts
│   └── auth/
│       ├── auth.module.ts
│       ├── auth.service.ts
│       ├── auth.controller.ts
│       ├── role.enum.ts
│       ├── dto/
│       │   ├── login.dto.ts
│       │   └── refresh.dto.ts
│       ├── strategies/
│       │   └── jwt.strategy.ts
│       ├── guards/
│       │   ├── jwt-auth.guard.ts
│       │   └── roles.guard.ts
│       └── decorators/
│           ├── roles.decorator.ts
│           ├── public.decorator.ts
│           └── current-user.decorator.ts
└── test/
    ├── jest-e2e.json
    ├── testcontainers.ts               # spin Postgres, run migrations, build PrismaService
    ├── health.e2e-spec.ts
    ├── soft-delete.e2e-spec.ts
    └── auth.e2e-spec.ts
```

**Convention locked in for all phases:** services access the database through `prisma.client.<model>` (the soft-delete-extended client), never `prisma.<model>` directly. This is established in Task 4 and used everywhere after.

---

## Task 1: Scaffold NestJS project with strict TypeScript and a health endpoint

**Files:**
- Create: `package.json`, `tsconfig.json`, `nest-cli.json`, `.gitignore`, `src/main.ts`, `src/app.module.ts` (via CLI, then edited)
- Create: `src/health/health.controller.ts`
- Test: `test/health.e2e-spec.ts`, `test/jest-e2e.json`

- [ ] **Step 1: Scaffold the project**

Run (in the empty project root — answer `npm` if prompted for package manager):

```bash
npx --yes @nestjs/cli@latest new . --package-manager npm --skip-git
```

This generates `package.json`, `tsconfig.json`, `nest-cli.json`, `src/`, and `test/`. The repo is already a git repo, hence `--skip-git`.

- [ ] **Step 2: Enable strict TypeScript**

Edit `tsconfig.json` `compilerOptions` to include:

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "declaration": true,
    "removeComments": true,
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true,
    "allowSyntheticDefaultImports": true,
    "target": "ES2021",
    "sourceMap": true,
    "outDir": "./dist",
    "baseUrl": "./",
    "incremental": true,
    "skipLibCheck": true,
    "strict": true,
    "strictNullChecks": true,
    "noImplicitAny": true,
    "forceConsistentCasingInFileNames": true,
    "noFallthroughCasesInSwitch": true
  }
}
```

- [ ] **Step 3: Write the failing e2e test for the health endpoint**

Replace `test/app.e2e-spec.ts` with `test/health.e2e-spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health returns ok', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok' });
  });
});
```

Delete the old `test/app.e2e-spec.ts` if it still exists.

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm run test:e2e`
Expected: FAIL — `GET /health` returns 404 (controller does not exist yet).

- [ ] **Step 5: Implement the health controller**

Create `src/health/health.controller.ts`:

```typescript
import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  check(): { status: string } {
    return { status: 'ok' };
  }
}
```

Edit `src/app.module.ts` to register it and remove the generated `AppController`/`AppService`:

```typescript
import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';

@Module({
  imports: [],
  controllers: [HealthController],
  providers: [],
})
export class AppModule {}
```

Delete `src/app.controller.ts`, `src/app.service.ts`, and `src/app.controller.spec.ts`.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm run test:e2e`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: scaffold NestJS project with strict TS and health endpoint"
```

---

## Task 2: Environment configuration with validation

**Files:**
- Create: `src/config/env.validation.ts`
- Create: `.env.example`
- Modify: `src/app.module.ts`
- Test: `src/config/env.validation.spec.ts`

- [ ] **Step 1: Install config dependencies**

```bash
npm install @nestjs/config class-validator class-transformer
```

- [ ] **Step 2: Write the failing unit test for env validation**

Create `src/config/env.validation.spec.ts`:

```typescript
import { validate } from './env.validation';

const validEnv = {
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  JWT_ACCESS_TTL: '900s',
  JWT_REFRESH_TTL: '7d',
};

describe('env validation', () => {
  it('accepts a valid environment', () => {
    expect(() => validate(validEnv)).not.toThrow();
  });

  it('rejects a missing DATABASE_URL', () => {
    const { DATABASE_URL, ...rest } = validEnv;
    expect(() => validate(rest)).toThrow();
  });

  it('rejects a short JWT secret', () => {
    expect(() => validate({ ...validEnv, JWT_ACCESS_SECRET: 'short' })).toThrow();
  });

  it('coerces PORT to a number', () => {
    const result = validate(validEnv);
    expect(result.PORT).toBe(3000);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- env.validation`
Expected: FAIL — cannot find module `./env.validation`.

- [ ] **Step 4: Implement env validation**

Create `src/config/env.validation.ts`:

```typescript
import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsString,
  MinLength,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

export class EnvVars {
  @IsEnum(NodeEnv)
  NODE_ENV!: NodeEnv;

  @IsInt()
  PORT!: number;

  @IsString()
  DATABASE_URL!: string;

  @IsString()
  @MinLength(32)
  JWT_ACCESS_SECRET!: string;

  @IsString()
  @MinLength(32)
  JWT_REFRESH_SECRET!: string;

  @IsString()
  JWT_ACCESS_TTL!: string;

  @IsString()
  JWT_REFRESH_TTL!: string;
}

export function validate(config: Record<string, unknown>): EnvVars {
  const validated = plainToInstance(EnvVars, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, {
    skipMissingProperties: false,
  });
  if (errors.length > 0) {
    throw new Error(
      `Invalid environment configuration: ${errors.toString()}`,
    );
  }
  return validated;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- env.validation`
Expected: PASS (all 4 cases).

- [ ] **Step 6: Wire ConfigModule into AppModule**

Edit `src/app.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './health/health.controller';
import { validate } from './config/env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate,
    }),
  ],
  controllers: [HealthController],
  providers: [],
})
export class AppModule {}
```

- [ ] **Step 7: Create `.env.example`**

Create `.env.example`:

```
NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://accounting:accounting@localhost:5432/accounting?schema=public
JWT_ACCESS_SECRET=replace-with-a-32+-character-random-secret-value
JWT_REFRESH_SECRET=replace-with-a-different-32+-character-secret
JWT_ACCESS_TTL=900s
JWT_REFRESH_TTL=7d
```

Add `.env` to `.gitignore` (append the line if not present).

- [ ] **Step 8: Run e2e to confirm the app still boots**

The e2e test now needs the env vars. Create `test/setup-env.ts`:

```typescript
process.env.NODE_ENV = 'test';
process.env.PORT = '3000';
process.env.DATABASE_URL ??=
  'postgresql://accounting:accounting@localhost:5432/accounting?schema=public';
process.env.JWT_ACCESS_SECRET = 'a'.repeat(32);
process.env.JWT_REFRESH_SECRET = 'b'.repeat(32);
process.env.JWT_ACCESS_TTL = '900s';
process.env.JWT_REFRESH_TTL = '7d';
```

Edit `test/jest-e2e.json` to add `"setupFiles": ["<rootDir>/setup-env.ts"]` (path relative to the `test/` rootDir).

Run: `npm run test:e2e`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: add validated environment configuration"
```

---

## Task 3: Docker and docker-compose

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `.dockerignore`

- [ ] **Step 1: Create the multi-stage Dockerfile**

Create `Dockerfile`:

```dockerfile
# --- Build stage ---
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build

# --- Production stage ---
FROM node:22-bookworm-slim AS production
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/prisma ./prisma
EXPOSE 3000
CMD ["node", "dist/main.js"]
```

> Note: `prisma generate` is run in Task 4 after the schema exists; this Dockerfile assumes the schema is present, which it will be by the time the image is built.

- [ ] **Step 2: Create `.dockerignore`**

Create `.dockerignore`:

```
node_modules
dist
.git
.env
*.spec.ts
test
docs
```

- [ ] **Step 3: Create docker-compose.yml**

Create `docker-compose.yml`:

```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: accounting
      POSTGRES_PASSWORD: accounting
      POSTGRES_DB: accounting
    ports:
      - '5432:5432'
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U accounting']
      interval: 5s
      timeout: 5s
      retries: 5

  api:
    build: .
    depends_on:
      db:
        condition: service_healthy
    environment:
      NODE_ENV: production
      PORT: 3000
      DATABASE_URL: postgresql://accounting:accounting@db:5432/accounting?schema=public
      JWT_ACCESS_SECRET: ${JWT_ACCESS_SECRET}
      JWT_REFRESH_SECRET: ${JWT_REFRESH_SECRET}
      JWT_ACCESS_TTL: 900s
      JWT_REFRESH_TTL: 7d
    ports:
      - '3000:3000'

volumes:
  pgdata:
```

- [ ] **Step 4: Verify the compose file parses**

Run: `docker compose config`
Expected: prints the resolved configuration with no errors. (Building the image is deferred until the Prisma schema exists.)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: add Dockerfile and docker-compose for self-hosted deploy"
```

---

## Task 4: Prisma setup, User model, and PrismaService

**Files:**
- Create: `prisma/schema.prisma`
- Create: `src/common/prisma/prisma.service.ts`
- Create: `src/common/prisma/prisma.module.ts`
- Modify: `src/app.module.ts`

- [ ] **Step 1: Install Prisma**

```bash
npm install @prisma/client
npm install --save-dev prisma
```

- [ ] **Step 2: Create the Prisma schema with the User model**

Create `prisma/schema.prisma`:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum Role {
  ADMIN
  ACCOUNTANT
  APPROVER
  VIEWER
}

model User {
  id           String    @id @default(uuid())
  email        String
  passwordHash String    @map("password_hash")
  name         String
  role         Role
  isActive     Boolean   @default(true) @map("is_active")
  createdAt    DateTime  @default(now()) @map("created_at")
  updatedAt    DateTime  @updatedAt @map("updated_at")
  deletedAt    DateTime? @map("deleted_at")
  deletedBy    String?   @map("deleted_by")

  @@unique([email], name: "users_email_unique")
  @@index([deletedAt])
  @@map("users")
}
```

> **Identifier reuse after soft delete (spec §9.2):** the spec describes partial unique
> indexes (`WHERE deleted_at IS NULL`). Prisma cannot express partial indexes in the schema
> and would try to drop a raw-SQL one on every later `migrate dev`. We achieve the same
> behavior with a **tombstone pattern**: on soft delete the service rewrites the unique
> field (e.g. `email`) to a dead value, freeing the original for reuse while a plain
> `@@unique` stays in the schema (Prisma-native, `findUnique`-friendly, no migration drift).
> This pattern is reused for account/partner codes in later phases.

- [ ] **Step 3: Apply the migration and generate the client**

Ensure a local Postgres is available (`docker compose up -d db`), then run:

```bash
npx prisma migrate dev --name init_users
```

Expected: creates and applies `prisma/migrations/<timestamp>_init_users/migration.sql`, and regenerates the client.

- [ ] **Step 4: Implement PrismaService and PrismaModule**

Create `src/common/prisma/prisma.service.ts`:

```typescript
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(config: ConfigService) {
    super({
      datasources: { db: { url: config.get<string>('DATABASE_URL') } },
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
```

Create `src/common/prisma/prisma.module.ts`:

```typescript
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
```

> The soft-delete extension and the `.client` accessor are added in Task 7. Until then `PrismaService` is the bare client.

- [ ] **Step 5: Register PrismaModule**

Edit `src/app.module.ts` imports array to add `PrismaModule`:

```typescript
import { PrismaModule } from './common/prisma/prisma.module';
// ...
imports: [
  ConfigModule.forRoot({ isGlobal: true, validate }),
  PrismaModule,
],
```

- [ ] **Step 6: Build to confirm types compile**

Run: `npm run build`
Expected: builds with no type errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add Prisma with User model and PrismaService"
```

---

## Task 5: Integration test harness with testcontainers

**Files:**
- Create: `test/testcontainers.ts`
- Test: `test/prisma-connection.e2e-spec.ts`

- [ ] **Step 1: Install testcontainers**

```bash
npm install --save-dev @testcontainers/postgresql testcontainers
```

- [ ] **Step 2: Write the testcontainers helper**

Create `test/testcontainers.ts`:

```typescript
import { execSync } from 'node:child_process';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { PrismaClient } from '@prisma/client';

export interface TestDb {
  container: StartedPostgreSqlContainer;
  url: string;
  prisma: PrismaClient;
  stop: () => Promise<void>;
}

export async function startTestDb(): Promise<TestDb> {
  const container = await new PostgreSqlContainer('postgres:16').start();
  const url = container.getConnectionUri();

  // Apply the schema to the fresh container.
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });

  const prisma = new PrismaClient({ datasources: { db: { url } } });
  await prisma.$connect();

  return {
    container,
    url,
    prisma,
    stop: async () => {
      await prisma.$disconnect();
      await container.stop();
    },
  };
}
```

- [ ] **Step 3: Write the failing connection test**

Create `test/prisma-connection.e2e-spec.ts`:

```typescript
import { startTestDb, TestDb } from './testcontainers';

describe('Prisma connection (e2e)', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await startTestDb();
  }, 120_000);

  afterAll(async () => {
    await db.stop();
  });

  it('can query the users table on a migrated database', async () => {
    const count = await db.prisma.user.count();
    expect(count).toBe(0);
  });
});
```

- [ ] **Step 4: Run the test**

Run: `npm run test:e2e -- prisma-connection`
Expected: PASS (requires Docker running; first run pulls the postgres image).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test: add testcontainers integration harness"
```

---

## Task 6: Money value object

**Files:**
- Create: `src/common/money/money.ts`
- Test: `src/common/money/money.spec.ts`

- [ ] **Step 1: Install decimal.js**

```bash
npm install decimal.js
```

- [ ] **Step 2: Write the failing unit tests**

Create `src/common/money/money.spec.ts`:

```typescript
import { Money } from './money';

describe('Money', () => {
  it('adds two amounts without floating-point error', () => {
    const result = Money.of('0.1').add(Money.of('0.2'));
    expect(result.toString()).toBe('0.3000');
  });

  it('subtracts amounts', () => {
    expect(Money.of('10').subtract(Money.of('3.5')).toString()).toBe('6.5000');
  });

  it('multiplies by a rate', () => {
    expect(Money.of('1000000').multiply('0.11').toString()).toBe('110000.0000');
  });

  it('rounds to whole rupiah (half-up)', () => {
    expect(Money.of('110000.5').roundToRupiah().toString()).toBe('110001.0000');
    expect(Money.of('110000.4').roundToRupiah().toString()).toBe('110000.0000');
  });

  it('compares amounts', () => {
    expect(Money.of('5').equals(Money.of('5.0000'))).toBe(true);
    expect(Money.of('5').greaterThan(Money.of('4'))).toBe(true);
    expect(Money.of('5').isZero()).toBe(false);
    expect(Money.zero().isZero()).toBe(true);
  });

  it('sums a list', () => {
    expect(
      Money.sum([Money.of('1.10'), Money.of('2.20'), Money.of('3.30')]).toString(),
    ).toBe('6.6000');
    expect(Money.sum([]).toString()).toBe('0.0000');
  });

  it('rejects more than 4 decimal places of precision loss silently — stores 4dp', () => {
    expect(Money.of('1.123456').toString()).toBe('1.1235');
  });

  it('serializes to a 4dp string for persistence', () => {
    expect(Money.of('1234.5').toPersistence()).toBe('1234.5000');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- money`
Expected: FAIL — cannot find module `./money`.

- [ ] **Step 4: Implement the Money value object**

Create `src/common/money/money.ts`:

```typescript
import { Decimal } from 'decimal.js';

const SCALE = 4;

export class Money {
  private readonly value: Decimal;

  private constructor(value: Decimal) {
    this.value = value.toDecimalPlaces(SCALE, Decimal.ROUND_HALF_UP);
  }

  static of(amount: string | number | Decimal): Money {
    return new Money(new Decimal(amount));
  }

  static zero(): Money {
    return new Money(new Decimal(0));
  }

  static sum(amounts: Money[]): Money {
    return amounts.reduce((acc, m) => acc.add(m), Money.zero());
  }

  add(other: Money): Money {
    return new Money(this.value.plus(other.value));
  }

  subtract(other: Money): Money {
    return new Money(this.value.minus(other.value));
  }

  multiply(factor: string | number | Decimal): Money {
    return new Money(this.value.times(new Decimal(factor)));
  }

  roundToRupiah(): Money {
    return new Money(this.value.toDecimalPlaces(0, Decimal.ROUND_HALF_UP));
  }

  equals(other: Money): boolean {
    return this.value.equals(other.value);
  }

  greaterThan(other: Money): boolean {
    return this.value.greaterThan(other.value);
  }

  lessThan(other: Money): boolean {
    return this.value.lessThan(other.value);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  toString(): string {
    return this.value.toFixed(SCALE);
  }

  toPersistence(): string {
    return this.value.toFixed(SCALE);
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- money`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add Money value object backed by decimal.js"
```

---

## Task 7: Soft-delete Prisma extension

**Files:**
- Create: `src/common/prisma/soft-delete.extension.ts`
- Modify: `src/common/prisma/prisma.service.ts`
- Test: `test/soft-delete.e2e-spec.ts`

- [ ] **Step 1: Write the failing integration test**

Create `test/soft-delete.e2e-spec.ts`:

```typescript
import { PrismaClient } from '@prisma/client';
import { startTestDb, TestDb } from './testcontainers';
import { applySoftDelete } from '../src/common/prisma/soft-delete.extension';

describe('Soft delete extension (e2e)', () => {
  let db: TestDb;
  let client: ReturnType<typeof applySoftDelete>;

  beforeAll(async () => {
    db = await startTestDb();
    client = applySoftDelete(db.prisma as PrismaClient);
  }, 120_000);

  afterAll(async () => {
    await db.stop();
  });

  it('hides soft-deleted rows from findMany/findFirst/count', async () => {
    const user = await client.user.create({
      data: {
        email: 'sd1@example.com',
        passwordHash: 'x',
        name: 'SD One',
        role: 'VIEWER',
      },
    });

    await client.user.softDelete({ id: user.id }, 'tester');

    expect(await client.user.findMany({ where: { email: 'sd1@example.com' } })).toEqual([]);
    expect(await client.user.findFirst({ where: { id: user.id } })).toBeNull();
    expect(await client.user.count({ where: { email: 'sd1@example.com' } })).toBe(0);
  });

  it('findUnique returns null for a soft-deleted row', async () => {
    const user = await client.user.create({
      data: {
        email: 'sd2@example.com',
        passwordHash: 'x',
        name: 'SD Two',
        role: 'VIEWER',
      },
    });
    await client.user.softDelete({ id: user.id }, 'tester');
    expect(await client.user.findUnique({ where: { id: user.id } })).toBeNull();
  });

  it('forbids hard delete on a soft-delete model', async () => {
    const user = await client.user.create({
      data: {
        email: 'sd3@example.com',
        passwordHash: 'x',
        name: 'SD Three',
        role: 'VIEWER',
      },
    });
    await expect(client.user.delete({ where: { id: user.id } })).rejects.toThrow(
      /Hard delete forbidden/,
    );
  });
});
```

> Identifier reuse after soft delete (tombstoning) is a service-layer concern and is
> tested in Task 9 (`UsersService`), not at the generic extension layer.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:e2e -- soft-delete`
Expected: FAIL — cannot find module `../src/common/prisma/soft-delete.extension`.

- [ ] **Step 3: Implement the soft-delete extension**

Create `src/common/prisma/soft-delete.extension.ts`:

```typescript
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Models subject to soft delete. Add new soft-deletable models here as later
 * phases introduce them (e.g. 'BusinessPartner', 'TaxCode').
 */
export const SOFT_DELETE_MODELS = new Set<string>(['User']);

function isSoftDelete(model: string | undefined): boolean {
  return !!model && SOFT_DELETE_MODELS.has(model);
}

export function applySoftDelete(base: PrismaClient) {
  return base
    .$extends({
      name: 'soft-delete-filter',
      query: {
        $allModels: {
          async findMany({ model, args, query }) {
            if (isSoftDelete(model)) {
              args.where = { ...args.where, deletedAt: null };
            }
            return query(args);
          },
          async findFirst({ model, args, query }) {
            if (isSoftDelete(model)) {
              args.where = { ...args.where, deletedAt: null };
            }
            return query(args);
          },
          async findFirstOrThrow({ model, args, query }) {
            if (isSoftDelete(model)) {
              args.where = { ...args.where, deletedAt: null };
            }
            return query(args);
          },
          async count({ model, args, query }) {
            if (isSoftDelete(model)) {
              args.where = { ...args.where, deletedAt: null };
            }
            return query(args);
          },
          async delete({ model, query, args }) {
            if (isSoftDelete(model)) {
              throw new Error(
                `Hard delete forbidden on ${model}; use softDelete()`,
              );
            }
            return query(args);
          },
          async deleteMany({ model, query, args }) {
            if (isSoftDelete(model)) {
              throw new Error(
                `Hard delete forbidden on ${model}; use softDeleteMany()`,
              );
            }
            return query(args);
          },
        },
      },
    })
    .$extends({
      name: 'soft-delete-methods',
      model: {
        $allModels: {
          async softDelete<T>(
            this: T,
            where: Record<string, unknown>,
            deletedBy?: string,
          ) {
            const ctx = Prisma.getExtensionContext(this) as unknown as {
              update: (a: unknown) => Promise<unknown>;
            };
            return ctx.update({
              where,
              data: { deletedAt: new Date(), deletedBy },
            });
          },
        },
      },
    });
}

export type ExtendedPrismaClient = ReturnType<typeof applySoftDelete>;
```

> `findUnique`/`findUniqueOrThrow` cannot accept a non-unique `deletedAt` filter, so they are not intercepted at the query layer. The `findUnique` test passes because consumers that must respect soft-delete use `findFirst`; for the `findUnique` case in the test, add the redirect below.

- [ ] **Step 4: Add findUnique soft-delete handling**

Add these two handlers inside the `query.$allModels` block of the first `$extends` (after `count`):

```typescript
          async findUnique({ model, args, query }) {
            if (isSoftDelete(model)) {
              const found = await query(args);
              return found && (found as { deletedAt?: Date | null }).deletedAt
                ? null
                : found;
            }
            return query(args);
          },
          async findUniqueOrThrow({ model, args, query }) {
            const found = await query(args);
            if (
              isSoftDelete(model) &&
              found &&
              (found as { deletedAt?: Date | null }).deletedAt
            ) {
              throw new Prisma.PrismaClientKnownRequestError('No record found', {
                code: 'P2025',
                clientVersion: Prisma.prismaVersion.client,
              });
            }
            return found;
          },
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test:e2e -- soft-delete`
Expected: PASS (all 4 cases).

- [ ] **Step 6: Wire the extension into PrismaService**

Replace `src/common/prisma/prisma.service.ts`:

```typescript
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import {
  applySoftDelete,
  ExtendedPrismaClient,
} from './soft-delete.extension';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  /** Soft-delete-extended client. Always use this for data access. */
  readonly client: ExtendedPrismaClient;

  constructor(config: ConfigService) {
    super({
      datasources: { db: { url: config.get<string>('DATABASE_URL') } },
    });
    this.client = applySoftDelete(this);
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
```

- [ ] **Step 7: Build to confirm types compile**

Run: `npm run build`
Expected: builds with no type errors.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add global soft-delete Prisma extension"
```

---

## Task 8: Domain errors and global exception filter

**Files:**
- Create: `src/common/errors/domain-errors.ts`
- Create: `src/common/filters/all-exceptions.filter.ts`
- Modify: `src/main.ts`
- Test: `src/common/filters/all-exceptions.filter.spec.ts`

- [ ] **Step 1: Implement domain errors**

Create `src/common/errors/domain-errors.ts`:

```typescript
export abstract class DomainError extends Error {
  abstract readonly code: string;
  /** HTTP status this error maps to. */
  abstract readonly status: number;

  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationFailedError extends DomainError {
  readonly code = 'VALIDATION_FAILED';
  readonly status = 422;
}

export class NotFoundDomainError extends DomainError {
  readonly code = 'NOT_FOUND';
  readonly status = 404;
}

export class ConflictDomainError extends DomainError {
  readonly code = 'CONFLICT';
  readonly status = 409;
}

export class UnauthorizedDomainError extends DomainError {
  readonly code = 'UNAUTHORIZED';
  readonly status = 401;
}

export class ForbiddenDomainError extends DomainError {
  readonly code = 'FORBIDDEN';
  readonly status = 403;
}
```

- [ ] **Step 2: Write the failing unit test for the filter**

Create `src/common/filters/all-exceptions.filter.spec.ts`:

```typescript
import { ArgumentsHost, HttpException } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { ConflictDomainError } from '../errors/domain-errors';

function mockHost(): { host: ArgumentsHost; payload: () => unknown; code: () => number } {
  let body: unknown;
  let statusCode = 0;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(b: unknown) {
      body = b;
      return this;
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => ({ url: '/test', id: 'req-1' }),
    }),
  } as unknown as ArgumentsHost;
  return { host, payload: () => body, code: () => statusCode };
}

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();

  it('maps a DomainError to its status and code', () => {
    const m = mockHost();
    filter.catch(new ConflictDomainError('email taken', { email: 'a@b.c' }), m.host);
    expect(m.code()).toBe(409);
    expect(m.payload()).toMatchObject({
      code: 'CONFLICT',
      message: 'email taken',
      details: { email: 'a@b.c' },
    });
  });

  it('maps a NestJS HttpException', () => {
    const m = mockHost();
    filter.catch(new HttpException('nope', 400), m.host);
    expect(m.code()).toBe(400);
    expect(m.payload()).toMatchObject({ code: 'HTTP_400', message: 'nope' });
  });

  it('maps an unknown error to 500 without leaking internals', () => {
    const m = mockHost();
    filter.catch(new Error('boom secret'), m.host);
    expect(m.code()).toBe(500);
    expect(m.payload()).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- all-exceptions`
Expected: FAIL — cannot find module `./all-exceptions.filter`.

- [ ] **Step 4: Implement the filter**

Create `src/common/filters/all-exceptions.filter.ts`:

```typescript
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { DomainError } from '../errors/domain-errors';

interface ErrorEnvelope {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();

    let status = 500;
    let envelope: ErrorEnvelope = {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    };

    if (exception instanceof DomainError) {
      status = exception.status;
      envelope = {
        code: exception.code,
        message: exception.message,
        details: exception.details,
      };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      envelope = {
        code: `HTTP_${status}`,
        message:
          typeof res === 'string'
            ? res
            : ((res as { message?: string | string[] }).message?.toString() ??
              exception.message),
      };
    } else {
      this.logger.error(exception);
    }

    response.status(status).json(envelope);
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- all-exceptions`
Expected: PASS (all 3 cases).

- [ ] **Step 6: Register the filter globally**

Edit `src/main.ts` `bootstrap()` to add (full wiring completed in Task 12):

```typescript
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
// inside bootstrap(), after `const app = await NestFactory.create(AppModule);`
app.useGlobalFilters(new AllExceptionsFilter());
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add domain errors and global exception filter"
```

---

## Task 9: Users module

**Files:**
- Create: `src/users/users.service.ts`
- Create: `src/users/users.module.ts`
- Test: `test/users.e2e-spec.ts`

- [ ] **Step 1: Install argon2**

```bash
npm install argon2
```

- [ ] **Step 2: Write the failing integration test**

Create `test/users.e2e-spec.ts`:

```typescript
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { UsersService } from '../src/users/users.service';
import { ConflictDomainError } from '../src/common/errors/domain-errors';
import { startTestDb, TestDb } from './testcontainers';

describe('UsersService (e2e)', () => {
  let db: TestDb;
  let prisma: PrismaService;
  let users: UsersService;

  beforeAll(async () => {
    db = await startTestDb();
    const config = { get: () => db.url } as unknown as ConfigService;
    prisma = new PrismaService(config);
    await prisma.$connect();
    users = new UsersService(prisma);
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await db.stop();
  });

  it('creates a user with a hashed password', async () => {
    const user = await users.create({
      email: 'a@example.com',
      password: 'secret123',
      name: 'Alice',
      role: 'ACCOUNTANT',
    });
    expect(user.email).toBe('a@example.com');
    expect((user as { passwordHash?: string }).passwordHash).toBeUndefined();
  });

  it('verifies a correct password and rejects a wrong one', async () => {
    const found = await users.findByEmailWithHash('a@example.com');
    expect(found).not.toBeNull();
    expect(await users.verifyPassword(found!, 'secret123')).toBe(true);
    expect(await users.verifyPassword(found!, 'wrong')).toBe(false);
  });

  it('rejects a duplicate active email', async () => {
    await expect(
      users.create({
        email: 'a@example.com',
        password: 'x12345678',
        name: 'Dup',
        role: 'VIEWER',
      }),
    ).rejects.toBeInstanceOf(ConflictDomainError);
  });

  it('soft-deletes a user', async () => {
    const user = await users.create({
      email: 'del@example.com',
      password: 'x12345678',
      name: 'Del',
      role: 'VIEWER',
    });
    await users.softDelete(user.id, 'admin-id');
    expect(await users.findByEmail('del@example.com')).toBeNull();
  });

  it('allows reusing a soft-deleted email (tombstone)', async () => {
    const first = await users.create({
      email: 'reuse@example.com',
      password: 'x12345678',
      name: 'First',
      role: 'VIEWER',
    });
    await users.softDelete(first.id, 'admin-id');
    const second = await users.create({
      email: 'reuse@example.com',
      password: 'x12345678',
      name: 'Second',
      role: 'VIEWER',
    });
    expect(second.id).not.toBe(first.id);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run test:e2e -- users`
Expected: FAIL — cannot find module `../src/users/users.service`.

- [ ] **Step 4: Implement UsersService**

Create `src/users/users.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { Role, User } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  ConflictDomainError,
  NotFoundDomainError,
} from '../common/errors/domain-errors';

export interface CreateUserInput {
  email: string;
  password: string;
  name: string;
  role: Role;
}

type SafeUser = Omit<User, 'passwordHash'>;

function stripHash(user: User): SafeUser {
  const { passwordHash: _omit, ...rest } = user;
  return rest;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateUserInput): Promise<SafeUser> {
    const existing = await this.prisma.client.user.findFirst({
      where: { email: input.email },
    });
    if (existing) {
      throw new ConflictDomainError('A user with this email already exists', {
        email: input.email,
      });
    }
    const passwordHash = await argon2.hash(input.password);
    const created = await this.prisma.client.user.create({
      data: {
        email: input.email,
        passwordHash,
        name: input.name,
        role: input.role,
      },
    });
    return stripHash(created);
  }

  async findByEmail(email: string): Promise<SafeUser | null> {
    const user = await this.prisma.client.user.findFirst({ where: { email } });
    return user ? stripHash(user) : null;
  }

  async findByEmailWithHash(email: string): Promise<User | null> {
    return this.prisma.client.user.findFirst({ where: { email } });
  }

  async findById(id: string): Promise<SafeUser | null> {
    const user = await this.prisma.client.user.findFirst({ where: { id } });
    return user ? stripHash(user) : null;
  }

  async verifyPassword(user: User, password: string): Promise<boolean> {
    return argon2.verify(user.passwordHash, password);
  }

  async softDelete(id: string, deletedBy: string): Promise<void> {
    const user = await this.prisma.client.user.findFirst({ where: { id } });
    if (!user) {
      throw new NotFoundDomainError('User not found', { id });
    }
    // Tombstone the unique email so it can be reused, and mark soft-deleted.
    await this.prisma.client.user.update({
      where: { id },
      data: {
        email: `${user.email}#deleted-${id}`,
        deletedAt: new Date(),
        deletedBy,
      },
    });
  }
}
```

Create `src/users/users.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { UsersService } from './users.service';

@Module({
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test:e2e -- users`
Expected: PASS (all 4 cases).

- [ ] **Step 6: Register UsersModule**

Edit `src/app.module.ts` imports array to add `UsersModule`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add users service with argon2 hashing and soft delete"
```

---

## Task 10: JWT authentication

**Files:**
- Create: `src/auth/role.enum.ts`, `src/auth/dto/login.dto.ts`, `src/auth/dto/refresh.dto.ts`
- Create: `src/auth/strategies/jwt.strategy.ts`
- Create: `src/auth/guards/jwt-auth.guard.ts`
- Create: `src/auth/decorators/public.decorator.ts`, `src/auth/decorators/current-user.decorator.ts`
- Create: `src/auth/auth.service.ts`, `src/auth/auth.controller.ts`, `src/auth/auth.module.ts`
- Test: `test/auth.e2e-spec.ts`

- [ ] **Step 1: Install auth dependencies**

```bash
npm install @nestjs/jwt @nestjs/passport passport passport-jwt
npm install --save-dev @types/passport-jwt
```

- [ ] **Step 2: Create the Role enum and DTOs**

Create `src/auth/role.enum.ts`:

```typescript
import { Role } from '@prisma/client';

export { Role };
export const ALL_ROLES: Role[] = ['ADMIN', 'ACCOUNTANT', 'APPROVER', 'VIEWER'];
```

Create `src/auth/dto/login.dto.ts`:

```typescript
import { IsEmail, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}
```

Create `src/auth/dto/refresh.dto.ts`:

```typescript
import { IsString } from 'class-validator';

export class RefreshDto {
  @IsString()
  refreshToken!: string;
}
```

- [ ] **Step 3: Create the JWT payload type, strategy, decorators, and guard**

Create `src/auth/strategies/jwt.strategy.ts`:

```typescript
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Role } from '../role.enum';

export interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: Role;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_ACCESS_SECRET') as string,
    });
  }

  validate(payload: JwtPayload): AuthenticatedUser {
    if (!payload?.sub) {
      throw new UnauthorizedException();
    }
    return { id: payload.sub, email: payload.email, role: payload.role };
  }
}
```

Create `src/auth/decorators/public.decorator.ts`:

```typescript
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
```

Create `src/auth/decorators/current-user.decorator.ts`:

```typescript
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthenticatedUser } from '../strategies/jwt.strategy';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    return ctx.switchToHttp().getRequest().user as AuthenticatedUser;
  },
);
```

Create `src/auth/guards/jwt-auth.guard.ts`:

```typescript
import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }
    return super.canActivate(context);
  }
}
```

- [ ] **Step 4: Implement AuthService**

Create `src/auth/auth.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';
import { UnauthorizedDomainError } from '../common/errors/domain-errors';
import { AuthenticatedUser, JwtPayload } from './strategies/jwt.strategy';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async login(email: string, password: string): Promise<TokenPair> {
    const user = await this.users.findByEmailWithHash(email);
    if (!user || !user.isActive) {
      throw new UnauthorizedDomainError('Invalid credentials');
    }
    const valid = await this.users.verifyPassword(user, password);
    if (!valid) {
      throw new UnauthorizedDomainError('Invalid credentials');
    }
    return this.issueTokens({ id: user.id, email: user.email, role: user.role });
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(refreshToken, {
        secret: this.config.get<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedDomainError('Invalid refresh token');
    }
    const user = await this.users.findById(payload.sub);
    if (!user || !user.isActive) {
      throw new UnauthorizedDomainError('Invalid refresh token');
    }
    return this.issueTokens({ id: user.id, email: user.email, role: user.role });
  }

  private async issueTokens(user: AuthenticatedUser): Promise<TokenPair> {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };
    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.get<string>('JWT_ACCESS_SECRET'),
      expiresIn: this.config.get<string>('JWT_ACCESS_TTL'),
    });
    const refreshToken = await this.jwt.signAsync(payload, {
      secret: this.config.get<string>('JWT_REFRESH_SECRET'),
      expiresIn: this.config.get<string>('JWT_REFRESH_TTL'),
    });
    return { accessToken, refreshToken };
  }
}
```

- [ ] **Step 5: Implement AuthController and AuthModule**

Create `src/auth/auth.controller.ts`:

```typescript
import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { AuthService, TokenPair } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { Public } from './decorators/public.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { AuthenticatedUser } from './strategies/jwt.strategy';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto): Promise<TokenPair> {
    return this.auth.login(dto.email, dto.password);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto): Promise<TokenPair> {
    return this.auth.refresh(dto.refreshToken);
  }

  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }
}
```

Create `src/auth/auth.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { UsersModule } from '../users/users.module';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [UsersModule, PassportModule, JwtModule.register({})],
  providers: [AuthService, JwtStrategy],
  controllers: [AuthController],
  exports: [AuthService],
})
export class AuthModule {}
```

- [ ] **Step 6: Register AuthModule and JwtAuthGuard globally**

Edit `src/app.module.ts` to add `AuthModule` to imports and register the guard globally via `APP_GUARD`:

```typescript
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
// ...
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate }),
    PrismaModule,
    UsersModule,
    AuthModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }],
})
export class AppModule {}
```

Mark the health controller public — add `@Public()` to `HealthController` methods (import from `../auth/decorators/public.decorator`), or annotate the class. Add `@Public()` above the `check()` method.

- [ ] **Step 7: Write the failing auth e2e test**

Create `test/auth.e2e-spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { UsersService } from '../src/users/users.service';
import { startTestDb, TestDb } from './testcontainers';

describe('Auth (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.url;

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    const users = app.get(UsersService);
    await users.create({
      email: 'login@example.com',
      password: 'secret123',
      name: 'Login',
      role: 'ACCOUNTANT',
    });
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await app.get(PrismaService).$disconnect();
    await db.stop();
  });

  it('rejects login with wrong password (401)', () => {
    return request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'login@example.com', password: 'wrongpass' })
      .expect(401);
  });

  it('logs in and accesses a protected route', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'login@example.com', password: 'secret123' })
      .expect(200);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();

    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${res.body.accessToken}`)
      .expect(200)
      .expect((r) => {
        expect(r.body.email).toBe('login@example.com');
        expect(r.body.role).toBe('ACCOUNTANT');
      });
  });

  it('blocks a protected route without a token (401)', () => {
    return request(app.getHttpServer()).get('/auth/me').expect(401);
  });
});
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npm run test:e2e -- auth`
Expected: PASS (all 3 cases). Fix wiring if any fail.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: add JWT authentication with login and refresh"
```

---

## Task 11: Role-based access control

**Files:**
- Create: `src/auth/decorators/roles.decorator.ts`
- Create: `src/auth/guards/roles.guard.ts`
- Modify: `src/app.module.ts` (register RolesGuard globally after JwtAuthGuard)
- Test: `test/rbac.e2e-spec.ts`

- [ ] **Step 1: Create the Roles decorator**

Create `src/auth/decorators/roles.decorator.ts`:

```typescript
import { SetMetadata } from '@nestjs/common';
import { Role } from '../role.enum';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
```

- [ ] **Step 2: Implement the RolesGuard**

Create `src/auth/guards/roles.guard.ts`:

```typescript
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { Role } from '../role.enum';
import { AuthenticatedUser } from '../strategies/jwt.strategy';
import { ForbiddenDomainError } from '../../common/errors/domain-errors';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) {
      return true;
    }
    const user = context.switchToHttp().getRequest().user as
      | AuthenticatedUser
      | undefined;
    if (!user || !required.includes(user.role)) {
      throw new ForbiddenDomainError('Insufficient role', {
        required,
        actual: user?.role,
      });
    }
    return true;
  }
}
```

- [ ] **Step 3: Register RolesGuard globally**

Edit `src/app.module.ts` providers to add it after the JwtAuthGuard (order matters — auth runs first):

```typescript
import { RolesGuard } from './auth/guards/roles.guard';
// ...
providers: [
  { provide: APP_GUARD, useClass: JwtAuthGuard },
  { provide: APP_GUARD, useClass: RolesGuard },
],
```

- [ ] **Step 4: Add a temporary admin-only test route**

To exercise RBAC, add an admin-only route to `AuthController`:

```typescript
import { Roles } from './decorators/roles.decorator';
import { Role } from './role.enum';
// ...
  @Roles(Role.ADMIN)
  @Get('admin-only')
  adminOnly(): { ok: boolean } {
    return { ok: true };
  }
```

- [ ] **Step 5: Write the failing RBAC e2e test**

Create `test/rbac.e2e-spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { UsersService } from '../src/users/users.service';
import { AuthService } from '../src/auth/auth.service';
import { startTestDb, TestDb } from './testcontainers';

describe('RBAC (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let adminToken: string;
  let viewerToken: string;

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.url;

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    const users = app.get(UsersService);
    const auth = app.get(AuthService);
    await users.create({ email: 'admin@x.com', password: 'secret123', name: 'A', role: 'ADMIN' });
    await users.create({ email: 'viewer@x.com', password: 'secret123', name: 'V', role: 'VIEWER' });
    adminToken = (await auth.login('admin@x.com', 'secret123')).accessToken;
    viewerToken = (await auth.login('viewer@x.com', 'secret123')).accessToken;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await app.get(PrismaService).$disconnect();
    await db.stop();
  });

  it('allows an ADMIN to access an admin-only route', () => {
    return request(app.getHttpServer())
      .get('/auth/admin-only')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });

  it('forbids a VIEWER from an admin-only route (403)', () => {
    return request(app.getHttpServer())
      .get('/auth/admin-only')
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(403)
      .expect((r) => expect(r.body.code).toBe('FORBIDDEN'));
  });
});
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm run test:e2e -- rbac`
Expected: PASS (both cases).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add role-based access control guard"
```

---

## Task 12: Production hardening and observability wiring

**Files:**
- Modify: `src/main.ts`
- Modify: `src/app.module.ts` (ThrottlerModule + global ThrottlerGuard, LoggerModule)
- Modify: `src/health/health.controller.ts` (add `/ready`)
- Test: `test/hardening.e2e-spec.ts`

- [ ] **Step 1: Install hardening dependencies**

```bash
npm install helmet @nestjs/throttler nestjs-pino pino-http @nestjs/swagger
```

- [ ] **Step 2: Add a readiness endpoint that checks the database**

Replace `src/health/health.controller.ts`:

```typescript
import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { Public } from '../auth/decorators/public.decorator';

@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('health')
  liveness(): { status: string } {
    return { status: 'ok' };
  }

  @Public()
  @Get('ready')
  async readiness(): Promise<{ status: string; db: string }> {
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: 'ok', db: 'up' };
  }
}
```

- [ ] **Step 3: Wire ThrottlerModule and LoggerModule into AppModule**

Edit `src/app.module.ts`:

```typescript
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
// add to imports array:
    LoggerModule.forRoot({
      pinoHttp: {
        autoLogging: true,
        redact: ['req.headers.authorization'],
      },
    }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
// add to providers array (before the auth guards so it runs first):
    { provide: APP_GUARD, useClass: ThrottlerGuard },
```

Final providers order: `ThrottlerGuard`, then `JwtAuthGuard`, then `RolesGuard`.

- [ ] **Step 4: Complete main.ts bootstrap wiring**

Replace `src/main.ts`:

```typescript
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.use(helmet());
  app.enableCors({ origin: process.env.CORS_ORIGIN?.split(',') ?? false });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Indonesian Accounting API')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup(
    'docs',
    app,
    SwaggerModule.createDocument(app, swaggerConfig),
  );

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
```

- [ ] **Step 5: Write the hardening e2e test**

Create `test/hardening.e2e-spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import helmet from 'helmet';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { startTestDb, TestDb } from './testcontainers';

describe('Hardening (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;

  beforeAll(async () => {
    db = await startTestDb();
    process.env.DATABASE_URL = db.url;
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(helmet());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await app.get(PrismaService).$disconnect();
    await db.stop();
  });

  it('GET /ready reports the database is up', () => {
    return request(app.getHttpServer())
      .get('/ready')
      .expect(200)
      .expect((r) => expect(r.body.db).toBe('up'));
  });

  it('sets security headers via helmet', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect((r) => expect(r.headers['x-dns-prefetch-control']).toBeDefined());
  });

  it('rejects unknown body properties (400)', () => {
    return request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'a@b.com', password: 'secret123', injected: 'x' })
      .expect(400);
  });
});
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm run test:e2e -- hardening`
Expected: PASS (all 3 cases).

- [ ] **Step 7: Run the full test suite**

Run: `npm test && npm run test:e2e`
Expected: all unit and e2e suites PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add security hardening, structured logging, readiness, and OpenAPI"
```

---

## Phase 1 Definition of Done

- [ ] `npm run build` succeeds with strict TypeScript.
- [ ] `npm test` (unit) and `npm run test:e2e` (integration via testcontainers) both pass.
- [ ] `docker compose config` validates; the image builds.
- [ ] Login issues access + refresh tokens; protected routes reject anonymous and wrong-role callers.
- [ ] Soft delete hides rows globally and forbids hard delete on soft-delete models.
- [ ] `Money` arithmetic is exact (no floating point) with 4dp storage and rupiah rounding.
- [ ] `/health`, `/ready`, and `/docs` (OpenAPI) respond.
- [ ] Errors return the consistent `{ code, message, details }` envelope.

## Notes for later phases (not implemented here)

- Add new soft-deletable models to `SOFT_DELETE_MODELS` in `soft-delete.extension.ts` as they are introduced (`BusinessPartner`, `TaxCode`, `Account` for master-data; draft documents).
- The `audit_log` table and audit interceptor land in Phase 6; Phase 1 leaves hooks (the error envelope and `CurrentUser`) it will build on.
- Account/journal models, `PostingService`, and the SAK chart-of-accounts seed are Phase 2.
- The optional segregation-of-duties flag (creator ≠ poster) is enforced in Phase 2/4 where posting endpoints exist, reusing `CurrentUser` and `Roles`.
