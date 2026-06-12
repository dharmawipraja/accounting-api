# Production Readiness — WS1: Automated Quality Gate & Supply Chain — Design Spec

- **Date:** 2026-06-12
- **Status:** Approved (pending written-spec review)
- **Owner:** budi@maul.is
- **Builds on:** the feature-complete 6-phase accounting API (NestJS 11 + Prisma 7 + PostgreSQL), all merged to `main`. No application features are added or changed.

## 1. Program context (production-readiness, decomposed)

Making the existing API production-ready is decomposed into four independent workstreams, each its own spec → plan → build. Sequence approved: **WS1 → WS2 → WS3 → WS4**.

- **WS1 (THIS SPEC) — Automated quality gate & supply chain.** A non-mutating `verify` gate, coverage regression guard, Node pinning, GitHub Actions CI, dependency scanning.
- **WS2 — Code integrity & input-validation hardening.** Soft-delete write guards (`update`/`updateMany`/`upsert`); replace the four `as never` list-filter casts with enum validation (bad `?status`/`?direction` → 422, not a Prisma 500); sweep other unvalidated inputs.
- **WS3 — Runtime & deploy hardening (single VM).** Production `docker-compose` (app + Postgres + reverse proxy) with `HEALTHCHECK`/`restart`/limits; `prisma migrate deploy` as a pre-start deploy step (never in-process); `tini` for PID-1; DB pool sizing + global `statement_timeout`; Postgres backup + restore runbook; reverse-proxy/TLS + body/timeout limits.
- **WS4 — Observability & performance baseline.** `/metrics` Prometheus endpoint; error tracking (Sentry or pino sink); request-id correlation surfaced as `traceId`; load/perf test (k6/autocannon) over hot paths to set a capacity baseline and validate pool/timeout settings.

**Deployment context** (shapes all four): single VM / Docker host (we own the runtime), one company at heavier transaction volume (single instance, tuned), CI on **GitHub Actions**, standardized on **Node 22 LTS**.

## 2. WS1 goals & non-goals

### Goals
- One command (`npm run verify`) that gates a change locally: typecheck + non-mutating lint + unit (with coverage floor) + e2e.
- A GitHub Actions pipeline that runs the gate, a high-severity dependency audit, and a Docker build on every push/PR to `main`.
- Coverage can never silently regress (a measured floor).
- Node version is pinned identically across local, Docker, and CI (closing the v24-vs-22 drift).
- Dependency updates and CVEs surface automatically (Dependabot + audit gate).

### Non-goals (deferred / out of scope)
- WS2–WS4 work (code fixes, runtime/deploy, observability) — separate specs.
- Any application feature change.
- Pushing the Docker image to a registry (the CI `docker` job only proves it builds; publishing is a WS3/deploy concern).
- Creating the GitHub repository / remote — a one-time user action (see §10); the workflow + Dependabot files are authored now and activate on first push.

## 3. Scripts (`package.json`)

Add/adjust scripts (keep all existing ones):

```jsonc
{
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "eslint \"{src,apps,libs,test}/**/*.ts\" --fix",     // unchanged: local convenience
    "lint:ci": "eslint \"{src,apps,libs,test}/**/*.ts\" --max-warnings 0",
    "verify": "npm run typecheck && npm run lint:ci && npm run test:cov && npm run test:e2e",
    "audit:ci": "npm audit --omit=dev --audit-level=high"
  }
}
```

- `typecheck` runs `tsc --noEmit` against the base `tsconfig.json` (already `strict`, `strictNullChecks`, `noImplicitAny`, `noFallthroughCasesInSwitch`). It requires the generated Prisma client, so `prisma generate` must run first (CI does this; locally the client already exists).
- `lint:ci` is **non-mutating** and fails on any warning (`--max-warnings 0`). The existing `lint` keeps `--fix` for local use.
- `verify` is the single local pre-push gate. It is intentionally heavy (includes e2e, ~90s) — correctness over speed.
- `audit:ci` gates only on **high/critical** so the three known moderate Prisma-tooling advisories (see §8) do not block; they are dev-only and excluded from the production image by `--omit=dev`.

## 4. Coverage regression guard

Add a `coverageThreshold` to the **unit** Jest config (the root `jest` block in `package.json` — NOT the e2e config; e2e coverage is slow and less meaningful here).

Procedure (executed during implementation, so the floor reflects reality — not a hardcoded guess):
1. Run `npm run test:cov` and read the global `% Stmts / Branch / Funcs / Lines`.
2. Set each `global` threshold to `floor(measured) − 2` (a small margin to avoid flakey-rounding failures), e.g. measured lines 81.4% → floor 79.
3. Commit the thresholds. CI runs `test:cov`; a drop below the floor fails the build.

```jsonc
// package.json -> "jest": { ... , "coverageThreshold": { "global": { "branches": N, "functions": N, "lines": N, "statements": N } } }
```

The floor only ratchets up over time (raise it when coverage improves); it never silently drops. The number is set from the measured value at implementation time.

## 5. Node version pinning (Node 22 LTS)

- `package.json`: `"engines": { "node": ">=22 <23", "npm": ">=10" }`.
- New `.nvmrc` at repo root containing `22`.
- `Dockerfile`: already `node:22-bookworm-slim` (both stages) — confirm/leave as-is.
- CI: `actions/setup-node` with `node-version-file: .nvmrc` (single source of truth).
- **Developer action:** local dev is currently Node v24 — switch to 22 (`nvm install 22 && nvm use`) so local matches prod. `engines` is advisory; document this in the README's dev-setup section.

## 6. GitHub Actions workflow (`.github/workflows/ci.yml`)

Triggers: `push` and `pull_request` targeting `main`. Top-level `permissions: { contents: read }` (least privilege). `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }`.

Three jobs (all `runs-on: ubuntu-latest`, which ships Docker — so the testcontainers e2e runs with no `services:` block):

**`verify`:**
1. `actions/checkout@v4`
2. `actions/setup-node@v4` with `node-version-file: .nvmrc`, `cache: npm`
3. `npm ci`
4. `npx prisma generate` with a dummy `DATABASE_URL` (the same `postgresql://build:build@localhost:5432/build?schema=public` the Dockerfile uses; `generate` never connects)
5. `npm run typecheck`
6. `npm run lint:ci`
7. `npm run test:cov`
8. `npm run test:e2e` (testcontainers spins its own Postgres per suite; Docker is present on the runner)
9. Upload coverage as an artifact (`actions/upload-artifact@v4`, `if: always()`)

**`audit`:** checkout → setup-node → `npm ci` → `npm run audit:ci`.

**`docker`:** checkout → `docker build -t accounting-api:ci .` (proves the multi-stage production image still builds; no push).

Pin all `actions/*` to a major tag (`@v4`); Dependabot's `github-actions` ecosystem keeps them current.

## 7. Dependency scanning (`.github/dependabot.yml`)

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule: { interval: weekly }
    open-pull-requests-limit: 10
    groups:
      minor-and-patch:
        update-types: [minor, patch]
  - package-ecosystem: github-actions
    directory: "/"
    schedule: { interval: weekly }
```

- Minor/patch npm updates are grouped into one PR to reduce noise; each PR is gated by the `verify` workflow.
- **Major bumps (esp. Prisma, NestJS) are reviewed manually** — they are breaking and need the migration/codemod care this project already documents. Note this in the README.

## 8. Accepted-risk note (`SECURITY.md`)

A short `SECURITY.md` documenting:
- The `audit:ci` policy (gate at `--audit-level=high`, `--omit=dev`).
- The three current **moderate** advisories in `@prisma/dev → @hono/node-server`: they live only in Prisma's CLI/tooling dependency chain, are excluded from the production image (`npm ci --omit=dev` drops `prisma` and `@prisma/dev`), and the only "fix" is a Prisma **downgrade** (rejected). Re-evaluate when Prisma ships a patched tooling chain.
- How to report a vulnerability (a contact/process line).

## 9. Testing / validation strategy

This workstream is tooling, so "tests" are validations that the gate actually gates:
- `npm run verify` passes locally end-to-end (typecheck + lint:ci + test:cov + e2e all green).
- `npm run typecheck` exits non-zero if a deliberate type error is introduced (spot-check, then revert).
- `npm run lint:ci` exits non-zero on a deliberately planted lint warning (spot-check, then revert) — proving `--max-warnings 0` bites.
- `npm run test:cov` fails when a threshold is set above current coverage (spot-check the floor bites, then set it to the real floor).
- `npm run audit:ci` exits 0 today (no high/critical).
- `docker build` succeeds (already verified each phase).
- The workflow YAML is valid (lint via `actionlint` if available, or careful review); job dependencies and the dummy-`DATABASE_URL` generate step are correct.
- A README "Development & CI" section documents `nvm use`, `npm run verify`, and the manual-major-bump policy.

## 10. User action (one-time, not built here)

The repo has no git remote. To activate CI + Dependabot: create a GitHub repository, `git remote add origin …`, and `git push`. The workflow and Dependabot config are committed as part of this workstream and take effect on the first push. (Suggested via the session's `!` prefix: `! gh repo create … --source=. --private --push`.)

## 11. Build sequence (for the plan)

1. **Scripts + Node pinning** — add `typecheck`/`lint:ci`/`verify`/`audit:ci`, `engines`, `.nvmrc`; verify each runs; commit.
2. **Coverage floor** — measure `test:cov`, set `coverageThreshold` at floor; prove it bites; commit.
3. **CI workflow** — author `.github/workflows/ci.yml`; validate structure; commit.
4. **Dependabot + SECURITY.md + README** — author configs/docs; commit.

## 12. Notes / future
- WS2 (code-integrity) is the next spec; it will benefit from this gate (every fix runs through `verify`).
- If CI e2e wall-time becomes a problem, consider sharding suites or a Testcontainers reuse strategy — deferred until measured.
