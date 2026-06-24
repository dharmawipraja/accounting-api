# An e2e bootstrap factory (bootstrapTestApp)

**Date:** 2026-06-24
**Status:** Approved (design) — ready for implementation plan
**Origin:** Architecture review round-4 candidate **T1** (test-harness deepening), folding in **T2** (production-fidelity pipe gap).

## Vocabulary

Architecture terms per the `improve-codebase-architecture` skill: **module, interface, implementation,
depth, seam, adapter, leverage, locality.** Domain terms per `CONTEXT.md` / `docs/runbooks/domain-glossary.md`.

---

## 1. Problem

All **37 e2e specs** that call `Test.createTestingModule` hand-write the same ~10-line bootstrap skeleton:

1. `startTestDb()` → `makePrismaOverride(db.url)` → `prisma.$connect()`
2. `Test.createTestingModule({ imports: [AppModule] }).overrideProvider(PrismaService).useValue(prisma).compile()`
3. `mod.createNestApplication()` → `app.enableVersioning({ type: URI, defaultVersion: '1' })`
4. `app.useGlobalPipes(new ValidationPipe({ … }))` (30 specs) + `app.useGlobalFilters(new AllExceptionsFilter())`
5. `await app.init()`
6. `afterAll`: `app.close()` → `prisma.$disconnect()` → `db.stop()`

Steps 1–3 and 6 are **letter-for-letter identical** in all 37 (verified: 37 use `createTestingModule`, 37 set
`enableVersioning`, all override **only** `PrismaService`). The inlined skeleton has already caused a silent
regression once (when `main.ts` began requiring `enableVersioning`, specs only passed because each happened to
set it). Two real variations exist, and nothing else:

- **7 specs run no `ValidationPipe`** (service-layer tests): `balances-soft-delete-filter`, `close`,
  `close-out-of-order`, `close-reversal-guard`, `health`, `posting`, `posting-toctou`.
- **1 spec adds middleware**: `hardening` calls `app.use(helmet())`.

**The fidelity gap (T2):** `main.ts` ships `ValidationPipe({ whitelist:true, transform:true, forbidNonWhitelisted:true })`,
but only **5 of the 30** pipe-using specs set `forbidNonWhitelisted`. The other **25 run a more permissive pipe than
production** — they silently accept unknown request fields that prod rejects with 400. Invisible precisely because
the pipe config is inlined per spec with no canonical reference.

## 2. Goal

Extract one `bootstrapTestApp()` factory — the single place that defines "what the app under test looks like,"
mirroring `main.ts`. **Locality:** the skeleton + the canonical middleware stack live once. **Leverage:** a new
spec is one call; it is structurally impossible to omit `enableVersioning`/teardown or to drift from the prod pipe.

## 3. Scope

**In scope**
- New `bootstrapTestApp(opts?)` in `test/e2e-helpers.ts` (beside `makePrismaOverride`), returning
  `{ app, prisma, db, cleanup }`.
- Migrate all **37** specs to call it; `afterAll(cleanup)`.
- **Fold in T2:** the factory's default pipe is the canonical, prod-faithful one
  (`whitelist + transform + forbidNonWhitelisted`). The 25 lax specs are thereby flipped to the prod pipe.

**One deliberate behavior change (T2)**
- The 25 specs that omitted `forbidNonWhitelisted` now run the prod pipe. Any spec that sends an unknown request
  field will now get 400 where it previously passed — **that breakage IS the fidelity gap surfacing**; fix that
  spec's payload (it was sending data prod rejects). If none break, the gap is closed for free.

**Out of scope (explicitly)**
- Production `src/` is untouched (this is test-only). `main.ts` is the reference, not edited.
- Per-spec **seeding** (`seedIfEmpty`/`generatePeriods`/tax seeds), login/token acquisition, and account-id
  lookups stay in each spec's `beforeAll` — they vary per spec and are NOT part of the factory.
- The 4 specs without `createTestingModule` (`prisma-connection`, `soft-delete`, `soft-delete-hardening`,
  `db-runtime-config`) are not migrated (they don't bootstrap the full app).
- No new test cases beyond a smoke test for the factory.

## 4. The factory

`test/e2e-helpers.ts` (adds to the existing `makePrismaOverride`):

```ts
import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { startTestDb, TestDb } from './testcontainers';

export interface TestApp {
  app: INestApplication;
  prisma: PrismaService;
  db: TestDb;
  /** Tear down in afterAll: app.close → prisma.$disconnect → db.stop. */
  cleanup: () => Promise<void>;
}

/**
 * Boots the full app against a fresh testcontainer DB, mirroring `main.ts`'s
 * middleware stack. The single source for the e2e bootstrap skeleton.
 *
 * @param opts.pipe       false to skip the ValidationPipe (service-layer specs that
 *                        don't exercise DTO validation). Default true → the canonical
 *                        prod pipe (whitelist + transform + forbidNonWhitelisted).
 * @param opts.configure  pre-init hook for extra middleware (e.g. helmet).
 */
export async function bootstrapTestApp(
  opts: {
    pipe?: boolean;
    configure?: (app: INestApplication) => void;
  } = {},
): Promise<TestApp> {
  const db = await startTestDb();
  const prisma = makePrismaOverride(db.url);
  await prisma.$connect();
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .compile();
  const app = mod.createNestApplication();
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  if (opts.pipe !== false) {
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
  }
  app.useGlobalFilters(new AllExceptionsFilter());
  opts.configure?.(app);
  await app.init();
  const cleanup = async () => {
    await app.close();
    await prisma.$disconnect();
    await db.stop();
  };
  return { app, prisma, db, cleanup };
}
```

## 5. Migration (37 specs)

Per spec, the bootstrap block + `afterAll` teardown collapse to:
```ts
let app: INestApplication, prisma: PrismaService /* , db if used */;
let cleanup: () => Promise<void>;
beforeAll(async () => {
  ({ app, prisma, cleanup } = await bootstrapTestApp(/* opts */));
  // …unchanged per-spec seeding / login / account lookups…
}, 120_000);
afterAll(() => cleanup());
```

**The migration rule (mechanically determinable):**
- Spec currently has `new ValidationPipe(...)` (30 specs) → `bootstrapTestApp()` (canonical pipe default). This
  flips the 25 lax ones to the prod pipe (T2).
- Spec currently has **no** `ValidationPipe` (the 7 listed in §1) → `bootstrapTestApp({ pipe: false })`.
- `hardening` additionally → `bootstrapTestApp({ configure: (a) => a.use(helmet()) })`.

Whatever local names a spec used (`db`, `moduleRef`, etc.) map onto the returned fields; specs that don't
reference `db`/`prisma` directly just destructure what they use.

## 6. Error handling

None introduced. `cleanup()` runs the same teardown in the same order. The factory throws only what the current
inline bootstrap throws (DB start / app init failures).

## 7. Testing & the pipe-flip triage

- **New smoke spec** (`test/bootstrap-test-app.e2e-spec.ts` or a case in an existing harness spec): boot via the
  factory, assert `GET /health` (or `/metrics`) responds and `cleanup()` resolves — proves the factory wires the
  app end to end.
- **The full e2e suite is the migration gate.** Run it after migrating; the **only** expected change is T2: a spec
  that sent an unknown field now 400s. Triage each failure: it is a test sending data prod rejects → fix the
  payload (that is the fidelity gap, now closed). Log every such fix. If the suite is green with no payload
  changes, the gap was latent-only and is now closed for the future at zero cost.
- All 209 e2e must pass at the end; unit suite (194) unaffected (test-only change).

## 8. Verification & migration

- Branch `feat/e2e-bootstrap-factory` off `main`. Suggested commits: (1) the factory + smoke test; (2) migrate
  specs in batches; (3) any pipe-flip payload fixes (separable, so the fidelity-gap fixes are auditable).
- Gate: `npm run verify` — typecheck (0), `lint:ci` (clean), `test` (194 unit), `test:e2e:cov` (all e2e pass +
  coverage ≥ 84/62/84/84).
- Sanity diff vs `main`: `e2e-helpers.ts` (+factory), 37 `*.e2e-spec.ts` (net reduction), a smoke spec, plus this
  spec. No `src/` change.

## 9. Risks

- **Behavior change is test-only** — no production code touched; the suite is the safety net, so there is no prod
  risk. The pipe flip can only make tests *stricter* (reject unknown fields), never looser.
- **Volume (37 files).** Mechanical but voluminous → execute via the subagent-driven pipeline (a focused
  implementer migrates in batches; the suite gates each batch).
- **Factory hiding intentional divergence** — mitigated by the explicit `pipe`/`configure` options and a default
  that mirrors `main.ts` (documented on the function).
- **Cross-test bleed** — a non-issue: each spec still gets its own `TestDb` container + `prisma` instance; the
  factory shares no state between spec files.
