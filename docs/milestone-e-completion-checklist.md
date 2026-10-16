# Milestone E Completion Checklist

Use this checklist to decide whether the relationship diagram, connection workflow, and data editing are ready to call complete. Automated checks are marked **[AUTO]**; browser/database walkthroughs are **[MANUAL]**. Keep all database checks on a disposable database and record failures, versions, and deferred scope before sign-off.

For reproducible, numbered browser/database procedures for the manual items, use the [Milestone E Manual Test Guide](milestone-e-manual-test-guide.md). Record each procedure’s result here; do not mark a feature complete from a quick visual check alone.

## Scope and setup

- [OK] **[MANUAL]** Confirm Milestone E scope: relationship diagram and adapter-validated foreign-key editing; cross-table dependency ordering; bounded data browsing and batch edits; named connections and disconnect; primary-key picker and CHECK help.

- [OK] **[MANUAL]** Use a disposable PostgreSQL database with empty, populated, related, composite-key, keyless, and conflicting tables. Include large integers, decimals, timestamps, JSON, NULL, and default values.

- [OK] **[MANUAL]** Verify the connected database and role before each walkthrough. Never use production data or credentials. Run read/write and read-only cases with separate database roles.

- [OK] **[AUTO]** Run `pnpm test`, `pnpm -r build`, and `pnpm typecheck`. Run PostgreSQL integration coverage with `QUERYDOCK_TEST_DATABASE_URL` pointed only at a disposable test database.

- [OK] **[MANUAL]** Resolve keyless-table write behavior, supported key shapes, conflict semantics, and direct Save versus Add to Runbook behavior before enabling writes for those cases.

## Connection workflow

- [OK] **[MANUAL]** Save two profiles for the same host/database with different accounts (for example, read/write and read-only), distinct names, and encrypted-vault storage. Confirm each is clearly identified in both the vault and active connection list.

- [OK] **[MANUAL]** Rename a saved profile, reload, unlock the vault, and confirm the new name persists. Confirm older unnamed profiles remain usable with a useful fallback label. Verify credentials and names stay encrypted in IndexedDB.
- [PARTIAL] **[MANUAL]** Connect both profiles, switch between them, inspect that the correct account’s permissions apply, then disconnect one. Confirm its session credentials and client resources are cleared, the other connection remains active, and the saved profile and its runbook remain available.

Note: the ReadOnly Account has the + button in the tree to create a new table. Editing shows the readonly badge. The button should be hidden when there is a RO access

- [OK] **[MANUAL]** Disconnect the final connection. The UI clearly shows the disconnected state; a request using the removed server connection ID is rejected. Reconnect from the saved profile and confirm table discovery works again.

- [OK] **[MANUAL]** Confirm disconnect requires an intentional action and explains that unsent table-creation drafts are discarded while staged Runbook changes remain. Check behavior for a failed or expired disconnect request.

- [ ] **[AUTO]** Cover profile naming, rename, encrypted persistence/reload, legacy unnamed profile handling, disconnect success/failure, resource cleanup, and workspace-tab cleanup in web tests. Cover server session removal and cookie handling in session tests.

## Relationship diagram and schema dependencies

- [x] **[MANUAL]** Confirm the connection-scoped relationship diagram is a workspace page, and that table positions and viewport survive switching between workspace pages. Core diagram interaction and the foreign-key edit overlay are working; the user confirmed this point after adjusting the overlay labels and selections.
- [X] **[MANUAL]** Exercise diagram edge cases with no foreign keys, many tables, composite keys, and cross-schema references. Confirm labels, relationship direction, empty state, pan/zoom, and layout remain usable without clipping or blocking workspace actions.
- [X] **[MANUAL]** Create, change, and remove foreign keys from the diagram. The adapter supplies valid target tables and primary/unique field sets; incompatible field types/counts, missing fields, and non-unique targets are explained and cannot be staged.
- [X] **[MANUAL]** Confirm diagram edits are visibly pending, appear in Runbook with server-generated SQL, survive navigation/reload as supported, and do not change the database before Apply. Apply and inspect both ends of each relation in PostgreSQL.
- [ ] **[MANUAL]** Exercise cross-table plans that add/drop relationships before changing or dropping referenced objects. Verify deterministic dependency ordering, blocker details, and cycle reporting; QueryDock must not add `CASCADE` implicitly.
- [ ] **[MANUAL]** Use the primary-key picker to select valid single and composite keys. Use CHECK help to understand expected expression syntax and correct a deliberately invalid expression from the server’s actionable error.
- [ ] **[AUTO]** Test relationship contracts, compatibility validation, quoted SQL generation, operation ordering, dependency blockers/cycles, and diagram/editor draft state.

## Data browsing and editing

- [x] **[MANUAL]** Review the data browser grid presentation and controls; the user customized the grid and confirmed the browser UI is satisfactory.
- [x] **[MANUAL]** Confirm table structure and data actions appear on row hover, remain keyboard reachable, and stay visible on touch devices. The user confirmed this behavior.
- [ ] **[MANUAL]** Open a table’s Browse data page from its structure view. Confirm it gets a connection-scoped workspace tab, returns to the same table after switching tabs, and re-registers when its route is loaded directly after session restore.
- [ ] **[MANUAL]** Browse a small and large table. Confirm results are bounded, paging is server-side, filtering/sorting is server-side and stable, refresh reflects external changes, and query controls do not send unbounded requests.
- [ ] **[MANUAL]** Verify identifiers and filter values are safely handled. Try quotes, wildcard characters, reserved words, and unusual column names; values must be parameterized and identifiers safely quoted.
- [ ] **[MANUAL]** Insert, update, and delete drafts. Confirm edits remain local until submission; direct Save applies one transactional batch, while Add to Runbook only stages reviewable SQL. Save and Discard have clear results.
- [ ] **[MANUAL]** Test primary and composite keys, duplicate/non-unique keys, keyless tables, generated columns, defaults, explicit NULL, and identity fields. Unsafe row targeting must be blocked; keyless behavior must match the resolved scope decision.
- [ ] **[MANUAL]** Test optimistic concurrency by changing a row externally after it is loaded. Save must report the conflict, preserve the local draft, and require user resolution rather than overwrite silently.
- [ ] **[MANUAL]** Round-trip large integers, high-precision decimals, timezone-aware timestamps, JSON, and NULL/default values. No displayed, staged, or saved value may be silently coerced or rounded.
- [ ] **[MANUAL]** Force a multi-row or constraint failure. Confirm rollback, actionable feedback, retained drafts, and no false success. Verify read-only credentials can browse but cannot mutate.
- [ ] **[MANUAL]** Inspect IndexedDB after browsing and after ordinary unsaved edits: fetched rows and ordinary drafts are absent. Explicit Runbook data SQL may persist only after the user chooses Add to Runbook; inspect that target metadata and SQL are present but credentials and fetched result rows are absent.
- [ ] **[AUTO]** Cover bounds, filters, sorting, paging, parameterization, safe keys, concurrency conflicts, rollback, value round-trips, capability/permission errors, and persistence boundaries in contract, adapter, integration, and web tests.

## Sign-off

- [ ] All automated checks pass; integration tests use a disposable database and are not silently skipped for sign-off.
- [ ] All applicable manual checks pass. Every failed or deferred case has an owner, reason, and explicit scope decision.
- [ ] No open Milestone E defect can cause unreviewed database writes, unsafe row targeting, silent value loss, credential exposure, or a false success state.
- [ ] Optional SSO remains a candidate, not a sign-off blocker, unless its scope is explicitly added to this milestone.

**PostgreSQL version:**  
**Node/pnpm versions:**  
**Walkthrough date:**  
**Notes, failures, or deferred cases:**
