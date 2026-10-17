# Milestone E Completion Checklist

Use this checklist to sign off cross-database relationship workflows and data browsing/editing. The [Milestone E Manual Test Guide](milestone-e-manual-test-guide.md) contains numbered setup, fixture, SQL, and browser steps for each procedure. Run manual cases against disposable databases only. Record browser, database version, result, and evidence for every case. A skipped integration test is not a pass.

## Automated verification

- [OK] **[AUTO]** `pnpm test` passes, including client, server, and contract suites.
- [OK] **[AUTO]** `pnpm -r build` and `pnpm typecheck` pass.
- [OK] **[AUTO: PostgreSQL]** Run `QUERYDOCK_TEST_DATABASE_URL=postgres://…/querydock_test pnpm test:integration` against a disposable database whose name contains `test`.
- [OK] **[AUTO: browser]** `pnpm test:e2e` passes for the configured Playwright workflows; report any environment-dependent skips. Verified 2026-10-17: 10/10 Playwright tests passed.
- [OK] **[AUTO: dependencies]** PostgreSQL integration coverage proves a referenced table cannot be dropped alone, a staged inbound foreign-key drop is ordered before its referenced table drop in one atomic batch, and failed batches roll back. Preview and apply must reject stale fingerprints and mismatched reviewed SQL.
- [OK] **[AUTO: data]** Tests cover bounded paging, search/filter/sort, lossless values, read-only capability gating, row insert/update/delete, concurrency conflicts, error retention, and both direct-save and Runbook modes for PostgreSQL and SQL Server.

## Manual acceptance

- [OK] **Connections (C-1–C-4):** Named read/write and read-only profiles remain distinct across reload; capability controls match each role; disconnect removes only the selected active session and its workspace state.
- [OK] **Relationship diagram (R-1–R-2):** Diagram tab, per-connection layout persistence, composite and cross-schema relationships, drag/scroll/responsive behavior, create/edit/drop, and invalid target feedback work as described in the guide.
- [OK] **Cross-table ordering (R-3):** Stage removal of a child foreign key and drop of its referenced parent. Preview lists FK removal first; Apply succeeds atomically. Verify the FK and parent are absent in database metadata. Also verify an unstaged inbound FK blocks the plan with the referencing table and constraint named. Confirm no implicit `CASCADE`.
- [OK] **Schema helpers (R-4):** Primary-key picker preserves composite field order. CHECK help opens, inserts an example, and invalid expressions return actionable server feedback.
- [OK] **Data browsing (D-0–D-2):** Bounded paging, stable sort, search and clearing search, filter reset, table switching, small-screen scrolling, and route restoration work without clipped controls or stale results.
- [OK] **Data changes (D-3 onward):** Multi-cell row edits save once per completed row; add/delete work; success clears changed-cell state; failures remain visible and retryable. Verify PK/keyless cases, stale-row conflicts, NULL/default/large-value behavior, read-only account behavior, and direct-save versus staged Runbook behavior.
- [OK] **SQL Server (S-1–S-5):** Table/view separation, view definition permissions, bounded data operations, concurrency, Runbook SQL, read-only enforcement, and explicit unsupported schema-edit handling pass on a SQL Server instance.
- [OK] **Permission inspector (P-1):** Active database identity and effective database, schema, and object permissions match each engine's permission checks for read/write and read-only accounts; inaccessible metadata is clearly explained.
- [OK] **Privacy (D-9):** No credentials or fetched rows are persisted in Runbook/browser state; only explicitly staged SQL and necessary target metadata remain after reload.

## Sign-off

- [OK] All automated checks pass; integration and browser skips are explained.
- [OK] Every applicable manual case is PASS, or its deferred scope and owner are documented.
- [OK] No open defect can cause silent data loss, unsafe SQL ordering, stale overwrite, or a false success state.

**PostgreSQL version:**  
**SQL Server version:**  
**Browser/version:**  
**Walkthrough date:**  
**Failures, evidence, and deferred scope:**
