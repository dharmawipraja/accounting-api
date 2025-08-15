## Library swap guide

This document lists popular, well‑maintained libraries you can use to replace custom utilities and patterns in this repo. Each item includes what to swap, where it lives, recommended library, why it’s better, and quick adoption notes.

Selection criteria

- Mature and active maintenance
- Strong adoption in the Node/Fastify/Prisma ecosystem
- Security-conscious defaults and good docs

---

### 1) Validation middleware and JSON schema conversion ✅

- Current
  - `src/middleware/validation.js` (validateBody, validateQuery, validateParams, validate, validationPreHandler)
  - `zodToJsonSchema` placeholder in the same file
- Replace with
  - fastify-type-provider-zod (already in deps): integrate at app level
  - @asteasolutions/zod-to-openapi (already in deps) or zod-to-json-schema
  - @fastify/swagger and @fastify/swagger-ui (optional, for docs)
- Why
  - First-class Zod integration with Fastify types, less custom glue code
  - Proper OpenAPI/JSON Schema generation instead of a stub converter
- Adoption
  - In `src/app.js`, wrap the Fastify instance with the Zod type provider and drop most ad‑hoc `preHandler` validations in favor of route-level schemas typed by Zod.
  - Replace the lightweight `zodToJsonSchema` placeholder with a proper converter. This repo already includes `@asteasolutions/zod-to-openapi` — use it (or `zod-to-json-schema`) to generate OpenAPI/JSON Schema from your Zod schemas during startup or build.
  - If you enable docs: register `@fastify/swagger` + `@fastify/swagger-ui` and feed them the schemas produced by the converter. Keep swagger registration behind `features.enableSwagger` in `src/config/index.js` so docs are only enabled when desired.

References

- https://github.com/ts-rest/fastify-type-provider-zod
- https://github.com/asteasolutions/zod-to-openapi
- https://github.com/StefanTerdell/zod-to-json-schema
- https://github.com/fastify/fastify-swagger

---

### 2) Response-time header plugin ✅

- Current
  - `src/middleware/index.js` → `timingPlugin` manually measures and sets `x-response-time`
- Replace with
  - fastify-response-time
- Why
  - Battle-tested plugin that adds `X-Response-Time` automatically with minimal overhead
- Adoption
  - Register the plugin in `src/app.js`; remove the custom `timingPlugin`.

References

- https://github.com/fastify/fastify-response-time

---

### 3) Request ID header ✅

- Current
  - `src/middleware/index.js` → `requestIdPlugin` sets `x-request-id` from `request.id`
- Replace with
  - fastify-request-id
- Why
  - Standardizes request ID generation/propagation and header naming; integrates with logging
- Adoption
  - Register in `src/app.js`; configure header name if needed; remove custom plugin.

References

- https://github.com/gjurgens/fastify-request-id

---

### 4) Money/decimal math and rounding ✅

- Current
  - `src/utils/index.js` → `roundMoney` uses `lodash.round(Number(value))`
  - Various routes convert Prisma Decimal to Number then round
- Replace with
  - decimal.js or Dinero.js
- Why
  - Avoid floating-point errors. Prisma returns Decimal objects for `@db.Decimal` fields; using a decimal library preserves precision for financial data
- Adoption
  - Use `Decimal` (from `decimal.js`) or Dinero to add/subtract/round; avoid `Number()` casts for amounts; only convert to string/number at response boundaries

References

- https://github.com/MikeMcl/decimal.js/
- https://v2.dinerojs.com/

---

### 5) Soft delete policy (Prisma extension) ✅

- Current
  - Manual `deletedAt` checks and updates in routes and `src/config/db-utils.js`
- Implemented
  - Centralized soft-delete behavior added directly to the Prisma client via a small in-repo middleware in `src/config/database.js`.
  - Reads automatically exclude soft-deleted rows (`deletedAt != null`), `delete`/`deleteMany` are converted into `update`/`updateMany` that set `deletedAt` timestamp, and helpers in `src/config/db-utils.js` were simplified to rely on the middleware.
  - Callers can opt-out of the soft-delete filter by passing `includeSoftDeleted: true` in the Prisma args (the middleware removes this flag before forwarding to Prisma).

- Why
  - Centralized behavior reduces boilerplate and risk of missed filters without adding a third-party dependency. It also preserves existing routes while simplifying future maintenance.

- Adoption notes
  - The middleware lives in `src/config/database.js`. Most existing code no longer needs to specify `deletedAt: null` in queries.
  - If a specific query must include soft-deleted records, pass `includeSoftDeleted: true` in the Prisma args (e.g., `prisma.user.findMany({ where: {...}, includeSoftDeleted: true })`).
  - A follow-up could be to replace this in-repo middleware with `prisma-extension-soft-delete` if you prefer a maintained external package; the current approach minimizes dependency churn and keeps control local.

References

- (implemented in-repo middleware; external alternative) https://github.com/Notifi-Tech/prisma-extension-soft-delete

---

### 6) Password hashing

- Current
  - `src/middleware/auth.js` uses `bcrypt`
- Replace with (optional hardening)
  - argon2
- Why
  - Argon2 is the modern, memory-hard KDF recommended by OWASP; excellent library support
- Adoption
  - Swap `hash`/`verify` to `argon2.hash`/`argon2.verify`; configure parameters per OWASP recommendations

References

- https://github.com/ranisalt/node-argon2
- https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html

---

### 7) Health, readiness, and load shedding ✅

- Current
  - Custom `/health` and `/ready` routes + DB checks
- Replace with (augment)
  - @fastify/under-pressure
- Why
  - Built-in health checks, event-loop/memory monitoring, and automatic 503 when under load; can integrate custom DB checks
- Adoption
  - Register in `src/app.js`; use `healthCheck` option to call Prisma check; keep your existing endpoints but rely on Under Pressure for protection

References

- https://github.com/fastify/under-pressure

---

### 8) API metrics (Prometheus)

- Current
  - No metrics, custom slow-query logs only
- Replace with (add)
  - @fastify/metrics (Prometheus via `prom-client`)
- Why
  - Standard HTTP metrics (latency, RPS, errors) and custom counters/histograms for DB queries and business events
- Adoption
  - Register the plugin; expose `/metrics`; add custom labels if needed

References

- https://github.com/fastify/fastify-metrics

---

### 9) HTTP caching (ETag/Cache-Control) ✅

- Current
  - Manual responses without caching helpers
- Replace with (add where safe)
  - @fastify/caching
- Why
  - Automatic ETag and cache headers for GET endpoints; reduces bandwidth and load
- Adoption
  - Register with sensible defaults; enable on idempotent read endpoints

References

- https://github.com/fastify/fastify-caching

---

### 10) Date handling utilities ✅

- Current
  - Manual `Date` arithmetic and boundary normalization in routes
- Replace with
  - date-fns
- Why
  - Safer, clearer date parsing, validation, and range math (startOfDay, endOfDay, isAfter, etc.)
- Adoption
  - Use `parseISO`, `startOfDay`, `endOfDay`, `isAfter`, `isBefore` in ledger filters and similar logic

Implementation notes (done)

- Replaced manual `Date` parsing and `setHours` normalization with `date-fns` helpers.
- Files changed:
  - `src/routes/ledgers.js` — now imports `parseISO`, `startOfDay`, `endOfDay` and uses them to normalize `startDate`/`endDate` query params; ledger creation/update still accepts ISO strings but is parsed consistently.
  - `src/config/db-utils.js` — `buildDateRangeFilter` now uses `parseISO` + `startOfDay`/`endOfDay` with a safe fallback to `new Date()` when parsing fails; `createLedgerEntry` and `getTrialBalance` now resolve string dates via `parseISO` for consistent behavior.

Quick testing

- Ran `npm install` to add `date-fns` and executed ESLint. Imports of the modified modules were validated with Node to ensure no syntax/import errors.

Adoption guidance

- Keep accepting ISO date strings in APIs. Use `parseISO` at service boundaries and `startOfDay`/`endOfDay` when computing inclusive day ranges.
- If you want broader timezone handling, consider `date-fns-tz` or switching to UTC-normalization patterns.

References

- https://date-fns.org/

---

### 11) Password strength validation (signup)

- Current
  - Basic length checks in Zod schemas
- Replace with (augment)
  - zxcvbn-ts or owasp-password-strength-test
- Why
  - Defends against weak but long passwords; provides actionable feedback to users
- Adoption
  - Add a strength check in user registration/update flow before hashing

References

- https://github.com/zxcvbn-ts/zxcvbn
- https://www.npmjs.com/package/owasp-password-strength-test

---

### 12) Pagination helpers ✅ (implemented)

- Current
  - Custom pagination math lived in `src/utils/index.js` (`getPaginationMeta`, `validatePagination`) and was repeated across routes.
- Implemented
  - Added a lightweight in-repo pagination plugin at `src/plugins/pagination.js` that provides:
    - `request.getPagination()` → { page, limit, skip }
    - `reply.paginate(data, total, extraMeta)` → sends a standardized success response with pagination metadata
  - Replaced manual pagination in `src/routes/users.js` to use the plugin (other routes can adopt the same helpers).
- Why
  - Standardizes page/limit parsing and response metadata without an external dependency. Keeps behavior consistent and simple to extend.
- Adoption
  - The plugin is registered in `src/app.js`. Call `request.getPagination()` to obtain `skip/limit` for DB queries and use `reply.paginate(results, total)` to return paginated responses.

References

- In-repo implementation; consider replacing with `fastify-paginate` or another maintained plugin in the future if desired.

---

### 13) ID/reference generation (sortable IDs)

- Current
  - `nanoid` for general IDs; ledger reference via `timestamp + nanoid`
- Replace with
  - ulid
- Why
  - Lexicographically sortable identifiers that remain URL-safe; useful for references and logs
- Adoption
  - Use `ulid()` for reference numbers; keep `nanoid` for short random tokens if desired

References

- https://github.com/ulid/javascript

---

### 14) Input sanitization

- Current
  - Manual `trim()` on some strings and plain assignment elsewhere
- Replace with
  - validator
- Why
  - Robust sanitizers/validators (`escape`, `whitelist`, `isISO8601`, etc.) to reduce risks from free‑text fields
- Adoption
  - Apply to user‑supplied strings (e.g., ledger `description`) alongside Zod

References

- https://github.com/validatorjs/validator.js

---

## Quick mapping summary

- validation glue → fastify-type-provider-zod (+ zod-to-openapi / @fastify/swagger)
- response time header → fastify-response-time
- request id header → fastify-request-id
- money/decimal math → decimal.js or Dinero.js
- soft delete policy → prisma-extension-soft-delete
- password hashing → argon2 (optional upgrade)
- health/load → @fastify/under-pressure
- metrics → @fastify/metrics
- HTTP caching → @fastify/caching
- date utils → date-fns
- password strength → zxcvbn-ts or owasp-password-strength-test
- pagination → fastify-paginate (optional)
- sortable references → ulid (optional)
- sanitization → validator (augment)

## Notes

- You already use solid Fastify plugins: `@fastify/helmet`, `@fastify/cors`, `@fastify/rate-limit`, `@fastify/sensible`, `@fastify/jwt`, and `@fastify/compress`. Keep them.
- If you adopt the Zod type provider, many custom `preHandler` validations can be simplified into route schemas while retaining the same behavior.
- For Prisma `Decimal` fields, avoid `Number(x)` in business logic to prevent precision loss; perform arithmetic with a decimal library, then serialize.
