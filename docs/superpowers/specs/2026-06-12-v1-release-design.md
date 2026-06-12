# v1.0.0 Release — Design Spec

- **Date:** 2026-06-12
- **Status:** Approved (pending written-spec review)
- **Owner:** budi@maul.is
- **Builds on:** the feature-complete + production-hardened accounting API (all 6 build phases + WS1–WS4 production-readiness merged to `main`, HEAD `ada0dcd`).

## 1. Goal & intent

Cut a clean, tagged, documented **`1.0.0`** of the accounting API for **internal / self-hosted** deployment. This is a release-engineering effort — version-stamping, release notes, a README refresh, and an annotated git tag. **No application behavior changes.** The package stays `private: true`; there is **no git remote, no GitHub Release, no npm publish, and no LICENSE** (decided during brainstorming).

Deployment is unchanged and out of this scope: a deployer checks out `v1.0.0` and runs `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build`.

## 2. Current state (verified)

- `package.json`: `version: "0.0.1"`, `private: true`.
- Git: **no tags**, **no remote**. Working tree carries only an unrelated `package-lock.json` diff (npm `libc`-field churn).
- No `CHANGELOG.md`, no `LICENSE`.
- OpenAPI version hardcoded `'1.0'` in `src/main.ts:57` and `src/scripts/export-openapi.ts:20` (the latter feeds `docs/api/openapi.json`).
- `README.md` is stale — it still frames the project as *"Phase 1 establishes the foundation,"* though all 6 phases + WS1–4 are merged.
- Test baseline: 38 unit + 152 e2e green (`npm run verify`).

## 3. Deliverables

A single release commit (`chore(release): v1.0.0`) plus an annotated tag `v1.0.0` on it.

### 3.1 Pre-flight (clean tree + green gate)
1. **Discard the stray `package-lock.json` diff** — `git checkout -- package-lock.json` — so the tagged tree is clean. It is unrelated npm churn, not part of the release.
2. **Green gate** — run `npm run verify` (= `typecheck` + `lint:ci` + unit `test` + `test:e2e:cov`). The tag MUST sit on a green commit. Docker must be running for the e2e testcontainers. If `verify` fails, STOP and fix before tagging.
   - **Anticipated coverage interaction (one config touch, conditional):** `test/jest-e2e.json` `collectCoverageFrom` includes `<rootDir>/src/**` and excludes `main.ts` but **not** `src/scripts/**`. The never-imported build-time script `src/scripts/export-openapi.ts` therefore counts as 0%-covered in the e2e coverage denominator (floor 84/62/84/84). If `test:e2e:cov` fails **solely** because that script regresses the floor, add `"!<rootDir>/src/scripts/**"` to `collectCoverageFrom` (build-time tooling — same rationale as the existing `main.ts` exclusion) and re-run `verify`. This is the only anticipated config change; if the floor already holds with the script present, leave the config untouched.

### 3.2 Version stamp
3. `package.json` `version`: `0.0.1` → `1.0.0`. Keep `private: true`.
4. OpenAPI version: `.setVersion('1.0')` → `.setVersion('1.0.0')` in **both** `src/main.ts:57` and `src/scripts/export-openapi.ts:20`.
5. **Regenerate the contract** — `npm run openapi:export` (= `nest build && node dist/scripts/export-openapi.js`). The only change in `docs/api/openapi.json` is `info.version: "1.0"` → `"1.0.0"` (the export is otherwise deterministic). Confirm the diff is limited to that field.
6. **`CHANGELOG.md`** (new, repo root) — [Keep a Changelog](https://keepachangelog.com) format. One `## [1.0.0] - 2026-06-12` entry under `### Added`, grouped by capability area:
   - **Foundation & Auth** — JWT + RBAC (ADMIN/ACCOUNTANT/APPROVER/VIEWER), soft-delete, Money value object, typed error envelope, `/health` + `/ready`.
   - **Ledger** — SAK chart of accounts, monthly periods, gapless double-entry posting (draft→post→reverse, SoD), opening balances, trial balance.
   - **Tax** — PPN/PPh engine, tax codes, balanced-journal preview.
   - **Invoicing & AR/AP** — sales invoices, purchase bills, payments (RECEIPT/DISBURSEMENT) with subledger↔control reconciliation.
   - **Reporting** — Neraca, Laba Rugi, Buku Besar, AR/AP aging, Arus Kas, plus the journal register list.
   - **Close & Audit** — reversible year-end close (P&L→Laba Ditahan, year-lock), append-only audit log.
   - **Production hardening** — CI quality gate, input/data-integrity hardening, single-VM deploy infra (Caddy, migrate-on-deploy, backups), observability (traceId, `/metrics`, DSN-gated Sentry, k6 baseline).
   - **Docs** — committed `docs/api/openapi.json` + `frontend-guide.md` + `frontend-agent-brief.md`.
   - A closing one-line note: *"Versioning follows SemVer from this release onward."* Test counts (38 unit + 152 e2e) included in the header line.
7. **`README.md`** — targeted refresh (not a rewrite): replace the Phase-1-only intro with a concise feature-complete capability overview; add pointers to `docs/api/openapi.json` + `docs/api/frontend-guide.md`; reference the prod deploy command and the `CHANGELOG.md`/`v1.0.0`. Keep the existing tech-stack / prerequisites / setup sections intact.
8. **Commit** — `chore(release): v1.0.0`, staging exactly: `package.json`, `src/main.ts`, `src/scripts/export-openapi.ts`, `docs/api/openapi.json`, `CHANGELOG.md`, `README.md` (and `test/jest-e2e.json` **only if** the §3.1 conditional coverage exclusion was applied). Do NOT stage `package-lock.json`.

### 3.3 Tag
9. Annotated tag on the release commit: `git tag -a v1.0.0 -m "accounting-api v1.0.0"`.
10. **Verify** — `git show v1.0.0 --stat` shows the release commit; `node -e "console.log(require('./docs/api/openapi.json').info.version)"` prints `1.0.0`; `node -e "console.log(require('./package.json').version)"` prints `1.0.0`.

## 4. Out of scope

- No git remote, GitHub Release, or npm publish (internal/self-hosted target).
- No `LICENSE` file (stays `private: true`).
- No GPG-signed tag (annotated only; no signing setup assumed).
- No application/behavior/code-logic changes; no dependency changes.
- Activating the WS1 CI/Dependabot workflows (requires a remote — a separate operator action, intentionally not done here).

## 5. Testing / verification

- §3.1 green gate: `npm run verify` passes (38 unit + 152 e2e) before the release commit.
- §3.2 regen: `git diff docs/api/openapi.json` after `openapi:export` shows ONLY `info.version` changed.
- §3.3 verify: the tag resolves to the release commit; `openapi.json` and `package.json` both report `1.0.0`.
- Working tree after tagging: clean except the intentionally-unstaged `package-lock.json` churn.

## 6. Notes / risks

- The release commit changes two `.ts` files (`setVersion` string only) — additive/cosmetic, covered by the green gate; no runtime path depends on the version string.
- If `npm run openapi:export` surfaces any diff beyond `info.version`, investigate before committing (it would mean the committed `openapi.json` had drifted from source).
- The stray `package-lock.json` diff is discarded here for a clean tag; if it later proves intentional it can be addressed separately — it is unrelated to this release.
