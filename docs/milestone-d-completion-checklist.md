# Milestone D Completion Checklist

Use this checklist to decide whether PostgreSQL structure editing is ready to call complete. Automated checks are marked **[AUTO]**; browser/database walkthroughs are **[MANUAL]**. Record failures and the database version used before checking an item off.

## Scope and setup

- [OK] **[MANUAL]** Run against a disposable PostgreSQL database and a schema with representative populated tables. Do not use production credentials or data.
- [OK] **[MANUAL]** Confirm this milestone covers table create/rename/drop; supported field types and parameters; nullability, defaults, and identity generation; primary-key, unique, foreign-key, and CHECK constraints.
- [OK] **[MANUAL]** Confirm standalone index editing is still a scope decision and cross-table dependency ordering is deferred to Milestone E.
- [OK] **[AUTO]** Run `pnpm test` and `pnpm -r build` successfully.
- [OK] **[AUTO]** Run `QUERYDOCK_TEST_DATABASE_URL=postgres://…/querydock_test pnpm test:integration` against a dedicated database whose name contains `test`.

For the read-only walkthrough, use a disposable database and a dedicated PostgreSQL role. `querydock_test` below is an example: replace it with the database that contains the test tables, and use that same database in QueryDock's connection settings. Role grants are scoped to one database. Run the following in `psql` as a database administrator; replace the object-owner name as needed. `\password` prompts for the credential without placing it in SQL history.

```sql
CREATE ROLE querydock_readonly LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
\password querydock_readonly
GRANT CONNECT ON DATABASE querydock_test TO querydock_readonly;
\connect querydock_test
GRANT USAGE ON SCHEMA public TO querydock_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO querydock_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE querydock_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO querydock_readonly;
```

This example assumes the test tables are in `public` in `querydock_test`. Confirm the database and schema as an administrator:

```sql
SELECT current_database();
SELECT schemaname, tablename
FROM pg_tables
WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
ORDER BY schemaname, tablename;
```

If the tables are in another schema, use that schema instead of `public` for both `GRANT USAGE ON SCHEMA` and `GRANT SELECT ON ALL TABLES IN SCHEMA`. The existing-table grant and default grant are separate: default privileges affect only future objects created by the named owner. Repeat for each schema/object owner under test. PostgreSQL's `information_schema.tables` lists only tables and views the current role can access, so an empty result under the read-only role points to the database/schema/grants to check. See PostgreSQL's [role attributes](https://www.postgresql.org/docs/current/role-attributes.html), [GRANT](https://www.postgresql.org/docs/current/sql-grant.html), [ALTER DEFAULT PRIVILEGES](https://www.postgresql.org/docs/current/sql-alterdefaultprivileges.html), and [`information_schema.tables`](https://www.postgresql.org/docs/current/infoschema-tables.html) references.

## Capability-driven editing

- [OK] **[MANUAL]** Connect as a read/write role. Table controls match server adapter capabilities; views and unsupported resource kinds do not offer table mutations.
- [OK] **[MANUAL]** Connect using the disposable `querydock_readonly` role above. Reads work; table mutations and Apply are unavailable or rejected by PostgreSQL with a clear error and never show a success/ready status.
- [OK] **[MANUAL]** Verify the client acts as a form: adapter-provided types/options drive controls, while type, parameter, identifier, and relationship validation errors come from the server and explain how to correct the value.
- [OK] **[MANUAL]** Verify errors and pending notices use stable space, communicate status clearly, and remain visible when switching between the table and runbook.

## Fields and table creation

- [OK] **[MANUAL]** Add a nullable field through the grid. Preview SQL is server-generated, the pending row is visibly uncommitted, and Apply adds the field.
- [OK] **[MANUAL]** Edit an existing field’s name, type, size/precision, default, nullable state, and supported identity generation. Each edit can be changed again before Apply and survives tab/runbook navigation.
- [OK] **[MANUAL]** Check adapter rules with representative cases: `text` with a size is rejected with an explanation; `varchar` length and `numeric` precision/scale are accepted when valid; identity is available only for supported integer types and rejects incompatible defaults/nullability.
- [OK] **[MANUAL]** Test a field conversion against populated rows. Risky or failing conversions produce a clear warning/error, retain the pending plan after a confirmed rollback, and never imply success.
- [ok] **[MANUAL]** Create two tables in one runbook, including `CREATE TABLE IF NOT EXISTS`. Review the warning that an existing table is not structurally compared, apply, and inspect both tables in PostgreSQL.
- [OK] **[MANUAL]** After Apply confirms a new table, verify its “New table (…)” draft tab and saved editor state are removed. Open the created table’s schema from the connection tree.
- [OK] **[MANUAL]** Try a duplicate table/field name and invalid type parameters. The server blocks staging/apply with a specific correction message.

## Constraints and table lifecycle

- [OK] **[MANUAL]** Add primary-key and unique constraints on valid fields. Existing rows that violate them block Apply and leave the plan available for correction.
- [OK] **[MANUAL]** Add a CHECK constraint. Verify existing-row risk is called out and invalid data is rejected by PostgreSQL without a partial migration.
- [OK] **[MANUAL]** Add a foreign key using the integrated reference editor. The target table and compatible primary/unique fields are adapter-provided; missing fields, non-unique targets, and incompatible types are rejected before Apply.
- [OK] **[MANUAL]** Delete an existing constraint row to stage its removal, then delete the pending-drop row again to cancel. Remove a foreign key and verify its reference sidebar closes.
- [OK] **[MANUAL]** Rename a table from the pencil beside the schema heading. Save stages the rename, Cancel leaves the draft unchanged, and Runbook shows the generated statement. Apply and verify the table and open workspace tab use the new name; try a conflicting destination and confirm the server blocks it.
- [OK] **[MANUAL]** Stage a table drop. The runbook shows the exact SQL and requires explicit warning acknowledgement before Apply. After Apply, the refreshed resource list confirms the table is gone, the pending migration clears automatically, and the table disappears from the connection tree.

- [OK] **[MANUAL]** Attempt to drop a table with dependent objects. PostgreSQL blocks the restricted drop; the UI explains the failure, leaves the migration unapplied, and does not use `CASCADE` implicitly.
- [OK] **[MANUAL]** Cancel/discard staged rename/drop and confirm the database and open tabs still represent the original table.

## Runbook, drift, and safety

- [OK] **[MANUAL]** Combine supported changes on one existing table. Review the complete pending SQL and confirm constraint drops precede field changes and additions follow them where required.
- [OK] **[MANUAL]** Change the database externally after loading a baseline. Preview or Apply detects drift, blocks execution, and asks the user to refresh/review.

Need more guidance here :


- [OK] **[MANUAL]** Change a draft after reviewing it. The old SQL review/warning acknowledgement cannot be applied to the changed plan.
- [OK] **[MANUAL]** Force a database error during a multi-statement plan. Confirm transaction rollback, no partial schema changes, actionable feedback, and retained pending work when rollback is confirmed.
- [OK] **[MANUAL]** Verify successful Apply records only server-confirmed SQL; subsequent drafts start a new pending batch. Confirm credentials and fetched rows are not stored in runbook data.
- [OK] **[MANUAL]** Verify an uncertain Apply outcome cannot be retried automatically and requires explicit reconciliation before continuing.

### Guided procedure for these four checks

Use only disposable tables in the test database, owned by the same read/write role QueryDock uses. Keep the browser Network panel open for the review checks.

1. **Change a reviewed draft:** Stage a field change and open Runbook to inspect its SQL. Return to the schema, change the same field again, then reopen Runbook. The preview must show the latest draft; Apply must not use the old preview. Warning acknowledgement is collected immediately before Apply, not saved as a reusable approval. **Optional server-level check:** capture an Apply request in Network, change its operation but leave its old `reviewedStatements`, and replay it. Expect a 400 review-mismatch response and no database change.
2. **Prove rollback:** In `psql`, create a disposable table with a row that will fail a later CHECK:

   ```sql
   CREATE TABLE public.qd_ms_d_rollback_test (id integer NOT NULL);
   INSERT INTO public.qd_ms_d_rollback_test VALUES (1);
   ```

   In QueryDock, stage a nullable `rollback_probe text` field and a CHECK constraint named `ck_rollback_probe_force_failure` with expression `id < 0`. Acknowledge its warning and Apply. The CHECK should fail after the field-add statement ran inside the transaction. Confirm the error is actionable, the new field and constraint are absent in PostgreSQL, and both operations remain pending in Runbook.
3. **Confirm success and storage boundaries:** Apply one valid field change. Runbook should move its returned statement to **Applied SQL** and clear it from pending SQL. Stage a second field; only its statement should be pending. In DevTools → Application → IndexedDB → `querydock-browser-state` → `runbooks`, inspect the record: it may contain target metadata (including host, database, and username), schema baseline, operations, preview, and confirmed SQL, but no password or fetched table rows.
4. **Exercise unknown outcome safely:** Use a disposable table and stage one field addition. In a second `psql` session, hold an exclusive lock, then click Apply in QueryDock so it waits:

   ```sql
   BEGIN;
   LOCK TABLE public.qd_ms_d_rollback_test IN ACCESS EXCLUSIVE MODE;
   ```

   As a database admin, find only the waiting QueryDock backend with `application_name = 'QueryDock'`, the test database, and `wait_event_type = 'Lock'`; terminate that PID with `SELECT pg_terminate_backend(<pid>);`, then release the lock with `ROLLBACK;`. QueryDock should show **OUTCOME UNKNOWN**, disable Apply/discard, and require reconciliation. Verify the field is absent, choose **I verified it was not applied**, and confirm the pending draft remains available. If you cannot inspect/terminate a backend, ask a test-database admin to run this scenario; do not try it on production.

## Automated coverage map

- [OK] **[AUTO: contracts]** `tests/contracts/milestone-d-contracts.spec.ts` checks operation shapes, rejects malformed/unsupported operation payloads, and allows the empty snapshot response used by table drops.
- [OK] **[AUTO: planner]** `apps/server/test/postgres-migration-preview.spec.ts` checks quoted SQL for create/rename/drop, field and constraint ordering, CHECK/FK SQL generation, invalid field references/type parameters, and warning generation.
- [OK] **[AUTO: sessions]** `apps/server/test/connection-sessions.service.spec.ts` checks credential isolation, session separation, expiry, connection removal, cookie properties, and per-session limits.
- [1 test skippen ? ] **[AUTO: PostgreSQL]** `apps/server/test/postgres-migration.integration.spec.ts` checks create/IF NOT EXISTS, populated-table field/constraint changes, foreign-key validation, dependent-table drop rejection, rename/drop responses, stale fingerprints, and transactional rollback. It skips unless the dedicated test database URL is provided.
- [OK] **[AUTO: web]** `apps/web/test/workspace-pages.service.spec.ts` checks workspace tab identity, create-table draft persistence, rename/navigation behavior, closing drafts, and foreign-key editor state; `runbook.service.spec.ts` checks same-schema multi-table staging, connection isolation, draft removal, review/apply payloads, and confirmed apply state.

## Sign-off

- [OK] All automated checks pass on the intended Node/pnpm versions.
- [OK] All applicable manual checks pass; record the PostgreSQL version and any intentionally unsupported cases below.
- [OK] No open Milestone D defect can cause unreviewed SQL, silent data loss, or a false success state.

**Database/version:**  
**Walkthrough date: 15102026**  
**Notes or deferred cases:**
