# QueryDock — MVP Implementation Plan

Status: in progress. The workspace, editor, and grid shell are in place; the initial Milestone B PostgreSQL connection and read-only schema inspection slice is implemented. Data browsing and schema changes are still disconnected.
Date: 2026-10-13.

References:

- [Architecture decisions](architecture-decisions.md)
- [Shared contracts proposal](contracts-plan.md)

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
- Vitest for client/server, real PostgreSQL integration tests, Playwright for critical browser flows.
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
- Reload restores runbook state without persisting credentials or fetched database rows.
- Export executes successfully against an equivalent initial test schema and reproduces intended changes.

Before implementing Apply, choose how the server validates a submitted reviewed plan without persisted previews: deterministic revalidation or an authenticated stateless envelope. A plain client-provided hash is insufficient proof.

## 6. Milestone D — Complete MVP structure editing

### Proposed coverage to confirm before implementation

- Create, rename, and drop tables.
- Field types/parameters, nullability, defaults, and PostgreSQL identity columns.
- Primary-key, unique, foreign-key, and check constraints.
- Standalone indexes remain a scope decision; do not assume they are included.

### Deliverables and acceptance criteria

- Field/constraint controls derive from descriptors and capabilities.
- Renames update draft references without losing identity.
- Multi-table operations are dependency ordered.
- Invalid types/options/constraint relationships produce actionable issues before Apply.
- Backfill or conversion requirements are explicit; no silent data-loss assumptions.
- Pending consolidation preserves intentional intermediate schema/data states.
- Adapter integration tests cover the selected supported operation matrix, including populated tables.

## 7. Milestone E — Data browsing and batch editing

### Deliverables

- Bounded browsing, server-side filtering/sorting/paging, and refresh.
- Insert/update/delete drafts with Save and Discard.
- Safe key-based row identification and concurrency checks.
- Explicit NULL/default and lossless database value representation.
- Save to dev or Add to runbook destinations.

### Acceptance criteria

- Editing cells makes no mutation requests until explicit submission.
- Ordinary Save applies one validated transactional batch, outside runbook history.
- Add to runbook generates SQL and stages it without modifying the database.
- Multiple edits consolidate; failed submissions retain the local draft.
- Existing-row writes target validated keys, never display indexes; unsafe cases are blocked.
- Conflicting external edits surface for user resolution.
- Large integers, decimals, timestamps, JSON, and other selected PostgreSQL types round-trip without silent coercion.
- Browsed rows/results and ordinary unsaved edits are not written to IndexedDB.
- Explicit runbook data SQL, including literal values, survives reload.

Confirm keyless-table behavior and precise concurrency rules before implementing writes; initially read-only is the recommended fallback.

## 8. Milestone F — Queries and mixed runbooks

### Deliverables

- SQL query tabs with bounded results and useful error display.
- Explicit authored SQL steps in runbooks.
- Ordered schema/data/custom-SQL steps across multiple tables in one database.
- Result and execution UI consistent with generated operations.

### Acceptance criteria

- Query text and independent results work across connection-bound tabs.
- Result sets do not silently become editable without validated row identity.
- A mixed runbook can add a nullable field, backfill rows, and enforce non-nullability in order.
- Custom SQL uncertainty is disclosed and appropriate acknowledgement required.
- Multiple successful Apply batches export in their original execution order.
- Pending, applied, rolled-back, rejected, and unknown outcomes are clearly distinguished.
- Completion/export cannot silently treat uncertain execution as success; manual resolution is explicit.

Define bounded fetch, query timeout, and custom-SQL result behavior before implementation. Cancellation and interactive persistent sessions are later features.

## 9. Milestone G — MVP release readiness

### Deliverables and acceptance criteria

- Session expiry, cookie/origin/CSRF protections, input validation, and safe error/log behavior verified.
- Password-free saved recent connection profiles and correct target verification when reconnecting restored runbooks. Conventional username/password autocomplete supports browser-managed credential saving; no custom vault. Verify manual reconnect and active-session reuse, and check autofill with multiple profiles/repeated usernames in supported browsers without assuming automatic reconnection.
- Tests cover SQL generation, rollback, drift, destructive confirmations, batching, persistence boundaries, and uncertain outcomes.
- Playwright covers the main schema flow and data-to-runbook flow.
- Exported migration tested with the application's required file format once that format is supplied.
- Single-image build and Mac Docker startup documented; restarting the container loses only server sessions.
- Document manual reconciliation, browser-storage loss, and runbook export responsibilities.
- Hosted deployment access controls are documented; public deployment convenience is outside MVP.

## 10. Deferred features

- Diagram view: possible P3.
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
