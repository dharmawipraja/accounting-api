# Production Readiness WS1 — Automated Quality Gate & Supply Chain — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A non-mutating `npm run verify` gate, a coverage regression floor, Node 22 LTS pinning, GitHub Actions CI, and dependency scanning — with no application code changes.

**Architecture:** Pure tooling/config on the feature-complete NestJS 11 + Prisma 7 app. "Tests" here are validations that each gate actually bites (planted type error, planted lint warning, a too-high coverage floor), reverted after proving. Frequent commits per the 4-step build sequence.

**Tech Stack:** npm scripts, `tsc --noEmit`, ESLint (typescript-eslint), Jest (`coverageThreshold`), GitHub Actions, Dependabot, Node 22 LTS.

**Spec:** `docs/superpowers/specs/2026-06-12-production-readiness-ws1-quality-gate-design.md`

> **Implementation note (2026-06-12) — coverage pivot.** Task 2 measured unit
> coverage at only ~4% (the 24 unit tests cover Money/env/filter; essentially
> all business logic is exercised by the 122 **e2e** tests). A unit-coverage
> floor was therefore meaningless, so the floor was moved to the **e2e suite**
> (`test/jest-e2e.json`, measured ~86% lines → floor 84/62/84/84). Consequently:
> the e2e jest `rootDir` is now the project root (so `collectCoverageFrom` can
> reach `src/`); a new script `test:e2e:cov` = `jest --config ./test/jest-e2e.json
> --coverage` enforces the floor; and **`verify` = `typecheck && lint:ci && test
> && test:e2e:cov`** (NOT `test:cov && test:e2e`). The CI `verify` job and the
> README reflect this. Where the task text below still says `test:cov`/`test:e2e`,
> the as-built scripts are `test`/`test:e2e:cov`.

**Ground rules:** Work on `main` is NOT allowed — create branch `ws1-quality-gate` first. Docker running for the e2e steps. Prisma 7: `prisma generate` needs a dummy `DATABASE_URL`; never run `prisma format`. The repo has **no git remote** — the workflow/Dependabot files activate on the user's first push to GitHub (a one-time user action, §10 of the spec, NOT built here).

## File structure
- `package.json` — new scripts (`typecheck`, `lint:ci`, `verify`, `audit:ci`), `engines`, `jest.coverageThreshold`.
- `.nvmrc` — `22` (new).
- `.github/workflows/ci.yml` — CI pipeline (new).
- `.github/dependabot.yml` — dependency updates (new).
- `SECURITY.md` — audit policy + accepted-risk note (new).
- `README.md` — add a "Development & CI" section.

---

## Task 1: Scripts + Node 22 pinning

**Files:** `package.json`, `.nvmrc`

- [ ] **Step 1: Create the branch**

```bash
git checkout -b ws1-quality-gate
```

- [ ] **Step 2: Add the four scripts to `package.json`**

In the `"scripts"` block, keep every existing script and add these four (place after the existing `lint`):

```jsonc
    "typecheck": "tsc --noEmit",
    "lint:ci": "eslint \"{src,apps,libs,test}/**/*.ts\" --max-warnings 0",
    "verify": "npm run typecheck && npm run lint:ci && npm run test:cov && npm run test:e2e",
    "audit:ci": "npm audit --omit=dev --audit-level=high",
```

(`lint` keeps its `--fix` for local convenience; `lint:ci` is the non-mutating CI form.)

- [ ] **Step 3: Add `engines` to `package.json`**

Add a top-level `"engines"` block (next to `"scripts"`):

```jsonc
  "engines": {
    "node": ">=22 <23",
    "npm": ">=10"
  },
```

- [ ] **Step 4: Create `.nvmrc`**

Create `/Users/wipraja/Documents/Demo/accounting-api/.nvmrc` containing exactly:

```
22
```

- [ ] **Step 5: Verify `typecheck` runs and passes**

Run: `npm run typecheck`
Expected: exit 0, no output. (The generated Prisma client already exists locally; `tsc --noEmit` uses the strict base `tsconfig.json`.)
If errors surface (a repo-wide `tsc` can catch type issues that `ts-jest`'s per-file compilation masked), they are **real** — fix each at its source (typically a test-file annotation). Do not weaken `tsconfig`. Re-run until exit 0.

- [ ] **Step 6: Verify `lint:ci` passes with zero warnings**

Run: `npm run lint:ci`
Expected: exit 0, no warnings/errors (the tree is already `--fix`-clean from prior work).
If any **warnings** surface (rules set to `warn` that `--max-warnings 0` now rejects), fix them at source. Re-run until exit 0.

- [ ] **Step 7: Verify `audit:ci` passes**

Run: `npm run audit:ci`
Expected: exit 0 — "found 0 vulnerabilities" at the high+ level (the 3 known moderate `@prisma/dev` advisories are below the `high` gate and excluded by `--omit=dev`).

- [ ] **Step 8: Prove `lint:ci` bites (planted warning), then revert**

Temporarily add an unused variable to a source file to trigger a lint error, e.g. in `src/main.ts` add `const _unused = 1;` inside `bootstrap`.
Run: `npm run lint:ci`
Expected: **non-zero exit** (lint failure).
Then revert the change (`git checkout -- src/main.ts`) and re-run `npm run lint:ci` → exit 0.

- [ ] **Step 9: Commit**

```bash
git add package.json .nvmrc
git commit -m "build(ci): add typecheck/lint:ci/verify/audit:ci scripts + pin Node 22 LTS"
```

---

## Task 2: Coverage regression floor

**Files:** `package.json` (the root `"jest"` block)

- [ ] **Step 1: Measure current unit coverage**

Run: `npm run test:cov`
Read the `All files` row of the coverage table — record the four percentages: `% Stmts`, `% Branch`, `% Funcs`, `% Lines`.
Note: `collectCoverageFrom` spans the whole `src` tree (controllers/modules/main.ts/dtos included), and most business logic is exercised by the **e2e** suite, so the unit numbers will be modest. That is expected — this floor is a **regression guard**, not a quality bar; it only ratchets up later.

- [ ] **Step 2: Add `coverageThreshold` to the root `jest` block**

In `package.json`'s `"jest"` object, add a `coverageThreshold` whose `global` values are each `floor(measured) − 2` for the corresponding metric. Worked example — if Step 1 reported Stmts 38.5 / Branch 22.1 / Funcs 41.0 / Lines 39.2, you would write:

```jsonc
    "coverageThreshold": {
      "global": {
        "statements": 36,
        "branches": 20,
        "functions": 39,
        "lines": 37
      }
    }
```

Use YOUR measured numbers, not these. Place it inside the existing `"jest"` block (alongside `coverageDirectory`).

- [ ] **Step 3: Prove the floor bites, then set it correctly**

Temporarily raise one threshold above the measured value (e.g. set `"lines": 100`).
Run: `npm run test:cov`
Expected: **non-zero exit** with a "coverage threshold for lines not met" error.
Then set that threshold back to its `floor(measured) − 2` value.

- [ ] **Step 4: Verify the real floor passes**

Run: `npm run test:cov`
Expected: exit 0 (all four metrics above their floor).

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "test(ci): add jest coverage floor to prevent regression"
```

---

## Task 3: GitHub Actions CI workflow

**Files:** `.github/workflows/ci.yml` (new)

- [ ] **Step 1: Create the workflow**

Create `/Users/wipraja/Documents/Demo/accounting-api/.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - name: Generate Prisma client
        run: npx prisma generate
        env:
          DATABASE_URL: postgresql://build:build@localhost:5432/build?schema=public
      - run: npm run typecheck
      - run: npm run lint:ci
      - run: npm run test:cov
      - run: npm run test:e2e
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: coverage
          path: coverage/
          if-no-files-found: ignore

  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npm run audit:ci

  docker:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build production image
        run: docker build -t accounting-api:ci .
```

Notes baked in: `ubuntu-latest` ships a Docker daemon, so the testcontainers e2e in the `verify` job runs with no `services:` block; the `Generate Prisma client` step mirrors the Dockerfile's dummy `DATABASE_URL`; `node-version-file: .nvmrc` makes `.nvmrc` the single source of the Node version.

- [ ] **Step 2: Validate the workflow YAML**

If `actionlint` is available: `actionlint .github/workflows/ci.yml` → expect no errors.
Otherwise validate it parses: `node -e "require('js-yaml')" 2>/dev/null && npx --yes js-yaml .github/workflows/ci.yml >/dev/null && echo "YAML OK"` — or carefully review: three jobs, correct `uses` pins (`@v4`), the `env` on the generate step, `permissions`/`concurrency` present.

- [ ] **Step 3: Re-run the gate locally to confirm the jobs' commands are green**

Run: `npm run verify`
Expected: typecheck + lint:ci + test:cov + test:e2e all pass (this is exactly what the `verify` job runs, minus the artifact upload). This proves the CI `verify` job will pass once pushed.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add GitHub Actions pipeline (verify + audit + docker build)"
```

---

## Task 4: Dependabot, SECURITY.md, README

**Files:** `.github/dependabot.yml` (new), `SECURITY.md` (new), `README.md` (modify)

- [ ] **Step 1: Create `.github/dependabot.yml`**

Create `/Users/wipraja/Documents/Demo/accounting-api/.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule:
      interval: weekly
    open-pull-requests-limit: 10
    groups:
      minor-and-patch:
        update-types:
          - minor
          - patch
  - package-ecosystem: github-actions
    directory: "/"
    schedule:
      interval: weekly
```

(Minor/patch npm updates are grouped into one PR, each gated by the `verify` workflow. Major bumps — Prisma, NestJS — arrive as individual PRs and are reviewed manually because they are breaking.)

- [ ] **Step 2: Create `SECURITY.md`**

Create `/Users/wipraja/Documents/Demo/accounting-api/SECURITY.md`:

```markdown
# Security Policy

## Reporting a vulnerability

Email security reports to budi@maul.is. Please do not open public issues for
suspected vulnerabilities; we will acknowledge within a few business days.

## Dependency audit policy

CI gates on `npm audit --omit=dev --audit-level=high` (`npm run audit:ci`):
the build fails on **high or critical** advisories in the production dependency
tree. `--omit=dev` scopes the check to what actually ships — the production
image is built with `npm ci --omit=dev`.

### Accepted (tooling-only) advisories

Three **moderate** advisories currently exist in `@prisma/dev` →
`@hono/node-server` (a slash-handling middleware-bypass in Prisma's CLI/dev
tooling). They are accepted because:

- They live only in Prisma's CLI tooling chain, never in application code.
- The production image excludes them: `npm ci --omit=dev` drops `prisma` and
  `@prisma/dev`; only `@prisma/client` + `@prisma/adapter-pg` ship.
- The offered "fix" is a Prisma **downgrade** (breaking), which we reject.

Re-evaluate when Prisma ships a patched tooling chain. The `high` audit gate
ensures these do not block CI while still catching anything that reaches
production.

## Dependency updates

Dependabot opens weekly PRs (npm minor/patch grouped; GitHub Actions). Each PR
is gated by the CI `verify` workflow. **Major version bumps (Prisma, NestJS)
are reviewed and merged manually** — they are breaking and need migration care.
```

- [ ] **Step 3: Add a "Development & CI" section to `README.md`**

Append to `/Users/wipraja/Documents/Demo/accounting-api/README.md`:

```markdown

## Development & CI

This repo standardizes on **Node 22 LTS** (`.nvmrc`). Match it locally:

```bash
nvm install 22 && nvm use   # reads .nvmrc
npm ci
```

Before pushing, run the full gate locally:

```bash
npm run verify   # typecheck + lint (no-fix, zero warnings) + unit (with coverage floor) + e2e
```

CI (GitHub Actions, `.github/workflows/ci.yml`) runs the same gate plus a
`npm audit` (high+) and a production `docker build` on every push/PR to `main`.

Dependency updates arrive via Dependabot. **Minor/patch** PRs are auto-grouped
and safe to merge once green; **major** bumps (Prisma, NestJS) are reviewed
manually because they are breaking. See `SECURITY.md` for the audit policy.
```

(If the README already ends without a trailing newline, ensure one blank line separates the new section.)

- [ ] **Step 4: Final verification + commit**

```bash
npm run verify        # the whole gate is green end-to-end
npm run audit:ci      # exit 0
git add .github/dependabot.yml SECURITY.md README.md
git commit -m "ci: add Dependabot, SECURITY.md audit policy, and dev/CI docs"
```

- [ ] **Step 5: Report the one-time user action**

Remind the user (do NOT attempt it — there is no remote and it is theirs to do): the workflow and Dependabot activate on the first push to GitHub, e.g.
`gh repo create <name> --source=. --private --push` (run via the session `!` prefix), or `git remote add origin <url> && git push -u origin main`.

---

## Self-review (against the spec)

**Spec coverage:**
- §3 scripts (typecheck, lint:ci, verify, audit:ci) → Task 1 Steps 2 ✓
- §4 coverage floor (measure → floor−2 → prove it bites) → Task 2 ✓
- §5 Node 22 pinning (engines, .nvmrc, CI via node-version-file; Dockerfile already 22) → Task 1 Steps 3-4 + Task 3 (setup-node uses .nvmrc) ✓
- §6 ci.yml (verify/audit/docker jobs, permissions, concurrency, prisma generate dummy URL, testcontainers no services block) → Task 3 ✓
- §7 dependabot (npm grouped + actions, majors manual) → Task 4 Step 1 ✓
- §8 SECURITY.md (audit policy + 3 moderate accepted + reporting) → Task 4 Step 2 ✓
- §9 validation strategy (planted type error/lint warning/too-high floor bite) → Task 1 Step 8 + Task 2 Step 3 ✓ (typecheck-bite is implicitly covered by Step 5's "fix real errors"; lint + coverage bites are explicit)
- §5 README dev section + §7 manual-major policy → Task 4 Step 3 ✓
- §10 user action (no remote; activate on push) → Task 4 Step 5 ✓

**Placeholder scan:** the coverage thresholds are deliberately measured-at-implementation (Task 2 Steps 1-2 give the exact procedure + a worked example + the `floor(measured)−2` formula) — a defined computation, not a TBD. No other placeholders.

**Consistency:** script names (`typecheck`/`lint:ci`/`verify`/`audit:ci`) are identical across Task 1, the ci.yml job steps (Task 3), and the README (Task 4). `.nvmrc` value `22` matches `engines` `>=22 <23` and the Dockerfile's `node:22`. The dummy `DATABASE_URL` matches the Dockerfile's.
