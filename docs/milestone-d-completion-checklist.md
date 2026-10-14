# Milestone D Completion Checklist

Use this checklist to decide whether PostgreSQL structure editing is ready to call complete. Automated checks are marked **[AUTO]**; browser/database walkthroughs are **[MANUAL]**. Record failures and the database version used before checking an item off.

## Scope and setup

- [ ] **[MANUAL]** Run against a disposable PostgreSQL database and a schema with representative populated tables. Do not use production credentials or data.
- [ ] **[MANUAL]** Confirm this milestone covers table create/rename/drop; supported field types and parameters; nullability, defaults, and identity generation; primary-key, unique, foreign-key, and CHECK constraints.
- [ ] **[MANUAL]** Confirm standalone index editing is still a scope decision and cross-table dependency ordering is deferred to Milestone E.
- [ ] **[AUTO]** Run `pnpm test` and `pnpm -r build` successfully.
- [ ] **[AUTO]** Run `QUERYDOCK_TEST_DATABASE_URL=postgres://…/querydock_test pnpm test:integration` against a dedicated database whose name contains `test`.

## Capability-driven editing

- [ ] **[MANUAL]** Connect as a read/write role. Table controls match server adapter capabilities; views and unsupported resource kinds do not offer table mutations.
- [ ] **[MANUAL]** Connect as a read-only role. Unsupported edits are unavailable, and a server rejection appears as a clear error without a success/ready status.
- [ ] **[MANUAL]** Verify the client acts as a form: adapter-provided types/options drive controls, while type, parameter, identifier, and relationship validation errors come from the server and explain how to correct the value.
- [ ] **[MANUAL]** Verify errors and pending notices use stable space, communicate status clearly, and remain visible when switching between the table and runbook.

## Fields and table creation

- [ ] **[MANUAL]** Add a nullable field through the grid. Preview SQL is server-generated, the pending row is visibly uncommitted, and Apply adds the field.
- [ ] **[MANUAL]** Edit an existing field’s name, type, size/precision, default, nullable state, and supported identity generation. Each edit can be changed again before Apply and survives tab/runbook navigation.
- [ ] **[MANUAL]** Check adapter rules with representative cases: `text` with a size is rejected with an explanation; `varchar` length and `numeric` precision/scale are accepted when valid; identity is available only for supported integer types and rejects incompatible defaults/nullability.
- [ ] **[MANUAL]** Test a field conversion against populated rows. Risky or failing conversions produce a clear warning/error, retain the pending plan after a confirmed rollback, and never imply success.
- [ ] **[MANUAL]** Create two tables in one runbook, including `CREATE TABLE IF NOT EXISTS`. Review the warning that an existing table is not structurally compared, apply, and inspect both tables in PostgreSQL.
- [ ] **[MANUAL]** Try a duplicate table/field name and invalid type parameters. The server blocks staging/apply with a specific correction message.

## Constraints and table lifecycle

- [ ] **[MANUAL]** Add primary-key and unique constraints on valid fields. Existing rows that violate them block Apply and leave the plan available for correction.
- [ ] **[MANUAL]** Add a CHECK constraint. Verify existing-row risk is called out and invalid data is rejected by PostgreSQL without a partial migration.
- [ ] **[MANUAL]** Add a foreign key using the integrated reference editor. The target table and compatible primary/unique fields are adapter-provided; missing fields, non-unique targets, and incompatible types are rejected before Apply.
- [ ] **[MANUAL]** Delete an existing constraint row to stage its removal, then delete the pending-drop row again to cancel. Remove a foreign key and verify its reference sidebar closes.
- [ ] **[MANUAL]** Rename a table. Review the generated statement, apply it, and verify its open workspace tab follows the new name. Try a conflicting destination name and confirm the server blocks it.
- [ ] **[MANUAL]** Stage a table drop. The runbook shows the exact SQL and requires explicit warning acknowledgement before Apply. Verify the table and its data are gone afterward.
- [ ] **[MANUAL]** Attempt to drop a table with dependent objects. PostgreSQL blocks the restricted drop; the UI explains the failure, leaves the migration unapplied, and does not use `CASCADE` implicitly.
- [ ] **[MANUAL]** Cancel/discard staged rename/drop and confirm the database and open tabs still represent the original table.

## Runbook, drift, and safety

- [ ] **[MANUAL]** Combine supported changes on one existing table. Review the complete pending SQL and confirm constraint drops precede field changes and additions follow them where required.
- [ ] **[MANUAL]** Change the database externally after loading a baseline. Preview or Apply detects drift, blocks execution, and asks the user to refresh/review.
- [ ] **[MANUAL]** Change a draft after reviewing it. The old SQL review/warning acknowledgement cannot be applied to the changed plan.
- [ ] **[MANUAL]** Force a database error during a multi-statement plan. Confirm transaction rollback, no partial schema changes, actionable feedback, and retained pending work when rollback is confirmed.
- [ ] **[MANUAL]** Verify successful Apply records only server-confirmed SQL; subsequent drafts start a new pending batch. Confirm credentials and fetched rows are not stored in runbook data.
- [ ] **[MANUAL]** Verify an uncertain Apply outcome cannot be retried automatically and requires explicit reconciliation before continuing.

## Automated coverage map

- [ ] **[AUTO: contracts]** `tests/contracts/milestone-d-contracts.spec.ts` checks operation shapes, rejects malformed/unsupported operation payloads, and allows the empty snapshot response used by table drops.
- [ ] **[AUTO: planner]** `apps/server/test/postgres-migration-preview.spec.ts` checks quoted SQL for create/rename/drop, field and constraint ordering, CHECK/FK SQL generation, invalid field references/type parameters, and warning generation.
- [ ] **[AUTO: sessions]** `apps/server/test/connection-sessions.service.spec.ts` checks credential isolation, session separation, expiry, connection removal, cookie properties, and per-session limits.
- [ ] **[AUTO: PostgreSQL]** `apps/server/test/postgres-migration.integration.spec.ts` checks create/IF NOT EXISTS, populated-table field/constraint changes, foreign-key validation, dependent-table drop rejection, rename/drop responses, stale fingerprints, and transactional rollback. It skips unless the dedicated test database URL is provided.
- [ ] **[AUTO: web]** `apps/web/test/workspace-pages.service.spec.ts` checks workspace tab identity, create-table draft persistence, rename/navigation behavior, closing drafts, and foreign-key editor state; `runbook.service.spec.ts` checks same-schema multi-table staging, connection isolation, draft removal, review/apply payloads, and confirmed apply state.

## Sign-off

- [ ] All automated checks pass on the intended Node/pnpm versions.
- [ ] All applicable manual checks pass; record the PostgreSQL version and any intentionally unsupported cases below.
- [ ] No open Milestone D defect can cause unreviewed SQL, silent data loss, or a false success state.

**Database/version:**  
**Walkthrough date:**  
**Notes or deferred cases:**
