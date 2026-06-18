# §4 Ops Track-A Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the decision-free, in-repo §4 ops findings: env-validation drift, CORS parsing, Sentry PII scrub, LOG_LEVEL, crash-safety handlers, a unit coverage gate, stale runbooks, and the two missing invoicing unit specs.

**Architecture:** Small, independent hardening edits across config/observability/docs/tests. Pure logic (CORS parse, Sentry scrub) is extracted into tiny tested helpers; the rest is config wiring + runbook prose + two new unit specs. No single-threaded behavior change for valid configs.

**Tech Stack:** NestJS 11, class-validator (`env.validation.ts`), `@sentry/node` (DSN-gated), `nestjs-pino`, Jest + ts-jest (unit), Jest + Testcontainers (e2e).

## Global Constraints

- **No behavior change for valid configs.** The only intended new runtime behaviors: fail-fast on malformed env, fail-closed CORS on empty, and `exit(1)` on `uncaughtException`.
- **Real rate-limit numbers (for the runbook):** global **300 req / 60s per authenticated user** (`app.module.ts:62-73`, `THROTTLE_LIMIT` default 300); login **10/60s** per IP (`THROTTLE_LOGIN_LIMIT`), refresh/logout **30/60s** per IP (`THROTTLE_REFRESH_LIMIT`). Redis-backed in dev/prod, **fail-closed** (429 on limit, 503 if Redis down).
- **Per-task gate:** `npm run db:generate` (cheap, unaffected) + `npm run typecheck` (0) + `npm run lint:ci` (0) + the task's tests. Prettier may reflow multi-decorator lines — run `npx prettier --write` on touched files if `lint:ci` flags formatting.
- **Sequencing:** Tasks 4 & 5 (new unit specs) MUST land before Task 6 (coverage threshold) — the floor is measured with the new specs present.
- Known: the full `npm run verify` e2e is environmentally flaky under load (unrelated suites); confirm any suspected failure in isolation.

---

## Task 1: Env validation + fail-closed CORS parsing (OPS-CFG-1, CFG-2)

**Files:**
- Modify: `src/config/env.validation.ts` (add 3 fields to `EnvVars`)
- Create: `src/config/cors-origins.ts` (pure parse helper)
- Create: `src/config/cors-origins.spec.ts`
- Modify: `src/config/env.validation.spec.ts` (new cases)
- Modify: `src/main.ts:29` (use the helper)

**Interfaces:**
- Produces: `parseCorsOrigins(raw: string | undefined): string[] | false`

- [ ] **Step 1: Write the failing CORS-helper test**

Create `src/config/cors-origins.spec.ts`:
```ts
import { parseCorsOrigins } from './cors-origins';

describe('parseCorsOrigins', () => {
  it('returns false when unset (CORS disabled — fail-closed)', () => {
    expect(parseCorsOrigins(undefined)).toBe(false);
  });
  it('returns false for an empty / whitespace-only value', () => {
    expect(parseCorsOrigins('')).toBe(false);
    expect(parseCorsOrigins('  ,  ')).toBe(false);
  });
  it('splits, trims, and drops empties', () => {
    expect(parseCorsOrigins('https://a.com, https://b.com ,')).toEqual([
      'https://a.com',
      'https://b.com',
    ]);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL (module not found)**

Run: `npm test -- cors-origins`
Expected: FAIL (`Cannot find module './cors-origins'`).

- [ ] **Step 3: Implement the helper**

Create `src/config/cors-origins.ts`:
```ts
/** Parse the CORS_ORIGIN env (comma-separated) into an origin list, or `false`
 *  to disable CORS. Trims each entry and drops empties; an all-empty value is
 *  treated as disabled (fail-closed) rather than an array of empty strings. */
export function parseCorsOrigins(raw: string | undefined): string[] | false {
  if (!raw) return false;
  const origins = raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  return origins.length > 0 ? origins : false;
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `npm test -- cors-origins` → PASS (3 tests).

- [ ] **Step 5: Use the helper in main.ts**

In `src/main.ts`, add the import (with the other imports):
```ts
import { parseCorsOrigins } from './config/cors-origins';
```
Replace line 29:
```ts
  app.enableCors({ origin: parseCorsOrigins(process.env.CORS_ORIGIN) });
```

- [ ] **Step 6: Add the three env vars to EnvVars**

In `src/config/env.validation.ts`, add `IsIn` to the `class-validator` import, and append these fields to `EnvVars` (before the closing brace, after `REDIS_URL`):
```ts
  @IsOptional()
  @IsString()
  CORS_ORIGIN?: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  ENABLE_SWAGGER?: string;

  @IsOptional()
  @IsIn(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
  LOG_LEVEL?: string;
```

- [ ] **Step 7: Extend the env-validation spec**

In `src/config/env.validation.spec.ts`, add inside the `describe`:
```ts
  it('accepts valid optional ops vars', () => {
    expect(() =>
      validate({
        ...validEnv,
        CORS_ORIGIN: 'https://app.example.com',
        ENABLE_SWAGGER: 'true',
        LOG_LEVEL: 'debug',
      }),
    ).not.toThrow();
  });

  it('rejects a malformed ENABLE_SWAGGER', () => {
    expect(() => validate({ ...validEnv, ENABLE_SWAGGER: 'yes' })).toThrow();
  });

  it('rejects an invalid LOG_LEVEL', () => {
    expect(() => validate({ ...validEnv, LOG_LEVEL: 'verbose' })).toThrow();
  });
```

- [ ] **Step 8: Gate + commit**

Run: `npm run db:generate && npm run typecheck` → 0. `npm run lint:ci` → 0 (run `npx prettier --write src/config/env.validation.ts` if the multi-decorator block is flagged). `npm test -- "cors-origins|env.validation"` → green.
```bash
git add src/config/env.validation.ts src/config/cors-origins.ts src/config/cors-origins.spec.ts src/config/env.validation.spec.ts src/main.ts
git commit -m "feat(config): validate CORS_ORIGIN/ENABLE_SWAGGER/LOG_LEVEL; fail-closed CORS parse"
```

---

## Task 2: Sentry PII scrub + LOG_LEVEL + crash-safety handlers (OPS-OBS-2, OBS-3, RES-1)

**Files:**
- Create: `src/config/sentry-scrub.ts` (pure scrub fn)
- Create: `src/config/sentry-scrub.spec.ts`
- Modify: `src/main.ts` (wire `beforeSend`; add process handlers)
- Modify: `src/app.module.ts:39-60` (pino `level`)

**Interfaces:**
- Produces: `scrubSentryEvent(event: SentryEvent): SentryEvent` where `SentryEvent` is the minimal shape `{ request?: { data?: unknown; query_string?: unknown; headers?: Record<string, unknown> } }` (use `@sentry/node`'s `ErrorEvent` type at the call site; the helper takes a structurally-typed param so it's unit-testable without the SDK).

- [ ] **Step 1: Write the failing scrub test**

Create `src/config/sentry-scrub.spec.ts`:
```ts
import { scrubSentryEvent } from './sentry-scrub';

describe('scrubSentryEvent', () => {
  it('drops the request body and query string', () => {
    const e = scrubSentryEvent({
      request: { data: { password: 'x' }, query_string: 'token=abc' },
    });
    expect(e.request?.data).toBeUndefined();
    expect(e.request?.query_string).toBeUndefined();
  });
  it('redacts authorization and cookie headers, keeps others', () => {
    const e = scrubSentryEvent({
      request: {
        headers: { authorization: 'Bearer x', cookie: 'a=b', 'user-agent': 'k6' },
      },
    });
    expect(e.request?.headers).toEqual({ 'user-agent': 'k6' });
  });
  it('is a no-op when there is no request', () => {
    expect(scrubSentryEvent({})).toEqual({});
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npm test -- sentry-scrub` → FAIL (module not found).

- [ ] **Step 3: Implement the scrub**

Create `src/config/sentry-scrub.ts`:
```ts
/** Minimal structural view of the parts of a Sentry event we scrub. */
export interface ScrubbableEvent {
  request?: {
    data?: unknown;
    query_string?: unknown;
    headers?: Record<string, unknown>;
  };
}

/** Conservative PII scrub for Sentry `beforeSend`: drop request bodies and query
 *  strings (may carry tokens), and remove the authorization/cookie headers. Stack
 *  traces, breadcrumbs, and non-sensitive headers are retained. */
export function scrubSentryEvent<T extends ScrubbableEvent>(event: T): T {
  if (!event.request) return event;
  delete event.request.data;
  delete event.request.query_string;
  if (event.request.headers) {
    delete event.request.headers.authorization;
    delete event.request.headers.cookie;
  }
  return event;
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `npm test -- sentry-scrub` → PASS (3 tests).

- [ ] **Step 5: Wire beforeSend + process handlers into main.ts**

In `src/main.ts`, add the import:
```ts
import { scrubSentryEvent } from './config/sentry-scrub';
```
Add `beforeSend` to the existing `Sentry.init({...})` (the block at lines 13-18), so it reads:
```ts
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
      release: process.env.SENTRY_RELEASE,
      tracesSampleRate: 0,
      beforeSend: (event) => scrubSentryEvent(event),
    });
```
Immediately AFTER the `if (process.env.SENTRY_DSN) { … }` block (still inside `bootstrap`, before `NestFactory.create`), add the crash-safety handlers:
```ts
  // Last-resort crash safety. An uncaughtException leaves the process in an
  // undefined state → log, capture, flush, exit(1) (Docker `unless-stopped`
  // restarts). An unhandledRejection is logged + captured without exiting.
  const captureFatal = async (err: unknown): Promise<void> => {
    console.error(err);
    if (process.env.SENTRY_DSN) {
      const Sentry = await import('@sentry/node');
      Sentry.captureException(err);
      await Sentry.flush(2000);
    }
  };
  process.on('uncaughtException', (err) => {
    void captureFatal(err).finally(() => process.exit(1));
  });
  process.on('unhandledRejection', (reason) => {
    void captureFatal(reason);
  });
```

- [ ] **Step 6: Wire LOG_LEVEL into pino**

In `src/app.module.ts`, inside the `LoggerModule.forRoot({ pinoHttp: { … } })` block (lines 40-59), add a `level` key alongside `autoLogging` (do NOT remove `genReqId`/`redact`):
```ts
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        autoLogging: true,
        genReqId: (req, res) => {
```

- [ ] **Step 7: Gate + commit**

Run: `npm run db:generate && npm run typecheck` → 0. `npm run lint:ci` → 0. `npm test -- sentry-scrub` → green. (Boot/observability changes are exercised by the existing e2e suite — app must still start; no behavior change for valid config.)
```bash
git add src/config/sentry-scrub.ts src/config/sentry-scrub.spec.ts src/main.ts src/app.module.ts
git commit -m "feat(observability): Sentry PII scrub, LOG_LEVEL, uncaught/unhandledRejection handlers"
```

---

## Task 3: Runbook fixes (OPS-DOC-1, DOC-2, DOC-3, DOC-4)

**Files:**
- Modify: `docs/runbooks/perf-baseline.md:117-134`
- Modify: `docs/runbooks/deploy.md` (Prerequisites; Rollback caveats)

Docs-only; no code tests. Verify by reading.

- [ ] **Step 1: Fix the stale rate-limit paragraph**

In `docs/runbooks/perf-baseline.md`, replace the whole `## ⚠️ Rate limiter caveat (single-source load)` section (lines 117-134) with:
```md
## ⚠️ Rate limiter caveat (load testing)

The app applies a global throttle of **300 requests / 60s per authenticated user**
(`app.module.ts` `ThrottlerModule`, `ttl: 60_000`, `limit` default 300 via
`THROTTLE_LIMIT`), backed by Redis in dev/prod and **fail-closed** (429 on the
limit; 503 if Redis is unreachable). Auth endpoints are stricter and per-IP: login
**10/60s** (`THROTTLE_LOGIN_LIMIT`), refresh/logout **30/60s** (`THROTTLE_REFRESH_LIMIT`).
The report/ledger/invoice hot paths are **not** `@SkipThrottle()`, so a k6 run that
drives more than 300 req/min as a single user trips `429 Too Many Requests` — which
k6 counts as `http_req_failed`. That is the limiter working as designed, **not** an
app or DB problem.

To baseline the protected hot paths above the per-user quota you must therefore either:
- spread load across **multiple authenticated users** (each gets its own 300/min bucket); or
- temporarily raise `THROTTLE_LIMIT` for the test window; or
- keep a single user **under** the quota (≲5 req/s) — still a clean latency/pool baseline.

`/health`, `/ready`, and `/metrics` are `@SkipThrottle()`, so a `/health` smoke (below)
proves k6 + raw concurrency without tripping the limiter.
```

- [ ] **Step 2: Add Redis to deploy prerequisites**

In `docs/runbooks/deploy.md`, in the `## Prerequisites` list (after the Docker bullet), add:
```md
- **Redis** must be running and reachable at `REDIS_URL` before the API starts. The
  rate limiter is **fail-closed**: without Redis the API returns `503` on every
  throttled route, so a deploy can come up "running" (container healthy) yet 503 all
  business requests. The prod compose stack includes a `redis` service; if you run
  the API standalone, provision Redis and set `REDIS_URL` first.
```

- [ ] **Step 3: Enhance the rollback section + mention monitoring overlay**

In `docs/runbooks/deploy.md`, replace the `## Rollback caveats` section (lines 50-54) with:
```md
## Rollback

1. **App-only rollback (no schema change):** redeploy the previous image tag/commit —
   `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d` after
   checking out the prior commit (or pinning the prior image tag). Caddy/api/backup
   restart against the unchanged DB.
2. **Migrations are forward-only.** Rolling back the image does NOT undo a migration.
   If a bad migration shipped:
   a. Stop the API: `docker compose ... stop api`.
   b. Prefer a **corrective forward migration** (a new migration that fixes the bad
      one) over editing history — never edit an already-applied migration.
   c. If data is corrupted, **restore from backup**: follow `backup-and-restore.md`
      (stop `api`, restore the latest good `pg_dump -Fc` into the `db` volume, then
      bring `api` back up). Accept the data delta since that backup.
3. After any rollback, verify `/health` (200) and `/ready` (200 — DB + Redis reachable).

## Monitoring (optional)

An optional observability overlay ships in `docker-compose.monitoring.yml` (Prometheus
+ Grafana + alertmanager). Enable it by adding `-f docker-compose.monitoring.yml` to the
compose command and setting `GRAFANA_ADMIN_PASSWORD` in `.env`. Alert *delivery* still
needs a real receiver wired in `monitoring/alertmanager.yml` (see the ops backlog).
```

- [ ] **Step 4: Verify + commit**

Re-read both files; confirm no remaining "100 requests / 60s per source IP" (`grep -rn "100 requests" docs/runbooks` → no hits) and Redis now appears in `deploy.md` prerequisites.
```bash
git add docs/runbooks/perf-baseline.md docs/runbooks/deploy.md
git commit -m "docs(runbooks): correct rate-limit policy; add Redis prereq + concrete rollback + monitoring overlay"
```

---

## Task 4: document-number unit spec + journal e2e key hygiene (OPS-TEST-1a, TEST-3)

**Files:**
- Create: `src/invoicing/document-number.service.spec.ts`
- Modify: `test/journal.e2e-spec.ts:265,287`

**Interfaces:**
- Consumes: `DocumentNumberService.next(tx: RawTx, documentType: string, fiscalYear: number): Promise<number>` and `buildRef(prefix, fiscalYear, number): string`.

- [ ] **Step 1: Write the document-number unit spec**

Create `src/invoicing/document-number.service.spec.ts`:
```ts
import { DocumentNumberService } from './document-number.service';

describe('DocumentNumberService', () => {
  const svc = new DocumentNumberService();

  it('returns the current counter and increments under the lock (gapless)', async () => {
    const executed: string[] = [];
    const tx = {
      $executeRaw: jest.fn((strings: TemplateStringsArray) => {
        executed.push(strings.join('?'));
        return Promise.resolve(1);
      }),
      $queryRaw: jest.fn(() => Promise.resolve([{ next_number: 7 }])),
    } as unknown as Parameters<DocumentNumberService['next']>[0];

    const n = await svc.next(tx, 'INV', 2026);

    expect(n).toBe(7);
    // insert-on-conflict (seed) → select FOR UPDATE → update to current+1
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(executed[0]).toContain('INSERT INTO document_sequences');
    expect(executed[1]).toContain('UPDATE document_sequences');
  });

  it('formats a zero-padded ref', () => {
    expect(svc.buildRef('INV', 2026, 42)).toBe('INV/2026/000042');
  });
});
```

- [ ] **Step 2: Run it — expect PASS (code already exists)**

Run: `npm test -- document-number` → PASS (2 tests). (If `buildRef`'s format differs, read `src/common/db/doc-ref.ts` and correct the expected string to match — it is the existing format, not a new requirement.)

- [ ] **Step 3: Replace Date.now() idempotency keys in journal.e2e**

In `test/journal.e2e-spec.ts` (`randomUUID` is already imported at line 7), change the two **idempotency-key** strings:
- Line ~265: `const key = \`idem-${Date.now()}\`;` → `const key = \`idem-${randomUUID()}\`;`
- Line ~287: `const key = \`idem-concurrent-${Date.now()}\`;` → `const key = \`idem-concurrent-${randomUUID()}\`;`

Leave the `desc` string on line ~288 as-is (it's a human-readable description, not a key).

- [ ] **Step 4: Gate + commit**

Run: `npm run typecheck` → 0. `npm run lint:ci` → 0. `npm test -- document-number` → green. `npm run test:e2e -- journal` → green (the key change is behavior-neutral; the idempotency tests still pass).
```bash
git add src/invoicing/document-number.service.spec.ts test/journal.e2e-spec.ts
git commit -m "test(invoicing): unit-test gapless document numbering; randomUUID idempotency keys in journal e2e"
```

---

## Task 5: document-posting orchestration unit spec (OPS-TEST-1b)

**Files:**
- Create: `src/invoicing/document-posting.service.spec.ts`

**Interfaces:**
- Consumes: `DocumentPostingService` constructor `(prisma: PrismaService, posting: PostingService, tax: TaxService, docNumber: DocumentNumberService)`; `post(params: PostTaxedDocParams, lockDraft, finalize)`. `tax.calculate` returns `TaxCalculation` (the spec stubs `{ journalLines, taxes: [], subtotal, settlementAmount }` — `summarize` reads `calc.taxes`/`subtotal`/`settlementAmount`).

This is a FOCUSED orchestration test: assert the call sequence and argument threading with all deps mocked. It deliberately does NOT re-test tax math or DB effects (e2e covers those).

- [ ] **Step 1: Write the orchestration spec**

Create `src/invoicing/document-posting.service.spec.ts`:
```ts
import { DocumentPostingService } from './document-posting.service';

describe('DocumentPostingService (orchestration)', () => {
  function build() {
    const tx = { __tx: true };
    const calc = {
      journalLines: [
        { accountId: 'ar', debit: '1000.0000' },
        { accountId: 'rev', credit: '1000.0000' },
      ],
      taxes: [],
      subtotal: '1000.0000',
      settlementAmount: '1000.0000',
    };
    const entry = { id: 'je1' };
    const tax = { calculate: jest.fn().mockResolvedValue(calc) };
    const posting = {
      preparePosting: jest
        .fn()
        .mockResolvedValue({ periodId: 'p1', fiscalYear: 2026 }),
      createPostedEntryInTx: jest.fn().mockResolvedValue(entry),
    };
    const docNumber = {
      next: jest.fn().mockResolvedValue(42),
      buildRef: jest.fn().mockReturnValue('INV/2026/000042'),
    };
    const prisma = {
      client: { $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)) },
    };
    const svc = new DocumentPostingService(
      prisma as never,
      posting as never,
      tax as never,
      docNumber as never,
    );
    return { svc, tx, entry, tax, posting, docNumber, prisma };
  }

  const params = {
    nature: 'SALE' as const,
    settlementAccountId: 'ar',
    date: new Date('2026-03-15'),
    description: 'INV-1',
    sourceType: 'SALES_INVOICE' as const,
    sourceId: 's1',
    createdBy: 'u1',
    postedBy: 'u2',
    documentType: 'INV',
    lines: [],
  };

  it('prepares before the transaction, locks before numbering, threads period/fy, and finalizes', async () => {
    const { svc, tx, entry, tax, posting, docNumber, prisma } = build();
    const lockDraft = jest.fn().mockResolvedValue(undefined);
    const finalize = jest.fn().mockResolvedValue(undefined);

    await svc.post(params, lockDraft, finalize);

    // tax + prepare run OUTSIDE the tx, before it opens
    expect(tax.calculate).toHaveBeenCalledTimes(1);
    expect(posting.preparePosting).toHaveBeenCalledTimes(1);
    expect(posting.preparePosting.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.client.$transaction.mock.invocationCallOrder[0],
    );
    // lock-before-number is the gapless invariant
    expect(lockDraft.mock.invocationCallOrder[0]).toBeLessThan(
      docNumber.next.mock.invocationCallOrder[0],
    );
    // period/fiscalYear from preparePosting are threaded into the posted-entry write
    expect(posting.createPostedEntryInTx).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ sourceType: 'SALES_INVOICE', sourceId: 's1' }),
      'u2',
      'p1',
      2026,
    );
    // finalize receives the assigned number/ref/entry + computed totals
    expect(finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        tx,
        number: 42,
        ref: 'INV/2026/000042',
        entry,
        fiscalYear: 2026,
        totals: expect.objectContaining({
          subtotal: '1000.0000',
          total: '1000.0000',
        }),
      }),
    );
  });
});
```

- [ ] **Step 2: Run it — expect PASS (code already exists)**

Run: `npm test -- document-posting` → PASS. If `summarize` reads a field the stub omits (it reads `calc.taxes`, `calc.subtotal`, `calc.settlementAmount`), extend the `calc` stub accordingly — do NOT change the assertions' intent.

- [ ] **Step 3: Gate + commit**

Run: `npm run typecheck` → 0. `npm run lint:ci` → 0. `npm test -- document-posting` → green.
```bash
git add src/invoicing/document-posting.service.spec.ts
git commit -m "test(invoicing): focused orchestration unit test for DocumentPostingService"
```

---

## Task 6: Unit coverage threshold gate (OPS-CI-2) — RUN LAST

**Files:**
- Modify: `package.json` (the `"jest"` block)

Must run AFTER Tasks 4 & 5 so the floor reflects the new specs.

- [ ] **Step 1: Measure current unit coverage**

Run: `npm run test:cov 2>/dev/null | tail -8`
Record the **global** `% Stmts / % Branch / % Funcs / % Lines` from the `All files` row.

- [ ] **Step 2: Add a ratcheted threshold + coverage scope to the jest block**

In `package.json`, inside the top-level `"jest"` object, add these keys (alongside `rootDir`/`testRegex`/`transform`). Set each `coverageThreshold.global` number to the measured value from Step 1 **floored to the nearest 5 below it** (e.g. measured 63.4% branches → `60`). This is a regression floor, not a target.
```json
    "collectCoverageFrom": [
      "**/*.ts",
      "!**/*.spec.ts",
      "!**/*.dto.ts",
      "!**/main.ts",
      "!**/*.module.ts"
    ],
    "coveragePathIgnorePatterns": [
      "/node_modules/"
    ],
    "coverageThreshold": {
      "global": {
        "statements": <floored>,
        "branches": <floored>,
        "functions": <floored>,
        "lines": <floored>
      }
    }
```
> The `<floored>` placeholders are the only values determined at implementation time (they depend on the measured coverage). Replace each with the concrete floored integer — do not leave a literal placeholder.

- [ ] **Step 3: Verify the gate passes with margin**

Run: `npm run test:cov` → exits 0 (coverage is at or above each floored threshold). If it fails, the floor was set too high — lower it to below the actual measured value.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "ci(test): add ratcheted unit coverage threshold (regression floor)"
```

---

## Self-Review notes

- **Spec coverage:** Cluster 1 → Task 1; Cluster 2 → Task 2; Cluster 4 → Task 3; Cluster 5 → Tasks 4 (doc-number + e2e key) & 5 (doc-posting); Cluster 3 → Task 6 (last, post-measurement). All 12 in-scope findings mapped; OPS-TEST-2 + Track-B correctly excluded.
- **No behavior change for valid configs:** env vars are `@IsOptional`; CORS parse returns `false` for unset (same as today's `?? false`); pino `level` defaults to `info`; Sentry scrub only runs under a DSN; the only new runtime behavior is fail-fast on malformed env + `exit(1)` on uncaughtException.
- **Type consistency:** `parseCorsOrigins` (Task 1) and `scrubSentryEvent` (Task 2) signatures match their specs and call sites; `DocumentNumberService.next`/`buildRef` and `DocumentPostingService` constructor/`post` match the extracted source.
- **Watch-points:** (1) Task 6 floors are measured at impl time — the only runtime-determined values, with an explicit procedure. (2) `buildRef` format assertion (Task 4) and the `calc` stub fields (Task 5) are pinned to existing code — adjust to match if the read reveals a difference, without weakening intent. (3) Prettier may reflow the new multi-decorator env fields — auto-fix and re-lint.
