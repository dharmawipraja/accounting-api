# e2e bootstrapTestApp() Factory — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the ~10-line e2e bootstrap skeleton repeated across 37 specs into one `bootstrapTestApp()` in `test/e2e-helpers.ts` whose default middleware mirrors `main.ts`, folding in the T2 fidelity fix (25 specs ran a more permissive `ValidationPipe` than production).

**Architecture:** A factory returns `{ app, prisma, db, cleanup }`. Specs collapse to one call + `afterAll(cleanup)`. The default pipe is the canonical prod pipe (`whitelist + transform + forbidNonWhitelisted`); `{ pipe: false }` opts out (service-layer specs); a `configure` hook adds middleware (helmet). Test-only — no `src/` change.

**Tech Stack:** NestJS 11 testing (`Test.createTestingModule`), Prisma 7, Jest e2e, testcontainers, supertest.

**Spec:** `docs/superpowers/specs/2026-06-24-e2e-bootstrap-factory-design.md`

## Global Constraints

- **Test-only.** No `src/` file changes. `main.ts` is the reference for the canonical pipe, not edited.
- **Canonical pipe = `new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true })`** — verbatim from `main.ts:52-54`. This is the factory's default.
- **One deliberate behavior change (T2):** the 25 specs that currently omit `forbidNonWhitelisted` get the canonical pipe. A spec that breaks was sending an unknown field prod rejects → fix that spec's payload; commit those fixes **separately** from the mechanical migration so they're auditable.
- **Per-spec seeding / login / account-id lookups stay in each spec's `beforeAll`** — NOT moved into the factory.
- **Each spec keeps its own `TestDb` + `prisma`** (the factory shares no state across specs) — no cross-test bleed.
- **All 209 e2e must pass; 194 unit unaffected.** Gate: `npm run verify` (coverage ≥ 84/62/84/84).
- **The 4 non-bootstrap specs are NOT migrated:** `prisma-connection`, `soft-delete`, `soft-delete-hardening`, `db-runtime-config` (they don't call `createTestingModule`).
- **Branch:** `feat/e2e-bootstrap-factory` (already created off `main` at `b2cce4e`).

---

## File Structure

**Create**
- `test/bootstrap-test-app.e2e-spec.ts` — smoke test for the factory.

**Modify**
- `test/e2e-helpers.ts` — add `bootstrapTestApp` + `TestApp` (keep `makePrismaOverride`).
- 37 `test/*.e2e-spec.ts` — collapse the inline bootstrap onto the factory.

**Unchanged:** all of `src/`, the 4 non-bootstrap specs, `test/testcontainers.ts`.

---

## Task 1: The `bootstrapTestApp()` factory + smoke test

**Files:**
- Modify: `test/e2e-helpers.ts`
- Create: `test/bootstrap-test-app.e2e-spec.ts`

**Interfaces (produced, consumed by Tasks 2–3):**
- `interface TestApp { app: INestApplication; prisma: PrismaService; db: TestDb; cleanup: () => Promise<void> }`
- `bootstrapTestApp(opts?: { pipe?: boolean; configure?: (app: INestApplication) => void }): Promise<TestApp>`

- [ ] **Step 1: Write the failing smoke test**

Create `test/bootstrap-test-app.e2e-spec.ts`:

```ts
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { bootstrapTestApp, TestApp } from './e2e-helpers';

describe('bootstrapTestApp (e2e harness smoke)', () => {
  let h: TestApp;

  beforeAll(async () => {
    h = await bootstrapTestApp();
  }, 120_000);

  afterAll(() => h.cleanup());

  it('boots the app and serves an un-versioned request', async () => {
    await request(h.app.getHttpServer() as App)
      .get('/metrics')
      .expect(200);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest --config ./test/jest-e2e.json bootstrap-test-app`
Expected: FAIL — `bootstrapTestApp` is not exported from `./e2e-helpers`.

- [ ] **Step 3: Add the factory to `test/e2e-helpers.ts`**

Add these imports at the top (keep the existing `ConfigService` + `PrismaService` imports):

```ts
import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { startTestDb, TestDb } from './testcontainers';
```

Append the factory after `makePrismaOverride`:

```ts
export interface TestApp {
  app: INestApplication;
  prisma: PrismaService;
  db: TestDb;
  /** Tear down in afterAll: app.close → prisma.$disconnect → db.stop. */
  cleanup: () => Promise<void>;
}

/**
 * Boots the full app against a fresh testcontainer DB, mirroring main.ts's
 * middleware stack. The single source for the e2e bootstrap skeleton.
 *
 * @param opts.pipe      false to skip the ValidationPipe (service-layer specs that
 *                       don't exercise DTO validation). Default true → the canonical
 *                       prod pipe (whitelist + transform + forbidNonWhitelisted).
 * @param opts.configure pre-init hook for extra middleware (e.g. helmet).
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

- [ ] **Step 4: Run the smoke test to verify it passes**

Run: `npx jest --config ./test/jest-e2e.json bootstrap-test-app`
Expected: PASS — boots, `GET /metrics` → 200, `cleanup()` resolves. (Docker must be up.)

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck`
Expected: PASS (exit 0). The factory is additive; no spec uses it yet, so the suite is unaffected.

Run: `npx eslint test/e2e-helpers.ts test/bootstrap-test-app.e2e-spec.ts --max-warnings 0`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add test/e2e-helpers.ts test/bootstrap-test-app.e2e-spec.ts
git commit -m "test(e2e): add bootstrapTestApp() factory + smoke test

One source for the e2e bootstrap skeleton, mirroring main.ts's middleware
(canonical ValidationPipe incl. forbidNonWhitelisted). Not yet wired to specs.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Migrate the 12 zero-behavior-change specs

**Files (modify):**
- `{pipe: false}` (7, currently no ValidationPipe): `test/balances-soft-delete-filter.e2e-spec.ts`, `test/close.e2e-spec.ts`, `test/close-out-of-order.e2e-spec.ts`, `test/close-reversal-guard.e2e-spec.ts`, `test/health.e2e-spec.ts`, `test/posting.e2e-spec.ts`, `test/posting-toctou.e2e-spec.ts`
- default canonical (4, already had `forbidNonWhitelisted`): `test/journal-list.e2e-spec.ts`, `test/list-filter-validation.e2e-spec.ts`, `test/versioning.e2e-spec.ts`, `test/uuid-param-validation.e2e-spec.ts`
- default canonical + helmet (1): `test/hardening.e2e-spec.ts`

**Interfaces:** Consumes `bootstrapTestApp` / `TestApp` from Task 1.

**Why these 12 have ZERO behavior change:** the 7 keep no pipe (`{pipe:false}`); the 5 (incl. hardening) already ran the canonical `forbidNonWhitelisted` pipe, which is now the default. So the suite must stay **exactly** green.

- [ ] **Step 1: Establish the baseline (these 12 green BEFORE)**

Run: `npx jest --config ./test/jest-e2e.json balances-soft-delete-filter close close-out-of-order close-reversal-guard health posting posting-toctou journal-list list-filter-validation versioning uuid-param-validation hardening`
Expected: PASS. (Docker up.)

- [ ] **Step 2: Migrate the 7 `{pipe: false}` specs**

For each of the 7, replace its inline bootstrap + teardown with the factory. The transformation (worked example — a service-layer spec that currently has NO `ValidationPipe`):

BEFORE (the shape these 7 share — variable names may differ per spec):
```ts
  let app: INestApplication;
  let prisma: PrismaService;
  let db: TestDb;
  beforeAll(async () => {
    db = await startTestDb();
    prisma = makePrismaOverride(db.url);
    await prisma.$connect();
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = mod.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    // …per-spec seeding / lookups…
  }, 120_000);
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await db.stop();
  });
```

AFTER:
```ts
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ app, prisma, cleanup } = await bootstrapTestApp({ pipe: false }));
    // …per-spec seeding / lookups (unchanged)…
  }, 120_000);
  afterAll(() => cleanup());
```

Rules:
- Import `bootstrapTestApp` (and `TestApp` only if used) from `./e2e-helpers`; remove now-unused imports (`Test`, `AppModule`, `AllExceptionsFilter`, `VersioningType`, `startTestDb`/`TestDb` if unreferenced, `makePrismaOverride` if unreferenced). Keep `INestApplication`, `PrismaService`, and `ValidationPipe`-free.
- Keep every line of per-spec seeding/login/account-lookup exactly as-is.
- If a spec references `db` later, destructure `db` too; otherwise omit it.

- [ ] **Step 3: Migrate the 4 already-canonical specs (default pipe)**

For `journal-list`, `list-filter-validation`, `versioning`, `uuid-param-validation` — same transformation but `bootstrapTestApp()` (no opts; the default canonical pipe equals what they already had). Their inline pipe was `new ValidationPipe({ whitelist, transform, forbidNonWhitelisted })` — remove it (the factory supplies it).

- [ ] **Step 4: Migrate `hardening` (default pipe + helmet)**

`test/hardening.e2e-spec.ts` currently has the canonical pipe AND `app.use(helmet())`. Replace its bootstrap with:
```ts
    ({ app, prisma, cleanup } = await bootstrapTestApp({
      configure: (a) => a.use(helmet()),
    }));
```
Keep the `import helmet from 'helmet';` line. The `configure` hook runs after the pipe/filter and before `init`, preserving helmet's placement.

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck`
Expected: PASS (exit 0).
Run: `npm run lint:ci`
Expected: clean (catches any leftover unused import in the 12 specs).

- [ ] **Step 6: Run the 12 migrated specs**

Run: `npx jest --config ./test/jest-e2e.json balances-soft-delete-filter close close-out-of-order close-reversal-guard health posting posting-toctou journal-list list-filter-validation versioning uuid-param-validation hardening`
Expected: PASS — identical to the Step 1 baseline (ZERO behavior change; if any spec now fails, the migration was not faithful — fix it, do not paper over it).

- [ ] **Step 7: Commit**

```bash
git add test/balances-soft-delete-filter.e2e-spec.ts test/close.e2e-spec.ts test/close-out-of-order.e2e-spec.ts test/close-reversal-guard.e2e-spec.ts test/health.e2e-spec.ts test/posting.e2e-spec.ts test/posting-toctou.e2e-spec.ts test/journal-list.e2e-spec.ts test/list-filter-validation.e2e-spec.ts test/versioning.e2e-spec.ts test/uuid-param-validation.e2e-spec.ts test/hardening.e2e-spec.ts
git commit -m "test(e2e): route the 12 no-behavior-change specs through bootstrapTestApp

7 service-layer specs use {pipe:false}; 4 already-canonical specs use the
default pipe; hardening uses the configure hook for helmet. No behavior change.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Migrate the 25 lax specs (the T2 pipe flip) + triage

**Files (modify):** the remaining 25 `test/*.e2e-spec.ts` that still inline `createTestingModule` after Task 2 — every bootstrap spec NOT in Task 2's list of 12 and NOT one of the 4 non-bootstrap specs. These currently run `new ValidationPipe({ whitelist, transform })` **without** `forbidNonWhitelisted`.

**Interfaces:** Consumes `bootstrapTestApp` from Task 1.

**The deliberate behavior change:** migrating these to `bootstrapTestApp()` (default canonical pipe) turns `forbidNonWhitelisted` on. A spec that sends an unknown request field will now get 400.

- [ ] **Step 1: Confirm the un-migrated set (expect 25)**

Run: `grep -l "createTestingModule" test/*.e2e-spec.ts | xargs grep -L "bootstrapTestApp" | xargs grep -l "new ValidationPipe"`
Expected: 25 files (every pipe-using bootstrap spec not yet migrated). These are the targets.

- [ ] **Step 2: Migrate all 25 to `bootstrapTestApp()` (default pipe)**

For each, the same transformation as Task 2 Step 3 (worked example — a spec like `metrics.e2e-spec.ts` / `sales-invoices.e2e-spec.ts`):

BEFORE:
```ts
    app = mod.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
```
AFTER: the whole `db/prisma/createTestingModule/createNestApplication/pipe/filter/init` block →
```ts
    ({ app, prisma, cleanup } = await bootstrapTestApp());
```
plus `afterAll(() => cleanup())`, import `bootstrapTestApp`, and remove now-unused imports (`Test`, `AppModule`, `AllExceptionsFilter`, `ValidationPipe`, `VersioningType`, `startTestDb`/`TestDb`/`makePrismaOverride` if unreferenced). Keep per-spec seeding/login/lookups verbatim.

- [ ] **Step 3: Typecheck + lint**

Run: `npm run typecheck` → exit 0. Run: `npm run lint:ci` → clean.

- [ ] **Step 4: Run the full e2e suite and triage the pipe flip**

Run: `npx jest --config ./test/jest-e2e.json`
Expected: the **only** new failures (if any) are specs that send an unknown request field, now 400 under the canonical pipe. For each such failure:
- Inspect the request body the test sends. If it includes a field not on the endpoint's DTO, that is the fidelity gap — **fix the test's payload** to send only valid fields (the field was never accepted by production).
- Do NOT relax the factory pipe or add `{ pipe: false }` to silence it — that would re-open the gap.
- If a failure is NOT a payload issue (e.g. a real app bug surfaced), stop and escalate — that is out of scope for a test migration.

If the suite is green with no payload changes: the gap was latent-only and is now closed for free.

- [ ] **Step 5: Commit the migration (and triage fixes separately)**

```bash
git add test/*.e2e-spec.ts
git commit -m "test(e2e): route the remaining 25 specs through bootstrapTestApp (canonical pipe)

Flips forbidNonWhitelisted on for the 25 specs that ran a more permissive pipe
than production (round-4 #T2). Mechanical migration.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
If any payload fixes were needed in Step 4, commit them as a **separate** follow-up so the fidelity-gap fixes are auditable:
```bash
git commit -m "test(e2e): fix payloads that sent fields production rejects (T2 gap)"
```

- [ ] **Step 6: Full verification gate**

Run: `npm run verify`
Expected: PASS — typecheck (0), `lint:ci` (clean), `test` (194 unit), `test:e2e:cov` (all e2e pass, coverage ≥ 84/62/84/84).

- [ ] **Step 7: Final sanity diff**

Run: `git diff --stat main`
Expected: `e2e-helpers.ts` (+factory), `bootstrap-test-app.e2e-spec.ts` (new), 37 `*.e2e-spec.ts` (net reduction), plus the spec/plan docs. **No `src/` change** (confirm: `git diff --name-only main -- src` is empty).

---

## Self-Review

**1. Spec coverage**
- §4 factory (`bootstrapTestApp`/`TestApp`, canonical pipe default, `pipe`/`configure` opts) → Task 1 Step 3. ✓
- §5 migration rule (has-pipe→default; no-pipe→`{pipe:false}`; hardening→helmet) → Task 2 Steps 2–4 + Task 3 Step 2. ✓
- §3 T2 fold-in (25 lax → canonical) + triage → Task 3 Steps 2, 4. ✓
- §3 out-of-scope (seeding stays; 4 non-bootstrap specs excluded; no src) → Global Constraints + Task 3 Step 7. ✓
- §7 smoke test + suite-as-gate + triage protocol → Task 1 Steps 1–4; Task 3 Step 4. ✓
- §8 verification (commits incl. separable triage fixes, `npm run verify`, no-src diff) → each task's commit + Task 3 Steps 5–7. ✓
- §9 risks (test-only; volume→batched; cross-test bleed non-issue) → Global Constraints + task split. ✓

**2. Placeholder scan:** No "TBD"/"add validation"/"similar to" without code. The 37-file migration is uniform, so it's specified as a worked before/after + an exact rule + named file lists (showing 37 individual before/afters is neither feasible nor informative for an identical transform). Every run step has an exact command + expected output. ✓

**3. Type consistency:** `bootstrapTestApp(opts?: { pipe?: boolean; configure?: (app: INestApplication) => void }): Promise<TestApp>` and `TestApp { app; prisma; db; cleanup }` are identical between Task 1's Produces block, Step 3's definition, the smoke test, and the Task 2/3 call sites (`{ app, prisma, cleanup } = await bootstrapTestApp(...)`). The `{ pipe: false }` and `{ configure }` opt shapes match across Tasks 2–3. ✓

No issues found.
