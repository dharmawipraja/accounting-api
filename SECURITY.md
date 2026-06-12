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

Three **moderate** advisories currently exist in `@prisma/dev` ->
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
