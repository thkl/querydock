# QueryDock — Architecture Decisions

Status: architecture decisions; workspace scaffold and initial PostgreSQL connection/schema inspection slice implemented.
Last updated: 2026-10-13.  
This document consolidates the original design notes and subsequent agreed decisions. Where they differ, this document reflects the current direction.

Working product name: **QueryDock** (previously EventuallySQL). Name availability has not yet been checked. The document filename is retained so existing references continue to work.

## 1. Purpose and deployment

QueryDock is a self-hostable database workbench primarily for development. It replaces a subscription desktop database client for everyday schema design, data browsing/editing, and SQL work.

Users change their development database and export a migration file. Their application's existing migration system applies that file to production and owns production migration tracking. QueryDock does not replace that system.

- Run locally on a Mac or deploy the same Docker image to a server.
- Package Angular and NestJS in one container, with NestJS serving the compiled frontend and API on one port.
- During development, run frontend and backend separately with hot reload.
- Start with PostgreSQL, while supporting additional engines through backend adapters.

## 2. Technology and responsibilities

- Frontend: Angular and TypeScript.
- Backend: NestJS and TypeScript.
- Shared contracts: Zod schemas for requests, responses, descriptors, and runtime validation.
- SQL editor: CodeMirror 6 for query tabs and runbook SQL previews, styled to match the workbench. Start with SQL highlighting and editing shortcuts; schema-aware autocomplete can follow.
- Database access: native database drivers inside adapters, using `pg` for PostgreSQL, `mssql` (Tedious) for Microsoft SQL Server, and `mysql2` for MySQL. Do not use an ORM for database access or schema management. Adapters directly control introspection, parameterized data queries, transactions, and migration SQL.
- Repository: pnpm workspaces monorepo. Start without Nx; reconsider it if repository growth warrants additional task/dependency tooling.
- Layout: `apps/web` for Angular, `apps/server` for NestJS, and `packages/contracts` for shared Zod schemas and types.
- Dependency policy: minimize additional dependencies to reduce ongoing update and maintenance work. Add a library only when its benefit justifies its maintenance cost; prefer platform/framework APIs for small, bounded needs. This does not require rebuilding complex components already selected, such as the SQL editor.
- Browser persistence implementation: native IndexedDB behind a small Angular service, without Dexie or an Angular persistence wrapper. The service owns database version upgrades, transactions, and settings/runbook storage.
- Styling: plain CSS without an additional UI framework or Tailwind. Use shared CSS custom properties for semantic colors, spacing, and typography, with light/dark theme values. Map aGrid and CodeMirror themes to the same variables. Theme preference is a browser-persisted setting.
- Client organization: feature-based directories under `apps/web/src/app/feature/`, with workspace areas such as `sidebar/`, `table-data/`, `table-schema/`, `query/`, and `runbook/`. Keep Angular HTML templates in separate files. `AppComponent` hosts only the root router outlet; the workspace shell owns shared navigation and chrome.
- Server organization: feature-based code under `apps/server/src/feature/`; the root NestJS module composes feature modules/controllers.
- Testing: Vitest for frontend and backend tests, using Angular's supported test integration for components. PostgreSQL integration tests verify generated migrations, data batches, and transaction behavior against a real disposable test database. Playwright covers a small set of critical browser workflows. Testing tools are development dependencies.

| Layer | Responsibilities |
| --- | --- |
| Angular | Workspace, tabs, grids, editors, local drafts, runbook ownership, review and export |
| Shared contracts | Resource descriptions, capabilities, structured edit intentions, preview and execution contracts |
| NestJS | Expiring sessions, request validation, adapter dispatch, execution orchestration |
| Resource adapter | Connection validation, discovery, introspection, database semantics, SQL generation, reads/writes, transactional execution |

The client sends structured intentions rather than deciding database semantics. For example, the server and matching adapter interpret changes to an existing table as alterations and generate the appropriate SQL.

## 3. Adapter architecture

PostgreSQL must be implemented behind a ResourceProvider/ResourceAdapter boundary from the start. Additional engines should not require rewriting the workbench or server orchestration.

Adapters own:

- Connection validation and resource discovery.
- Schema introspection, type catalogs, and capabilities.
- Data browsing and batch edits.
- Validation and interpretation of schema changes.
- Identifier quoting, dialect-specific SQL, and dependency ordering.
- SQL query execution and transactional runbook application.

The SQL Server adapter supports connection, resource discovery, schema inspection, bounded data browsing, and guarded row insert/update/delete operations, including data Runbook preview and Apply. Its initial schema migration scope supports permission-gated foreign-key addition/removal and dependency-aware table drops in atomic cross-table batches. Field editing, table rename, and table creation remain unavailable. Snapshots advertise these narrower capabilities separately from `canAlter`; the connection advertises schema workflow support through `editSchema` while individual actions stay adapter- and permission-gated.

The initial MySQL adapter supports connection verification, table/view discovery, schema inspection, and bounded read-only data browsing. Data writes, schema changes, and SQL execution remain unavailable; the adapter advertises those limits through connection and snapshot capabilities. The connection form loads supported engine names and default ports from the server.

Keep capabilities, type/editor descriptors, and current resource metadata distinct. Fetch capabilities per connection because engine version, extensions, and permissions affect behavior. Preserve engine-specific information through extensions rather than forcing every engine into PostgreSQL's feature set.

Descriptors express semantic requirements, not Angular component choices. Angular maps descriptions to reusable controls. Generic grids are the foundation; specialized views may support workflows such as SQL editing and migration review.

## 4. MVP workspace and schema editor

- Multiple simultaneous database connections.
- Unlimited tabs with independent state; each tab belongs to a connection.
- Resource explorer, table structure editor, table data grid, SQL editor, and runbook view.
- The table structure editor has separate editable grids for fields and constraints.
- Fields expose names, types and type parameters, nullability, and default expressions.
- Constraints expose names, kinds, participating fields, and relevant settings, including foreign-key targets and actions.
- Schema edits are drafts until explicitly applied through a runbook.
- Stable draft identities and explicit rename operations distinguish renames from drop-and-add. Constraint references follow field renames.
- Backend adapters validate drafts and generate incremental DDL, including ALTER TABLE statements where appropriate.
- SQL previews surface destructive changes and requirements such as backfills or conversion expressions.

A database relationship diagram is the first feature in Milestone E. It shows tables and foreign-key relationships and supports creating, changing, and removing those relations through adapter-validated runbook operations. Broader ER modeling remains a possible P3 addition. Preserve relationship metadata and stable identities so the diagram uses the same editing model as the schema grids.

## 5. Data browsing and editing

Data viewing and editing are part of MVP.

- Bounded fetching/pagination, filtering, sorting, and refresh.
- Insert rows, edit cells, and delete rows.
- Explicit Save and Discard; do not send an API request for each cell change.
- Accumulate edits locally and submit a batch.
- Handle NULL, defaults, and read-only/generated values explicitly.
- Repeated edits collapse to the final pending value; inserting then deleting an unsaved row cancels that operation.
- Failed saves preserve the in-memory draft for correction.

The save workflow offers two destinations:

1. **Save to dev:** apply ordinary data edits directly to the development database, outside the runbook.
2. **Add to runbook:** send the batch for adapter-generated SQL and stage it in the runbook without changing the database yet. Runbook Apply executes it later.

Runbooks support intentional data changes such as default records and backfills, alongside schema changes. SQL steps can express broad updates without fetching every affected row into the grid.

Safe row identity and conflict detection are required design concerns. Their exact contracts and behavior for tables without suitable keys remain to be specified.

## 6. Runbook model

A runbook represents one migration for one database and may collect changes across multiple tables. Multiple connections are supported, but one runbook does not span databases.

The browser owns the runbook. The server does not persist runbooks or execution history.

### Pending changes

- Structured edits accumulate into a proposed state or operation plan.
- The browser submits changes to the server; the matching adapter validates them and returns generated SQL for review.
- Pending previews may be regenerated as drafts change; do not blindly append SQL for every intermediate edit.
- Generated SQL is read-only in the preview. Edit the originating field/constraint/data draft to regenerate it, or add a separate explicit SQL step for custom work. Do not edit generated SQL independently of its structured draft.
- Before applying, adding then renaming a new field can become one addition with its final name; adding then removing it can cancel the operation.
- Schema and data steps have an intentional execution order, including cross-table dependencies.

Example: add a nullable field, backfill its values, then make it non-nullable.

### Applying and recording

- The runbook UI is an ordered SQL statement list with Apply and execution results, plus export.
- Distinguish pending statements from already applied statements.
- The client submits the reviewed pending batch; the server executes it and returns results.
- The browser records successfully applied SQL and execution results.
- Applied SQL is immutable; subsequent edits form another pending batch within the runbook.
- The initial PostgreSQL Apply flow locks the target table, checks the current fingerprint against the submitted baseline, regenerates statements from structured operations, and compares them with the reviewed SQL before executing the regenerated statements.

### MVP transaction behavior

- Execute each pending PostgreSQL batch in one transaction.
- Success marks the entire batch as applied.
- Failure rolls the batch back, displays the error, and leaves it pending.
- Reject statements incompatible with this transaction model before execution, with an explanation.
- Results include success/failure and affected row counts where available.

### Destructive-change review

- Adapters return structured risk warnings alongside generated SQL, identifying affected objects and potential consequences.
- Destructive or integrity-reducing changes require explicit user confirmation before Apply. Examples include dropping tables/fields, deleting rows, truncating tables, potentially lossy type conversions, and removing protective constraints.
- Confirmation applies only to the reviewed batch. Changing that batch invalidates the confirmation; the server must validate the acknowledgement against the submitted plan. The exact contract remains to be specified.
- Assess generated statements using the originating structured operations and adapter knowledge. Custom SQL may not be fully analyzable; flag uncertainty rather than claiming it is safe.
- Destructive-change confirmation does not override detected schema drift. Drift blocks Apply and requires refreshed metadata and review, without automatic merging.

### Confirmation and uncertain outcomes

- The client marks a batch as applied, or a runbook as completed, only after final server confirmation of success. Sending a request or losing the connection does not establish success.
- Use transactions when the adapter supports them. The PostgreSQL MVP requires the single-transaction behavior described above.
- If client/server synchronization breaks and execution cannot be confirmed, display the outcome as unknown, distinct from pending, applied, or confirmed rolled back.
- Do not automatically retry, replay, reconcile, or repair an unknown outcome. The user must inspect the database and manually reconcile or apply the necessary changes.
- An unknown outcome must not be treated as a confirmed rollback or included as successfully applied SQL in the final export without manual resolution.

### Export and future optimization

- Final export preserves successfully applied steps in execution order, including intermediate changes made during development.
- Export the SQL that actually ran, rather than reconstructing it solely from the final schema.
- The application's migration service later executes the exported file against production.
- A future feature may compare starting and final schema snapshots to remove obsolete back-and-forth schema changes. This is not MVP behavior. Preserve original execution history and account for data transformations when designing it.

## 7. Persistence boundaries

| Location | Stored state |
| --- | --- |
| Browser IndexedDB | Settings and unfinished runbooks, including their necessary original schema baselines, pending SQL, and applied SQL needed for eventual export; optional saved connection profiles are stored only as authenticated ciphertext in a separate vault database |
| Browser memory | Fetched database rows, query results, fetched schema metadata, ordinary unsaved data edits, active UI state, and decrypted connection profiles while the vault is unlocked |
| Expiring server session | Database credentials and connection configuration |
| Server persistent storage | None for application state, runbooks, database data, or execution history |

Do not cache fetched database data in IndexedDB. An explicit exception is data intentionally added to a runbook: its generated INSERT/UPDATE or other migration SQL may contain literal values and may be persisted there.

Also persist the original schema baseline necessary to restore and interpret an unfinished runbook's drafts. This is runbook state, not a general schema metadata cache. Unrelated fetched schema metadata remains in memory. After reconnecting, validate the baseline against the live database before applying changes.

Ordinary data drafts are not restored after reload. Runbook data steps may be restored because the user explicitly chose to include them in a migration.

No SQLite database or persistent server volume is required for application state. Persistence of tab layout as a setting and exact browser recovery behavior still need specification.

## 8. Sessions and connections

- No separate application account system for the initial local tool.
- Authenticate database access using database-native credentials and preserve that user's privileges.
- Keep active connection credentials server-side in expiring browser sessions; do not return them in API responses. Users may opt to save complete connection profiles in a separate browser IndexedDB vault encrypted with a passphrase they choose. Derive a non-extractable AES-GCM-256 key with PBKDF2-HMAC-SHA-256 (600,000 iterations and a random 128-bit salt); use a fresh random 96-bit IV and authenticated record context for every encrypted item. Never store or send the vault passphrase or plaintext saved profile to the server. Decrypt profiles only in memory after explicit unlock; lock on page reload or user request. There is no password recovery: resetting the vault deletes saved profiles. This protects data at rest in IndexedDB, not against malicious same-origin code or a compromised browser while unlocked.
- One browser session can hold multiple connection configurations.
- Save recent connection profiles without passwords: display name, host, port, database, username, and connection options. Reuse active sessions or prompt for the password when reconnecting.
- Use a conventional connection form with `autocomplete="username"` and `autocomplete="current-password"` so the user's browser/password manager can offer credential saving and autofill. Any recent-connection list remains password-free; explicitly saved profiles in the optional QueryDock vault may include credentials only as encrypted browser IndexedDB records.
- Browser-managed saving/autofill varies by browser and associates credentials with QueryDock's origin, so multiple database profiles, particularly repeated usernames, may require manual credential selection. Do not promise automatic one-click reconnection after session expiry.
- Obtain database connections on demand and release/close them after use.
- Session expiry or server restart requires reconnecting before continuing a locally saved runbook.
- Persistent connections for temporary tables, interactive transactions, session state, and cancellation are later considerations.

## 9. Deployment and security constraints

- Bind the published local Docker HTTP port to 127.0.0.1 by default.
- Use appropriate session cookie settings, expiry, origin/CSRF protections, and rate limiting.
- Use database TLS where appropriate.
- QueryDock has no application-account login: users authenticate to databases with the credentials they provide, and database roles authorize operations. Operators may add an access gateway to restrict who can reach the workbench.
- Restrict target hosts with an allowlist or network policy when a deployment should connect only to a fixed set of databases; leave target selection open for trusted self-hosted use cases that require it.
- On Docker Desktop for macOS, host databases may be reached through host.docker.internal.
- Future SQLite/CSV support requires explicit mounts and filesystem permissions.

## 10. Open implementation choices

- Grid candidate: the user's existing [thkl/agrid](https://github.com/thkl/agrid), published as `@thkl/agrid`. Initial inspection of the deployed demo's descriptions and repository README confirms documented custom Angular editors, cell/record edit events, row editing, undo/redo, row/column virtualization, keyboard navigation, and server-side pagination/filtering/sorting. README documents Angular 21/22 support. The Angular 22 workspace now compiles against `@thkl/agrid` 0.1.23, including descriptor-built columns, a custom editor, edit events, and a bounded server-query handler. Interactive behavior still needs browser verification before the candidate is accepted. QueryDock must own batch drafts, safe database row identities, database value semantics, and migration actions. Filter persisted grid settings to avoid retaining fetched data or data-derived values.
- Final grid integration verification.
- Exact Zod descriptor vocabulary and adapter interface.
- Exact MVP coverage of PostgreSQL types, identity/generated fields, constraints, and standalone indexes.
- Row identity, optimistic concurrency, and treatment of tables without suitable keys.
- Stateless preview/apply contracts: baseline representation, drift checks, and ensuring execution matches the reviewed batch.
- Destructive-change acknowledgement contracts and custom SQL risk-analysis coverage.
- UI and explicit user actions for manually resolving unknown execution outcomes; automatic recovery is out of scope.
- Runbook lifecycle, locally retained completed runbooks, export naming, and migration-file format expected by the application.
- Dependency ordering, SQL-step handling, and limits on query/batch execution.
- Browser tab/settings restoration details.

## 11. First implementation milestone

Agreed first end-to-end flow: connect to PostgreSQL, inspect a table, draft a field change, preview generated SQL, apply the reviewed batch, and export the successfully applied SQL from the browser-owned runbook.

Proposed API boundaries, with exact request/response contracts and routes still to be finalized:

| Action | Endpoint | Result |
| --- | --- | --- |
| Connect | `POST /api/connections` | Session-scoped connection ID and capabilities |
| Discover resources | `GET /api/connections/:id/resources` | Schemas and tables |
| Inspect table | `GET /api/connections/:id/tables/:tableId` | Fields, constraints, and baseline reference |
| Preview changes | `POST /api/connections/:id/migrations/preview` | Ordered SQL, warnings, and blocking errors |
| Apply batch | `POST /api/connections/:id/migrations/apply` | Confirmed transaction result |

Preview requests carry the relevant baseline and structured changes rather than relying on persisted server drafts. Apply submits the reviewed plan for validation and execution through the adapter. Baseline representation and reviewed-plan validation remain to be specified. Migration export happens in the browser and requires no export endpoint.

## Guiding rule

The backend describes what can be edited. Angular decides how to present it. The adapter interprets changes and produces database-specific operations. The browser owns the migration runbook; the server validates and executes requests without persisting it.
