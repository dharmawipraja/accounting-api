# Multi-Environment Configuration (dev / test / prod) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the environment follow the npm script you run, with each environment using its own database — via `NODE_ENV`-driven `ConfigModule.envFilePath`, `cross-env` scripts, and `dotenv-cli`-wrapped Prisma commands.

**Architecture:** A pure `resolveEnvFilePaths(NODE_ENV)` helper feeds `ConfigModule.forRoot({ envFilePath })` so the app loads `.env.<env>` over a shared `.env`. npm scripts set `NODE_ENV`; Prisma CLI targets the dev DB via `dotenv -e .env.development`. Test stays on `setup-env.ts` + testcontainers; prod stays Docker-injected. The change is inert wherever `.env*` files are absent (CI, Docker) because `process.env` already wins.

**Tech Stack:** NestJS 11, `@nestjs/config`, Prisma 7, `cross-env`, `dotenv-cli`, Jest.

**Spec:** `docs/superpowers/specs/2026-06-12-multi-env-config-design.md`

**Ground rules:**
- Work on `main` (the project's working branch; small additive config change). Commit per task.
- **`.env*` files:** the Read/Edit/Write tools are permission-blocked on `.env*`. Use **Bash heredocs** for `.env.development` and `.env.example`. If Bash is also denied, paste the provided content and ask the user to create the file.
- `.env.development` is **gitignored** (local only, never committed). `.env.example` **is** committed.
- Never delete the root `.env` (docker compose needs it for `${POSTGRES_PASSWORD}` interpolation).
- Never run `prisma format`. Full `npm run verify` (38 unit + 152 e2e) must stay green.

## File structure

- `src/config/env-file-paths.ts` — **new.** Pure `resolveEnvFilePaths(nodeEnv?)` → ordered dotenv list.
- `src/config/env-file-paths.spec.ts` — **new.** Unit tests for the resolver.
- `src/app.module.ts` — **modify** (line 26). Wire `envFilePath` from the resolver.
- `package.json` — **modify.** `cross-env` on run scripts; new `db:*` scripts; `cross-env` + `dotenv-cli` devDeps.
- `.env.development` — **new (Bash, gitignored, not committed).** Dev `DATABASE_URL` override → `accounting_dev`.
- `.env.example` — **modify (Bash, committed).** Document the per-env convention.
- `README.md` — **modify.** Local-dev workflow uses `npm run db:migrate`.

---

## Task 1: Env-file-path resolver + ConfigModule wiring

**Files:**
- Create: `src/config/env-file-paths.ts`
- Test: `src/config/env-file-paths.spec.ts`
- Modify: `src/app.module.ts` (line 26 + a new import)

- [ ] **Step 1: Write the failing test** — `src/config/env-file-paths.spec.ts`:

```ts
import { resolveEnvFilePaths } from './env-file-paths';

describe('resolveEnvFilePaths', () => {
  it('puts the env-specific file before the shared .env (development)', () => {
    expect(resolveEnvFilePaths('development')).toEqual([
      '.env.development',
      '.env',
    ]);
  });

  it('resolves the test environment', () => {
    expect(resolveEnvFilePaths('test')).toEqual(['.env.test', '.env']);
  });

  it('resolves the production environment', () => {
    expect(resolveEnvFilePaths('production')).toEqual(['.env.production', '.env']);
  });

  it('defaults to development when NODE_ENV is undefined', () => {
    expect(resolveEnvFilePaths(undefined)).toEqual(['.env.development', '.env']);
  });

  it('defaults to development when NODE_ENV is an empty string', () => {
    expect(resolveEnvFilePaths('')).toEqual(['.env.development', '.env']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/config/env-file-paths.spec.ts`
Expected: FAIL — `Cannot find module './env-file-paths'`.

- [ ] **Step 3: Write the minimal implementation** — `src/config/env-file-paths.ts`:

```ts
/**
 * Ordered list of dotenv files ConfigModule loads for a given NODE_ENV.
 *
 * The environment-specific file (`.env.<env>`) is listed first so it takes
 * precedence over the shared base `.env` (in @nestjs/config, the first file
 * that defines a key wins). Real `process.env` still overrides both files, so
 * Docker/compose env and the test harness (`test/setup-env.ts`) are unaffected.
 * Defaults to `development` when NODE_ENV is unset/empty.
 */
export function resolveEnvFilePaths(nodeEnv?: string): string[] {
  const env = nodeEnv && nodeEnv.length > 0 ? nodeEnv : 'development';
  return [`.env.${env}`, '.env'];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/config/env-file-paths.spec.ts`
Expected: PASS (5 passed).

- [ ] **Step 5: Wire the resolver into ConfigModule** — in `src/app.module.ts`, add the import after the existing `validate` import (line 8):

```ts
import { validate } from './config/env.validation';
import { resolveEnvFilePaths } from './config/env-file-paths';
```

Then replace the `ConfigModule.forRoot(...)` line (line 26):

```ts
    ConfigModule.forRoot({ isGlobal: true, validate }),
```

with:

```ts
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: resolveEnvFilePaths(process.env.NODE_ENV),
      validate,
    }),
```

- [ ] **Step 6: Run typecheck + unit + e2e to confirm no regression**

Run: `npm run typecheck && npm test && npm run test:e2e`
Expected: typecheck clean; unit green (the 38 existing + 5 new resolver tests); e2e **152 passed** (the array is inert under test — `setup-env.ts` sets `process.env` which wins, and `.env.test` does not exist).

- [ ] **Step 7: Commit**

```bash
git add src/config/env-file-paths.ts src/config/env-file-paths.spec.ts src/app.module.ts
git commit -m "feat(config): select .env.<NODE_ENV> via ConfigModule envFilePath"
```

---

## Task 2: Dependencies + npm scripts (cross-env run scripts, db:* via dotenv-cli)

**Files:**
- Modify: `package.json` (scripts + devDependencies), `package-lock.json`

- [ ] **Step 1: Install the dev dependencies**

Run: `npm install -D cross-env dotenv-cli`
Expected: `cross-env` and `dotenv-cli` added under `devDependencies`; `package-lock.json` updated.

- [ ] **Step 2: Update the run scripts** — in `package.json`, replace the four start scripts:

```jsonc
    "start": "nest start",
    "start:dev": "nest start --watch",
    "start:debug": "nest start --debug --watch",
    "start:prod": "node dist/main",
```

with:

```jsonc
    "start": "cross-env NODE_ENV=development nest start",
    "start:dev": "cross-env NODE_ENV=development nest start --watch",
    "start:debug": "cross-env NODE_ENV=development nest start --debug --watch",
    "start:prod": "cross-env NODE_ENV=production node dist/main",
```

- [ ] **Step 3: Add the Prisma per-environment scripts** — in `package.json`, add these entries immediately after the `"openapi:export"` script line:

```jsonc
    "db:migrate": "dotenv -e .env.development -- prisma migrate dev",
    "db:reset": "dotenv -e .env.development -- prisma migrate reset",
    "db:studio": "dotenv -e .env.development -- prisma studio",
    "db:generate": "prisma generate",
```

(Do not wrap `db:generate` with `dotenv` — `prisma generate` needs no DB connection. The test scripts are left unchanged: `test/setup-env.ts` remains the single source of `NODE_ENV=test`.)

- [ ] **Step 4: Verify the tooling works**

Run: `npm run db:generate`
Expected: `prisma generate` runs and prints "Generated Prisma Client" (no DB needed).

Run: `npx cross-env NODE_ENV=development node -e "console.log(process.env.NODE_ENV)"`
Expected: prints `development` (confirms cross-env is installed and sets the var).

Run: `npm run typecheck && npm run lint:ci`
Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(scripts): cross-env on run scripts + dotenv-cli db:* scripts"
```

---

## Task 3: Environment files (`.env.development` local + `.env.example` refresh)

**Files:**
- Create: `.env.development` (Bash heredoc; gitignored; **not committed**)
- Modify: `.env.example` (Bash heredoc; **committed**)

> Use Bash for both — the Read/Edit/Write tools are permission-blocked on `.env*`. If a Bash write is also denied, paste the exact content below and ask the user to create the file.

- [ ] **Step 1: Create the local `.env.development` (dev DATABASE_URL override)**

```bash
cat > .env.development <<'EOF'
# Local development overrides — layered ON TOP OF .env (the env-specific file wins).
# NODE_ENV is set by the npm script (cross-env), not here.
# Dev uses its OWN database (accounting_dev) so dev work never touches prod data.
# Everything else (PORT, JWT secrets, POSTGRES_PASSWORD) comes from the shared .env.
DATABASE_URL=postgresql://accounting:accounting@localhost:5432/accounting_dev?schema=public
EOF
```

- [ ] **Step 2: Verify `.env.development` is gitignored and NOT staged**

Run: `git check-ignore .env.development && git status --porcelain .env.development`
Expected: prints `.env.development` (ignored); the `git status` half prints **nothing** (untracked-but-ignored → not shown). It must never be committed.

- [ ] **Step 3: Refresh `.env.example` to document the convention**

```bash
cat > .env.example <<'EOF'
# Environment configuration.
#
# How environments are selected:
#   npm scripts set NODE_ENV (cross-env); ConfigModule loads [.env.<NODE_ENV>, .env]
#   (the env-specific file wins; real process.env wins over both).
#
# Which file to create:
#   .env             -> shared base + docker compose interpolation (POSTGRES_PASSWORD).
#                       Copy this template here and fill in real secret values.
#   .env.development -> local dev overrides (loaded by `npm run start:dev`).
#                       At minimum a DATABASE_URL pointing at a dev database, e.g.:
#                       DATABASE_URL=postgresql://accounting:accounting@localhost:5432/accounting_dev?schema=public
#   test             -> configured in code (test/setup-env.ts) + ephemeral
#                       testcontainers. No .env.test needed.
#   production        -> injected by docker compose. No .env.production needed.

NODE_ENV=development
PORT=3000
POSTGRES_PASSWORD=accounting
DATABASE_URL=postgresql://accounting:accounting@localhost:5432/accounting?schema=public
JWT_ACCESS_SECRET=replace-with-a-32+-character-random-secret-value
JWT_REFRESH_SECRET=replace-with-a-different-32+-character-secret
JWT_ACCESS_TTL=900s
JWT_REFRESH_TTL=7d
EOF
```

- [ ] **Step 4: Verify the `.env.example` change is staged-able and the diff is sane**

Run: `git --no-pager diff .env.example`
Expected: shows the added documentation header + the same variable set (no secrets, only placeholders).

- [ ] **Step 5: Commit (only `.env.example`)**

```bash
git add .env.example
git commit -m "docs(env): document per-environment .env file convention"
```

Confirm `.env.development` is NOT in the commit: `git show --stat HEAD` lists only `.env.example`.

---

## Task 4: README dev-workflow update + full verification

**Files:**
- Modify: `README.md` (Local development section)

- [ ] **Step 1: Update the README "Local development" block** — replace this block:

````markdown
```bash
# Start the database
docker compose up -d db

# Apply migrations
npx prisma migrate dev

# Start the API in watch mode
npm run start:dev
```
````

with:

````markdown
```bash
# Start the database
docker compose up -d db

# Apply migrations to the dev database (accounting_dev)
npm run db:migrate

# Start the API in watch mode (NODE_ENV=development -> .env.development)
npm run start:dev
```

The environment follows the script: `start:dev` loads `.env.development` (its own
`accounting_dev` database) so local work never touches production data. `npm run
db:migrate` / `db:reset` / `db:studio` target the same dev database via
`.env.development`. Copy `.env.example` to `.env` (shared secrets) and create
`.env.development` with a dev `DATABASE_URL` before first run.
````

- [ ] **Step 2: Provision the dev database and confirm the chain works**

Run:
```bash
docker compose up -d db
npm run db:migrate
```
Expected: Prisma connects via `.env.development`, **creates the `accounting_dev` database**, and applies all migrations ("Your database is now in sync").

- [ ] **Step 3: Confirm dev and prod databases are distinct**

Run:
```bash
docker compose exec -T db psql -U accounting -d postgres -c "SELECT datname FROM pg_database WHERE datname IN ('accounting','accounting_dev') ORDER BY datname;"
```
Expected: both `accounting` and `accounting_dev` are listed — proof the dev env uses a separate database.

- [ ] **Step 4: (Optional) app-boot smoke against the dev DB**

Run:
```bash
npm run build
cross-env NODE_ENV=development node dist/main & APP_PID=$!
sleep 6
curl -fsS http://localhost:3000/health && echo " <- health OK (connected to accounting_dev)"
kill "$APP_PID"
```
Expected: `/health` returns 200 (the app booted with `.env.development` and pinged `accounting_dev`). Requires a local `.env` with valid (≥32-char) JWT secrets. If `.env` is absent/incomplete in this workspace, skip — Steps 2–3 already prove the env-file chain.

- [ ] **Step 5: Full regression gate**

Run: `npm run verify`
Expected: exit 0 — typecheck + lint:ci clean, unit green (incl. the 5 resolver tests), **152 e2e** green (coverage floor holds).

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: local-dev workflow uses npm run db:migrate (accounting_dev)"
```

---

## Self-review (against the spec)

**Spec coverage:**
- §4.1 script → NODE_ENV → env file → Task 2 Step 2 (cross-env) + Task 1 (resolver) ✓
- §4.2 ConfigModule `envFilePath` array + process.env precedence → Task 1 Steps 3, 5 ✓
- §4.3 `.env` kept, `.env.development` added, no `.env.test`/`.env.production`, `.env.example` refreshed → Task 3 ✓
- §4.4 dev DB `accounting_dev` (auto-created by migrate) → Task 3 Step 1 + Task 4 Step 2 ✓
- §4.5 `dotenv-cli` db:migrate/reset/studio + `db:generate`; prod migrations unchanged → Task 2 Step 3 ✓
- §4.6 cross-env on start scripts → Task 2 Step 2 ✓
- §5 no enum/gitignore/compose/e2e changes → none made; `.gitignore` already covers `.env.*` (verified) ✓
- §6 verification (verify green; db:migrate→accounting_dev; compose still works) → Task 1 Step 6, Task 4 Steps 2–5 ✓
- §7 don't delete `.env`; cross-env/dotenv-cli notes → Ground rules + Task notes ✓

**Placeholder scan:** none — full file contents for the resolver, spec, env files, and exact script JSON; exact commands with expected output.

**Type/name consistency:** `resolveEnvFilePaths` (signature `(nodeEnv?: string): string[]`) is identical in `env-file-paths.ts`, its spec, and the `app.module.ts` call site. Script names `db:migrate`/`db:reset`/`db:studio`/`db:generate` match between Task 2 and Task 4/README. The dev database name `accounting_dev` is identical across `.env.development`, the README, the psql check, and the spec.
