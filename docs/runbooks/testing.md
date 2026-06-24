# Testing Runbook

How to run, write, and debug the test suite. See also [`./commands.md`](./commands.md)
for the full script index, [`./database-and-migrations.md`](./database-and-migrations.md)
for the Prisma/migration mechanics e2e relies on, [`./troubleshooting.md`](./troubleshooting.md)
for failure triage, and [`./conventions.md`](./conventions.md) for general code style.

## Two test tiers

| Tier | Files | Config | Runs against | Speed |
| --- | --- | --- | --- | --- |
| **Unit** | `src/**/*.spec.ts` | `jest` block in `package.json` (`rootDir: src`, `testRegex: .*\.spec\.ts$`) | nothing — pure logic, mocked deps | fast |
| **E2E** | `test/*.e2e-spec.ts` | `test/jest-e2e.json` (`rootDir: ..`, `testRegex: .e2e-spec.ts$`) | a **real Postgres 16** per suite via Testcontainers | slow |

- **Unit** tests exercise pure logic (money math, tax calc, validators, interceptors,
  guards) with hand-rolled mocks. No DB, no network. There are 42 unit spec files.
- **E2E** tests boot the real `AppModule` and talk to a throwaway `postgres:16`
  container started by Testcontainers, with **migrations applied on every run**
  (`npx prisma migrate deploy` against the fresh container — see `test/testcontainers.ts`).
  `maxWorkers: 1` forces them to run **serially**; `testTimeout` is 30s (suite
  `beforeAll` allows 120s for container start + migrate). There are 43 e2e spec files.

> **Docker MUST be running for e2e.** Testcontainers spins up real Postgres
> containers; with no Docker daemon, every e2e suite fails at `startTestDb()`.
> Unit tests need no Docker.

## Running

| Command | What it does |
| --- | --- |
| `npm test` | unit tests (`jest`) |
| `npm run test:watch` | unit tests in watch mode |
| `npm run test:cov` | unit tests **+ coverage**, enforces the unit `coverageThreshold` |
| `npm run test:e2e` | e2e tests (`jest --config ./test/jest-e2e.json`) |
| `npm run test:e2e:cov` | e2e tests **+ coverage**, enforces the e2e `coverageThreshold` |
| `npm run test:debug` | unit tests under `--inspect-brk --runInBand` (attach a debugger) |

### Run a single spec or file

Both runners accept a Jest name/path regex as a positional arg after `--`:

```bash
# Unit — by file/path substring
npm test -- tax.service          # runs src/tax/tax.service.spec.ts
npm test -- money                # runs all money*/*money* unit specs

# Unit — by test name (-t)
npm test -- -t "balanced"        # only its/describes matching "balanced"

# E2E — by file/path substring (Docker required)
npm run test:e2e -- posting      # runs test/posting.e2e-spec.ts
npm run test:e2e -- payments
```

Combine: `npm run test:e2e -- posting -t "gapless"` runs only the gapless cases
in the posting e2e suite. Running one suite at a time is also the cure for the
flakiness described below.

## Coverage gates

Coverage is a **regression floor**, not a target — adding code with no tests can
drop a percentage below the floor and fail `*:cov` (and therefore CI).

**Unit** (`package.json` → `jest.coverageThreshold.global`):

| statements | branches | functions | lines |
| --- | --- | --- | --- |
| 22 | 18 | 18 | 22 |

These are deliberately low: most logic is covered by e2e, so the unit floor only
guards the pure-logic modules. `collectCoverageFrom` includes `**/*.ts` but
**excludes** `*.spec.ts`, `*.dto.ts`, `main.ts`, and `*.module.ts`.

**E2E** (`test/jest-e2e.json` → `coverageThreshold.global`):

| statements | branches | functions | lines |
| --- | --- | --- | --- |
| 84 | 62 | 84 | 84 |

The e2e suite carries the real coverage weight. Its `collectCoverageFrom` pulls
from `src/**/*.(t|j)s` and **excludes** `*.spec.ts`, `main.ts`, `*.module.ts`,
`dto/**`, and `*.dto.ts`. Note `collectCoverage` defaults to `false` there — it's
only turned on by the `--coverage` flag in `test:e2e:cov`.

## The full gate

```bash
npm run verify
```

`verify` = `typecheck` (`tsc --noEmit`) → `lint:ci` (`eslint --max-warnings 0`) →
`test` (unit) → `test:e2e:cov` (e2e **with** the coverage gate). This is the same
sequence CI's `verify` job runs, so a green local `verify` is the bar before
opening a PR. **Docker must be up** for the e2e leg.

## ⚠️ Known issue: e2e flakiness under load

The full e2e suite is environmentally **flaky under load**, not code-buggy. Each
suite starts its own `postgres:16` container; running 42 suites back-to-back can
saturate Docker (CPU, memory, container/port churn), and a suite may time out or
fail to connect **even though it passes in isolation**. Despite `maxWorkers: 1`
serializing the *tests*, container teardown/startup overlap and host contention
still cause intermittent, non-deterministic failures in **unrelated** suites.

**Triage rule:** before treating an e2e failure as a real defect, **re-run the
suspect suite alone**:

```bash
npm run test:e2e -- <suite-name>     # e.g. npm run test:e2e -- payments
```

If it passes in isolation, it was contention — **not a code defect**. Only a
failure that reproduces in isolation is a genuine bug worth debugging (then reach
for [`./troubleshooting.md`](./troubleshooting.md)).

## Writing tests

### E2E bootstrap pattern (mandatory shape)

Every e2e suite uses **`bootstrapTestApp(opts?)`** from `test/e2e-helpers.ts` — it
handles the Testcontainers start, PrismaService override, versioning, and
`ValidationPipe` wiring in one call and returns `{ app, prisma, db, cleanup }`.
Env defaults (JWT secrets/TTLs, `NODE_ENV=test`) are set in `test/setup-env.ts`,
wired via `setupFiles` in `jest-e2e.json`.

```ts
let app: INestApplication;
let prisma: PrismaService;
let db: TestDb;

beforeAll(async () => {
  db = await startTestDb();                   // start postgres:16 + migrate deploy
  ({ app, prisma } = await bootstrapTestApp({ db }));

  // Seed the minimum fixtures the suite needs:
  await app.get(CompanyService).seedIfEmpty();
  await app.get(AccountsService).seedIfEmpty();
  await app.get(PeriodsService).generatePeriods(2026);
}, 120_000);                                  // generous timeout: container + migrate

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  await db?.stop();
});
```

`bootstrapTestApp` options:
- `{ pipe: false }` — skip the `ValidationPipe` (service-layer specs that don't drive
  HTTP and don't need DTO validation).
- `{ configure: (app) => ... }` — pre-`app.init()` hook for extra middleware (e.g.
  helmet).

Key rules:
- **`bootstrapTestApp` is the only supported way** to bootstrap a new e2e spec.
  Do not hand-roll the module+app setup — the factory mirrors the production
  `main.ts` pipe and applies `enableVersioning` automatically.
- **`overrideProvider(PrismaService)` is wired inside the factory** via
  `makePrismaOverride(db.url)`. `makePrismaOverride` exists because NestJS freezes
  `ConfigModule`'s view of `process.env` at require-time, so we override the
  provider rather than mutate env.
- **`enableVersioning` is applied inside the factory** — forget it (in `main.ts` or
  the OpenAPI export script) and every `/v1/...` request 404s.
- **Seed via the services**, not raw SQL: `CompanyService.seedIfEmpty()`,
  `AccountsService.seedIfEmpty()`, `TaxCodesService.seedIfEmpty()` (when taxes are
  involved), and `PeriodsService.generatePeriods(<year>)` to open posting periods.
  Suites needing auth create users via `UsersService.create(...)` then mint a token
  with `AuthService.login(...)`.
- Suites either call services directly (e.g. `app.get(PostingService).post(...)`)
  or drive HTTP through `supertest` (`request(app.getHttpServer()).post('/v1/...')`).
  The supertest variant automatically gets `ValidationPipe` + `AllExceptionsFilter`
  so HTTP responses match production shapes.
- List endpoints return the `{ data, total, limit, offset }` envelope for the
  transactional lists — destructure `const { data } = await ...list()`.

### Unit test pattern

Unit specs construct the class under test directly and pass **hand-rolled mocks**
for its dependencies — no Nest testing module, no DB. For services that take a
`PrismaService`, mock only the few `client.<model>.<method>` calls the code path
touches and cast the partial object with **`as never`** to satisfy the type
checker (see `src/tax/tax.service.spec.ts`, `src/ledger/balances/balances.service.spec.ts`,
`src/ledger/document-lifecycle.service.spec.ts`):

```ts
const make = (subset = CODES) =>
  new TaxService({
    client: {
      taxCode: {
        findMany: jest.fn().mockImplementation(({ where }) =>
          Promise.resolve(subset.filter((c) => where.id.in.includes(c.id))),
        ),
      },
    },
  } as never);              // partial-prisma mock; `as never` sidesteps the full type

it('SALE with PPN output: settlement = subtotal + PPN, balanced', async () => {
  const r = await make().calculate({ /* ... */ });
  expect(r.settlementAmount).toBe('1110000.0000');
});
```

Keep unit tests focused on a single pure behavior (money rounding, balance signing,
validation guards, tax math). Anything that needs the real DB, migrations, or
cross-module wiring belongs in an e2e suite instead.
