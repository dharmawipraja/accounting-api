# accounting-api

A single-company Indonesian accounting API built on NestJS. Phase 1 establishes the foundation: JWT authentication with RBAC (four roles: ADMIN, ACCOUNTANT, APPROVER, VIEWER), Prisma 7 + PostgreSQL with a soft-delete extension, a Money value object for currency-safe arithmetic, hardened HTTP middleware (helmet, validation pipe, global exception filter), and readiness/health probes.

## Tech stack

- TypeScript, NestJS
- Prisma 7 + PostgreSQL (via `@prisma/adapter-pg`)
- JWT authentication (access + refresh tokens)
- Docker / Docker Compose

## Prerequisites

- Node.js 22+
- Docker (for the database and production container)

## Setup

1. Copy the example env file and fill in values:

   ```bash
   cp .env.example .env
   ```

   Key variables to set:
   - `DATABASE_URL` — PostgreSQL connection string
   - `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` — must each be at least 32 characters
   - `POSTGRES_PASSWORD` — used by Docker Compose

## Local development

```bash
# Start the database
docker compose up -d db

# Apply migrations
npx prisma migrate dev

# Start the API in watch mode
npm run start:dev
```

## Running with Docker

```bash
docker compose up --build
```

`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, and `POSTGRES_PASSWORD` must be set in the environment or your `.env` file before starting.

## Testing

```bash
# Unit tests
npm test

# Integration tests (requires Docker — spins up testcontainers automatically)
npm run test:e2e
```

## API documentation

OpenAPI is served at `/docs`. It is disabled in production by default; set `ENABLE_SWAGGER=true` in the environment to enable it.

## Database backups

This API holds financial records. For production deployments, schedule regular `pg_dump` backups of the Postgres volume. Example:

```bash
docker compose exec db pg_dump -U accounting accounting > backup.sql
```

Store backups off-host and test restores periodically.
