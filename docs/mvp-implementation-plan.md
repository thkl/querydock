# QueryDock — MVP Implementation Plan

Status: Milestones B, C, D, and E are complete by user sign-off. Milestone F is in progress. Its first implementation slice adds SQL Server foreign-key changes and dependency-aware table drops; query execution and mixed runbooks remain outstanding.
Date: 2026-10-17.

References:

- [Architecture decisions](architecture-decisions.md)
- [Shared contracts proposal](contracts-plan.md)
- [Milestone D completion checklist](milestone-d-completion-checklist.md)

The architecture decisions are authoritative. Contract names/routes are proposals until implemented and verified. This plan does not authorize deployment or production database changes.

## 1. MVP outcome

Run QueryDock locally in one Docker container, connect to PostgreSQL, inspect and edit table structure/data, execute queries, and collect intentional schema/data changes in a browser-owned runbook. Review and transactionally apply pending SQL to development, then export the successfully applied statements for the application's migration service.

The first usable milestone is the complete flow: **connect → inspect table → draft field change → preview → apply to dev → export**. Finish this before broadening feature coverage.

## 2. Stack and layout

- pnpm workspaces; no Nx initially.
- `apps/web`: Angular, plain CSS, semantic light/dark variables, native IndexedDB service, CodeMirror 6.
- `apps/server`: NestJS, expiring credential sessions, PostgreSQL adapter using `pg`.
- `packages/contracts`: shared Zod schemas and inferred types.
- aGrid (`@thkl/agrid`) is the recommended grid candidate, pending an integration check.
- Vitest for contracts and server migration planning, opt-in real PostgreSQL integration tests, and Playwright planned for critical browser flows.
- One production Docker image; NestJS serves frontend assets and API. Separate hot-reload processes during development.

Select supported compatible framework/runtime versions at implementation time and commit a lockfile. Avoid extra runtime dependencies unless their benefit justifies ongoing maintenance.

## 3. Milestone A — Foundation and grid integration

### Deliverables

- Initialize the workspace and shared-contract build/import paths.
- Configure Angular/NestJS development, shared validation, and Vitest.
- Build the explorer/tab/runbook shell with independent tab state.
- Add plain CSS theme tokens and light/dark preference.
- Prove aGrid integration with descriptor-generated columns, a custom type editor, edit events, and bounded remote paging.
- Integrate CodeMirror for query editing and read-only SQL preview.
- Build a minimal single-container image and local launch instructions.

### Acceptance criteria

- Web and server start in development and production packaging.
- Shared contract validation works on both sides without importing driver or UI implementation details.
- Multiple tabs retain independent in-memory state.
- Grid edits accumulate locally without per-cell HTTP requests.
- Theme switches consistently across the shell, grid, and editor.
- Local Docker launch publishes HTTP on 127.0.0.1; documentation explains host.docker.internal.

Do not adopt aGrid as final until this check passes. Address any gaps explicitly before adding a different grid dependency.

## 4. Milestone B — PostgreSQL connection and inspection

### Deliverables

- Session-scoped multi-connection API and explicit adapter dispatch.
- Expiring server-side credentials/configuration; no persistent application storage.
- PostgreSQL discovery of schemas/tables and introspection of fields/constraints/types.
- Capability and descriptor contracts with adapter extensions.
- Field and constraint grids initially displaying current structure.
- Baseline fingerprints and credential-free runbook target references.

### Acceptance criteria

- Two PostgreSQL connections coexist; tabs clearly identify their destination.
- Wrong credentials return a useful sanitized error, with no credentials in responses or logs.
- Introspection handles schema-qualified/quoted identifiers and preserves relevant PostgreSQL details.
- Connection expiry/restart requires reconnecting; local runbooks remain available.
- Read-only permissions/capabilities do not offer unsupported mutations.
- Database connections are released after requests; Apply retains one connection for its whole transaction.

## 5. Milestone C — First schema runbook, Apply, and export

### Deliverables

- Stable field identities and explicit add/rename/drop field drafts.
- Adapter interpretation and incremental SQL preview from baseline plus operations.
- Structured destructive warnings and confirmation bound to the reviewed batch.
- Stateless reviewed-plan validation and schema drift checks.
- Simple ordered statement list, Apply action, and execution results.
- PostgreSQL single-transaction execution with confirmed commit/rollback and unknown outcome states.
- Native IndexedDB storage for unfinished runbooks, necessary baselines, applied SQL, and settings.
- Browser export of confirmed applied statements in order.

### Acceptance criteria

- The first complete flow works against a disposable PostgreSQL database.
- Rename generates a rename; add then rename generates an addition with the final name; add then remove cancels before Apply.
- Generated SQL is read-only and matches what executes. Changed drafts invalidate preview/confirmation.
- Destructive operations require confirmation; detected drift blocks Apply.
- A failing statement rolls back the whole pending batch and leaves it pending when rollback is confirmed.
- Transaction-incompatible or transaction-control statements cannot bypass the batch policy.
- Commit confirmation freezes exact applied SQL; later drafts form a new pending batch.
- Lost confirmation produces an unknown outcome with no automatic retry or repair.
- Reload restores runbook state without persisting plaintext credentials or fetched database rows. Optional saved profiles remain encrypted in the separate browser vault and require its passphrase after reload.
- Export executes successfully against an equivalent initial test schema and reproduces intended changes.

The initial Apply contract uses deterministic server-side revalidation rather than a client-provided hash: the server locks the target, checks its baseline fingerprint, regenerates SQL from the structured operations, and requires an exact match with the reviewed statement list.

### Initial implementation slice

- Add a nullable field using a restricted PostgreSQL type list.
- Generate SQL from structured operations on the server; lock the table, verify its baseline fingerprint, regenerate and compare the reviewed statements, then apply them in one transaction.
- Keep the target, schema baseline, pending operations, and confirmed applied statements in browser IndexedDB. Do not persist credentials in runbooks or persist fetched rows; optional saved profiles use the separate encrypted connection vault.
- Mark interrupted Apply requests as unknown and require explicit manual reconciliation before retrying or exporting that batch.
- The first end-to-end slice supports one active table runbook, nullable field additions, and edits to supported existing fields. Broader schema operations are tracked in Milestone D; multi-table runbooks remain future work.

## 6. Milestone D — Complete MVP structure editing

### Proposed coverage to confirm before implementation

- Create, rename, and drop tables.
- Field types/parameters, nullability, defaults, and PostgreSQL identity columns.
- Primary-key, unique, foreign-key, and check constraints.
- Standalone indexes remain a scope decision; do not assume they are included.

### Deliverables and acceptance criteria

- Field/constraint controls derive from descriptors and capabilities.
- Renames update draft references without losing identity.
- Invalid types/options/constraint relationships produce actionable issues before Apply.
- Backfill or conversion requirements are explicit; no silent data-loss assumptions.
- Pending consolidation preserves intentional intermediate schema/data states.
- Adapter integration tests cover the selected supported operation matrix, including populated tables.

### Current implementation slice

- Existing editable fields stage name, type/parameters, default, and nullability changes through adapter-generated previews.
- New tables can be staged with adapter-provided field types, type parameters, nullability, defaults, and supported identity options. Preview and Apply confirm the schema and table name are available; Apply serializes concurrent QueryDock creates with a transaction-scoped advisory lock.
- The identity control is populated from adapter capabilities and supports adding, changing, or removing `GENERATED ALWAYS` / `BY DEFAULT` on smallint, integer, and bigint fields. Identity changes include nullability/default checks and explicit warnings for populated tables.
- The constraint grid can add and remove primary-key, unique, foreign-key, and CHECK constraints. Foreign-key previews validate the target table, fields, and primary/unique key; Apply repeats those checks, generates SQL on the server, and reports existing-row validation risk. Exclusion constraints remain read only.
- Table rename and drop are adapter-generated, fingerprint-checked runbook operations with destructive warning acknowledgement and tab updates after Apply. Cross-table dependency ordering is a Milestone E capability; the selected-operation integration matrix remains a Milestone D validation task. Standalone index editing remains a scope decision.

## 7. Milestone E — Relationship diagram, data browsing, and batch editing

Use the [Milestone E completion checklist](milestone-e-completion-checklist.md) for automated and manual sign-off checks.

### Deliverables

- Database relationship diagram showing tables and their foreign-key relationships. Users can create, edit, and remove relationships from the diagram; edits remain adapter-validated runbook operations.
- Dependency ordering for cross-table schema operations, including actionable reporting for blockers and cycles.
- Bounded browsing, server-side filtering/sorting/paging, and refresh.
- Insert/update/delete drafts with Save and Discard.
- Safe key-based row identification and concurrency checks.
- Explicit NULL/default and lossless database value representation.
- Save to dev or Add to runbook destinations.
- Named saved connections and explicit connect/disconnect controls, so profiles for the same host but different accounts (for example, read/write and read-only) are easy to distinguish and inactive sessions can be closed deliberately.
- A read-only, connection-scoped permission inspector reports the active database identity and effective database, schema, and table/view privileges through the selected adapter.
- A guided primary-key field picker in the schema grid, using a dropdown or integrated sidebar instead of requiring comma-separated field names.
- Inline syntax help and examples for CHECK constraint expressions.
- A visual foreign-key editor in the relationship diagram that guides users to compatible target tables and key fields.
- A second, materially different SQL Server adapter in Milestone E to test that the client depends on shared contracts and declared capabilities rather than PostgreSQL-specific behavior. Both adapters should support the same workflows where their capabilities allow it; genuine engine differences must be reported through adapter contracts and UI capability handling.
- SQL Server v1 supports secure connection setup, resource discovery, table/view inspection, bounded search/sort/filter/paging, safe row identity, concurrency-checked direct row changes, and adapter-generated data Runbook preview/Apply. The initial Milestone F slice now adds permission-gated foreign-key changes and table drops; field editing, table rename, and create-table remain unavailable.
- [x] SQL Server navigation separates tables from views, and a view page displays its adapter-provided CREATE/view definition SQL when the connected database principal has metadata permission.

### Current implementation slice

- PostgreSQL runbooks can preview and apply schema plans for multiple tables as one transaction. The adapter orders foreign-key removals before referenced-key/table drops and key/field creation before new foreign keys; an inbound dependency that is not staged for removal is reported with its source table and constraint. It does not use implicit `CASCADE`.
- The client retains separate per-table baselines and operations in the connection-scoped runbook, presents an aggregate preview, and reconciles uncertain multi-table outcomes by inspecting every affected table. Row-data batches remain single-table. SQL Server schema batches currently support only foreign-key add/remove and table-drop operations.

### Candidate scope (to confirm)

- Optional SSO login for access to the QueryDock workbench. Define supported identity providers, user-to-database credential/session behavior, and authorization boundaries before implementation. SSO would identify users to QueryDock; the database adapter must continue to use database credentials and database permissions for database access.

### Acceptance criteria

- The diagram reflects the connected database's tables and foreign keys, identifies the fields at both ends of each relationship, and makes pending relation edits clear.
- Creating, changing, or removing a relationship produces a reviewable runbook preview and applies through the database adapter.
- Editing cells makes no mutation requests until explicit submission.
- Ordinary Save applies one validated transactional batch, outside runbook history.
- Add to runbook generates SQL and stages it without modifying the database.
- Multiple edits consolidate; failed submissions retain the local draft.
- Existing-row writes target validated keys, never display indexes; unsafe cases are blocked.
- Conflicting external edits surface for user resolution.
- Large integers, decimals, timestamps, JSON, and other selected PostgreSQL types round-trip without silent coercion.
- Browsed rows/results and ordinary unsaved edits are not written to IndexedDB.
- Explicit runbook data SQL, including literal values, survives reload.
- Saved connection names are editable, persist with the encrypted local connection profile, and distinguish profiles even when their host/database values match. Existing unnamed profiles remain usable with a clear fallback label.
- Users can disconnect a selected active connection without deleting its saved profile; the UI clearly shows the active connection and disconnected state, and its server session/credentials are cleared.
- Users can inspect the active database login and effective permissions by database, schema, and visible object; reports distinguish granted and absent privileges and use adapter-reported permissions.
- When pending schema changes are indicated by an uncommitted badge, an adjacent arrow link opens the runbook directly.
- Adding a primary key presents the available table fields for selection, supports the adapter's valid key shape, and stages the chosen fields in the runbook.
- Adding a CHECK constraint explains the expected expression syntax with relevant examples; server-side validation errors identify how to correct invalid expressions.
- Foreign-key editing shows target primary/unique key sets reported by the adapter, marks compatible choices, explains field-count/type mismatches, and stages only compatible references.
- PostgreSQL and SQL Server can each connect, discover resources, inspect schemas, and browse data. SQL Server data row insert/update/delete and data Runbook workflows use SQL Server-generated queries; current SQL Server schema capabilities expose only foreign-key add/remove and permitted table drops. Field editing, rename, and table creation remain unavailable. Engine-specific SQL, identifiers, types, permissions, and unsupported operations remain adapter-owned and do not leak PostgreSQL assumptions into the client.

Confirm keyless-table behavior and precise concurrency rules before implementing writes; initially read-only is the recommended fallback.

## 8. Milestone F — Queries, mixed runbooks, and SQL Server schema migrations

### Deliverables

- SQL query tabs with bounded results and useful error display.
- Explicit authored SQL steps in runbooks.
- Ordered schema/data/custom-SQL steps across multiple tables in one database.
- SQL Server adapter-generated foreign-key creation/removal and table-drop operations, including dependency-aware cross-table batches. Keep the initial DDL scope explicit; this does not imply full PostgreSQL schema-edit parity.
- Result and execution UI consistent with generated operations.

### Acceptance criteria

- Query text and independent results work across connection-bound tabs.
- Result sets do not silently become editable without validated row identity.
- A mixed runbook can add a nullable field, backfill rows, and enforce non-nullability in order.
- SQL Server foreign-key editing uses adapter-reported target keys and type compatibility, and respects the active principal's permissions.
- SQL Server can stage foreign-key removals and referenced-table drops in one runbook. Preview orders removals before table drops, rejects unstaged inbound references and new foreign keys targeting dropped tables, and applies valid batches atomically without implicit `CASCADE`.
- SQL Server adapter capabilities expose only schema operations implemented and permitted for the active database principal; unsupported operations remain clearly unavailable.
- Custom SQL uncertainty is disclosed and appropriate acknowledgement required.
- Multiple successful Apply batches export in their original execution order.
- Pending, applied, rolled-back, rejected, and unknown outcomes are clearly distinguished.
- Completion/export cannot silently treat uncertain execution as success; manual resolution is explicit.

Define bounded fetch, query timeout, and custom-SQL result behavior before implementation. Cancellation and interactive persistent sessions are later features.

## 9. Milestone G — MVP release readiness

### Deliverables and acceptance criteria

- Session expiry, cookie/origin/CSRF protections, input validation, and safe error/log behavior verified.
- Optional passphrase-encrypted browser connection vault, including lock/unlock, profile removal, vault reset, and correct target verification when reconnecting restored runbooks. Verify no plaintext credentials reach runbook storage or server persistence; check browser-managed autofill and active-session reuse without assuming automatic reconnection.
- Tests cover SQL generation, rollback, drift, destructive confirmations, batching, persistence boundaries, and uncertain outcomes.
- Playwright covers the main schema flow and data-to-runbook flow.
- Exported migration tested with the application's required file format once that format is supplied.
- Single-image build and Mac Docker startup documented; restarting the container loses only server sessions.
- Document manual reconciliation, browser-storage loss, and runbook export responsibilities.
- Hosted deployment access controls are documented; public deployment convenience is outside MVP.

## 10. Deferred features

- Database user and role administration: create/delete database principals and grant/revoke engine-specific permissions, gated by adapter capability and guarded with explicit review and confirmation.
- Diagram view: possible P3.
- AI-assisted schema drafting: post-MVP idea; see [Post-MVP Ideas](post-mvp-ideas.md).
- Additional selectable color themes: post-MVP idea; see [Post-MVP Ideas](post-mvp-ideas.md).
- Additional engines and CSV/SQLite resources.
- Optimizing exported applied history using starting/final snapshots.
- Query cancellation, interactive transactions, and persistent session connections.
- SSH tunnels and hosted-deployment conveniences.
- Automatic reconciliation/replay of uncertain execution: explicitly excluded, not a planned recovery mechanism.

## 11. Decisions to resolve at their milestones

- Framework/runtime versions and aGrid compatibility: A.
- Session lifetime, pool limits, and capability detail: B.
- Exact baseline/fingerprint and reviewed-plan validation contracts; manual unknown-outcome resolution UI: C.
- Supported PostgreSQL types/constraints/identity options and standalone indexes: D.
- Safe keys, concurrency rules, and data value encoding: E.
- Custom SQL analysis boundaries and query limits: F.
- Migration export filename/format and completed-runbook retention: before final export/release behavior is finalized.

## 12. Codex CLI handoff

Copy these three Markdown documents into the future repository, then start Codex CLI in that repository. Suggested starting instruction:

> Read the QueryDock architecture decisions, shared contracts plan, and MVP implementation plan. Implement Milestone A only. Keep PostgreSQL logic behind a backend adapter, use the agreed stack, minimize dependencies, and preserve the stated persistence boundaries. Verify the workspace build and the aGrid integration, then report results and any contract or scope decisions needed before Milestone B.

Implement and verify one milestone at a time. Do not silently expand MVP scope or replace architectural decisions with library defaults.
