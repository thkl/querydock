# QueryDock — Shared Contracts Plan

Status: connection, resource, and table-inspection schemas are implemented in `packages/contracts`; remaining draft, preview, apply, and runbook contracts below are proposals.
Date: 2026-10-13.  
Architecture reference: [architecture decisions](architecture-decisions.md).

Use shared Zod schemas in `packages/contracts` and infer TypeScript types from them. Keep database-driver objects and Angular components out of these contracts. The illustrative names below are proposals.

## 1. Connection and resource identity

- `ConnectRequest`: adapter kind, host, port, database, user, password, and adapter-specific connection options validated by the selected adapter.
- `ConnectionResponse`: session-scoped connection ID, source identity, engine/version, and capabilities. Never return credentials.
- `ResourceRef`: source identity, resource kind, namespace/schema, resource name, and optional adapter-specific identity.
- A connection ID expires with the session. Persisted runbooks reference a credential-free target description; reconnecting requires verifying the intended destination, not blindly substituting a new connection ID.
- Use structured, schema-qualified identifiers rather than treating names as SQL fragments.

## 2. Capabilities and descriptors

- `Capabilities`: supported reads, data mutations, schema operations, SQL execution, migrations, and transaction behavior. Model operation-specific support rather than one broad editable flag.
- `TypeDescriptor`: type identity, label, parameter definitions and semantic validation rules; allow adapter-specific extensions.
- `FieldDescriptor`: stable draft identity, source identity where available, name, type, nullability, default expression, generated/identity behavior, and editability.
- `ConstraintDescriptor`: stable draft identity, kind, name, field references, and kind-specific properties. Foreign keys include referenced resources/fields and actions; checks contain an expression.
- `TableSnapshot`: resource reference, fields, constraints, and relevant adapter extensions.
- `Baseline`: relevant snapshots and adapter-produced fingerprints. Adapters define fingerprint semantics; timestamps alone are insufficient.

A persisted runbook retains the original schema baseline necessary to restore and interpret its edits. This persistence exception is agreed: treat it as runbook state, not a general metadata cache. Unrelated fetched schema metadata remains in memory. Validate the baseline against the live database before applying after reconnecting.

## 3. Structured draft operations

Use a Zod discriminated union with an operation ID and explicit kind. Proposed kinds:

- `createTable`, `renameTable`, `dropTable`.
- `addField`, `renameField`, `dropField`, `changeFieldType`, `setFieldNullable`, `setFieldDefault`, `removeFieldDefault`.
- `addConstraint`, `changeConstraint`, `dropConstraint`, subject to adapter capabilities.
- `insertRows`, `updateRows`, `deleteRows` for intentional runbook data steps.
- `sqlStep` for explicitly authored SQL.

References point to stable draft IDs. Newly created objects have client-generated IDs; renaming does not change them. The adapter maps these references to current/proposed source names and validates their relationships.

Do not collapse every field property into an arbitrary patch. Explicit operations preserve intent, especially rename and type conversion. Type changes may include an adapter-supported conversion expression.

Pending operations may be consolidated. Already applied steps are immutable. Preserve ordering where a schema/data/custom-SQL sequence depends on intermediate state; final-schema diffing must not erase a required backfill stage.

## 4. Data values and batches

- `DataBatchRequest`: table reference and inserts/updates/deletes, with expected original values or another supported concurrency check for existing rows.
- Identify existing rows with a validated key, not display position or page index.
- Distinguish literal values, explicit NULL, and use-of-default. SQL expressions are a separate explicit category where supported.
- Define a JSON-safe value representation that preserves large integers, precise decimals, dates/timestamps, binary data, and adapter-specific types without implicit JavaScript coercion.
- Ordinary saves return mutation results without adding runbook history. Runbook staging produces preview SQL without executing it.
- No per-cell HTTP requests. Failed submissions preserve the browser's in-memory draft.

Exact mutation support and conflict rules remain to be specified.

## 5. Preview

`PreviewRequest` carries the target connection, relevant baseline, ordered pending operations, and a client draft revision.

`PreviewResponse` contains:

- The echoed draft revision and a digest identifying the reviewed execution plan.
- Ordered statements with IDs, SQL, originating operation IDs, affected resources, and transaction compatibility.
- Structured warnings and blocking validation issues.
- Relevant baseline fingerprints and plan validation information needed by Apply.

`RiskWarning` contains a stable warning ID, risk code, message, affected objects/steps, and whether explicit confirmation is required. Codes include destructive changes, potential data loss, integrity reduction, and uncertain custom SQL analysis.

The backend owns SQL generation. Generated statements are read-only. Do not silently regenerate a different script during Apply and execute it without review.

## 6. Apply

`ApplyRequest` carries the reviewed plan, its revision/digest, relevant baseline information, and acknowledged warning IDs. A digest identifies content but alone does not prove the server generated it; choose deterministic revalidation or an authenticated stateless plan envelope before implementation.

The server validates the target, exact reviewed plan, acknowledgements, schema baseline, and transaction compatibility. Drift or changed content blocks execution and requires a new preview. Perform drift checks close to execution and define suitable adapter locking where necessary.

For PostgreSQL MVP, execute the complete pending batch in one transaction. Only report success after commit succeeds. Transaction-incompatible statements are rejected before execution. Custom transaction-control statements must not bypass the batch transaction policy.

`ApplyResult` is a discriminated union:

- `applied`: confirmed commit, plan identity, and statement results/affected row counts where available.
- `rejected`: validation/drift/confirmation issue; execution did not begin.
- `rolledBack`: execution failed and rollback was confirmed; include error and failing statement identity where known.
- `unknown`: the server cannot confirm the final transaction outcome.

The client also produces an unknown state when the response is lost. Do not equate HTTP failure with rollback. Do not automatically retry or repair an uncertain execution. The user resolves it manually. Earlier statement results in a rolled-back transaction are not committed successes.

## 7. Browser runbook

`RunbookDraft` includes a local ID, credential-free target reference, title, revision, necessary schema baselines, pending draft/preview information, immutable successfully applied batches, and execution outcome state.

- Persist settings and unfinished runbooks in IndexedDB.
- Explicit runbook SQL may contain literal data values.
- Do not include passwords, fetched rows/results, or unrelated cached metadata in runbooks. Saved connection profiles omit passwords; credential saving/autofill is delegated to the user's browser/password manager, with no custom vault.
- Applied history records exact SQL confirmed to have committed.
- Unknown batches require explicit manual resolution before completion/export can treat them as applied.
- Export confirmed applied batches in execution order; no server export endpoint or migration-history persistence.

## 8. Implementation sequence

1. Connection/resource identity, capability contracts, and PostgreSQL table introspection.
2. Field-change operations and baseline-aware preview.
3. Destructive warnings, reviewed-plan validation, transactional Apply, and outcome states.
4. Browser runbook persistence and export.
5. Constraint operations, data batches, and explicit SQL steps.

First milestone remains: connect, inspect a table, draft a field change, preview, apply, and export.
