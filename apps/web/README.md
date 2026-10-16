# QueryDock Web Client

The Angular 22 client lives under `src/app/feature/workspace/` and is organized by workspace feature. Keep component templates and styles in separate files, use `ChangeDetectionStrategy.OnPush`, and expose component inputs/outputs with signal APIs. The root component remains a router outlet; workspace shell, navigation, dialogs, data browsing, schema editing, and runbook features live in their own components.

## State and API boundaries

- `ConnectionApiService` owns the current server session summary and resource cache. Database behavior and validation come from the server adapter; keep the client focused on forms, display state, and request orchestration.
- `RunbookService` stages reviewed operations and SQL per database target in IndexedDB. It does not store database passwords or fetched table rows.
- `ConnectionVaultService` stores explicitly saved connection profiles encrypted in browser IndexedDB using a user-chosen password.
- `WorkspacePagesService` owns schema, data, new-table, and relationship tabs. Diagram positions and viewport state are scoped by connection.

## Development and tests

From the repository root, use `pnpm --filter @querydock/web start:dev` to run Angular, `pnpm --filter @querydock/web typecheck` to check client TypeScript, `pnpm --filter @querydock/web build` to build the static client, and `pnpm --filter @querydock/web test` to run Vitest tests in `test/*.spec.ts`. The current unit tests mock `fetch` and test state/services without requiring PostgreSQL.

Playwright is not configured in this package yet. When added, browser workflow tests can mock `/api/**` responses, so a database is not needed for those journeys. If a workflow needs realistic server-side PostgreSQL semantics, use the server's disposable PostgreSQL integration database. SQLite would require a separate adapter and would not test the PostgreSQL behavior QueryDock currently ships; do not add an SQLite adapter just to support client tests.

Keep tests focused on user-visible outcomes and important state transitions: connection restore/disconnect, resource navigation, tab persistence, runbook apply/reconciliation, encrypted profile storage, and diagram state. Prefer accessible roles and labels for browser locators.
