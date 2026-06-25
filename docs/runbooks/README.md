# Runbooks

Operational and developer guides for the accounting API. Start with **local-development** if you're new; jump to **troubleshooting** when something breaks.

## Getting started
- [local-development.md](./local-development.md) — from-scratch local setup: prerequisites, env config, database bring-up, seeding, and running the app.

## Everyday tooling
- [commands.md](./commands.md) — reference for every `npm` script (develop, build, test, database, quality gates, audit, admin) — what each does, when to use it, prerequisites.
- [testing.md](./testing.md) — unit vs. Testcontainers-backed e2e, running a single spec, coverage gates, the `verify` gate, and the known full-suite flakiness.

## Database
- [database-and-migrations.md](./database-and-migrations.md) — Prisma 7 adapter pattern, the hand-authored-migration workflow, `db:*` commands, multi-env databases, seeding, soft-delete discipline.
- [backup-and-restore.md](./backup-and-restore.md) — `pg_dump` backups, retention, and restore steps (+ offsite/encryption activation).

## Understanding the codebase
- [architecture.md](./architecture.md) — module map, request lifecycle (guards → interceptors → filter), and the core invariants & shared seams (double-entry, gapless numbering, `PostingService`, `Money`, idempotency, soft-delete, `AccountRole`).
- [domain-glossary.md](./domain-glossary.md) — the accounting domain (Indonesian GAAP/SAK) mapped to the code: double-entry, chart of accounts, journals/posting, periods, year-end close, AR/AP, PPN/PPh tax, reports.
- [conventions.md](./conventions.md) — binding coding & contribution rules: Money discipline, the error→envelope model, `/v1`/pagination/idempotency API conventions, migrations, the `verify` gate, OpenAPI contract.

## Operations & deploy
- [deploy.md](./deploy.md) — single-VM Docker Compose + Caddy deploy, rollback, the (manual) CD pipeline, monitoring overlay, alert/backup activation.
- [perf-baseline.md](./perf-baseline.md) — k6 load-test baseline, the rate-limiter caveat, and how to interpret results.
- [operator-activation.md](./operator-activation.md) — remaining go-live wiring that needs real secrets/infra (offsite backups, alert delivery, CD deploy) + deferred-by-design notes.

## When things break
- [troubleshooting.md](./troubleshooting.md) — symptom → cause → fix for the common gotchas (stale Prisma client, Docker/e2e, fail-closed Redis 503, env validation, `/v1` 404s, idempotency 422, 408 timeouts, `npm audit`, Swagger/metrics gating).

---

See also: [`../api/frontend-guide.md`](../api/frontend-guide.md) (API contract for frontend devs), [`../api/openapi.json`](../api/openapi.json) (generated OpenAPI), and [`../../README.md`](../../README.md) (project overview).
