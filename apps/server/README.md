# QueryDock Server

The server is a NestJS application in this workspace. It serves the built Angular client from the same process and exposes JSON APIs under `/api`. Keep the root module focused on composition; connection/session routes live in `src/feature/connections/`, database behavior is isolated in `src/feature/postgres/`, and liveness is in `src/feature/health/`. Shared request and response schemas belong in `packages/contracts`.

## Runtime responsibilities

- The PostgreSQL adapter owns driver connections, metadata discovery, database-specific validation, safe data browsing, migration preview, and transactional migration apply. The client submits operations and the SQL it reviewed; the adapter regenerates expected SQL and applies only an exact match.
- Connection credentials stay in server memory, keyed by an opaque, HTTP-only browser session cookie. API connection summaries omit passwords. Sessions expire after inactivity and are discarded when the process stops.
- The optional `QUERYDOCK_ALLOWED_DATABASE_HOSTS` comma-separated list restricts database destinations. Leave it unset when users need to choose hosts dynamically. `QUERYDOCK_COOKIE_SECURE` can explicitly enable or disable the Secure cookie attribute; otherwise production uses Secure cookies. `PORT` sets the listener port, and `QUERYDOCK_SERVER_HOST` overrides the bind address (production defaults to `0.0.0.0`).

## API surface

- `GET /api/health` reports process liveness.
- `POST /api/connections`, `GET /api/connections`, and `DELETE /api/connections/:connectionId` manage session-scoped connections.
- Connection routes expose resources, field types, table metadata, read-only table data queries, foreign-key target choices, field-draft previews, migration previews, and migration apply. See controller decorators and shared Zod schemas for exact paths and payloads; validate input at the API boundary and keep database-specific rules in the adapter.

## Development and verification

From the repository root:

- `pnpm --filter @querydock/server start:dev` starts Nest in watch mode.
- `pnpm --filter @querydock/server typecheck` checks server source TypeScript.
- `pnpm --filter @querydock/server test` runs server unit and integration suites; the PostgreSQL integration suite skips without a configured test database.
- `pnpm --filter @querydock/server build` compiles the production server bundle.

Place tests in `test/*.spec.ts`. Keep unit tests independent of a live database by mocking `pg`. For adapter integration tests, set `QUERYDOCK_TEST_DATABASE_URL` to a disposable database whose name includes `test`; the suite creates and removes a uniquely named schema. Never point it at production data or commit connection credentials.

## Method documentation

Document exported APIs and non-obvious helpers with concise JSDoc describing their purpose, side effects, and important invariants. Keep comments accurate as behavior changes; prefer explaining why a boundary exists over restating a method name.
