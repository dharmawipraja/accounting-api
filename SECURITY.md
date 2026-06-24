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

No advisories are currently outstanding. A `package.json` `overrides` block
pins transitive dependencies (`multer`, `form-data`, `@hono/node-server`,
`js-yaml`) to patched versions, bringing both `npm audit` (full) and
`npm audit --omit=dev` to **0 vulnerabilities**.

Re-evaluate overrides when upgrading the packages that pull them in (Prisma,
`@nestjs/platform-express`, `swagger-ui-express`). The `high` audit gate
ensures any new advisories that reach production are caught immediately.

## Dependency updates

Dependabot opens weekly PRs (npm minor/patch grouped; GitHub Actions). Each PR
is gated by the CI `verify` workflow. **Major version bumps (Prisma, NestJS)
are reviewed and merged manually** — they are breaking and need migration care.
