# Milestone F Completion Checklist

Milestone F is in progress. The first SQL Server DDL slice is implemented, but this checklist remains open until the adapter and manual acceptance cases are verified against a disposable SQL Server database.

## SQL Server Fixture

Run as a database owner in a disposable database. Remove the three fixture tables first if rerunning the script.

```sql
IF SCHEMA_ID(N'qd_ms_f') IS NULL EXEC(N'CREATE SCHEMA qd_ms_f');
DROP TABLE IF EXISTS qd_ms_f.child;
DROP TABLE IF EXISTS qd_ms_f.parent;
DROP TABLE IF EXISTS qd_ms_f.orphan_target;

CREATE TABLE qd_ms_f.parent (
  id int NOT NULL CONSTRAINT qd_ms_f_parent_pk PRIMARY KEY,
  code varchar(32) NOT NULL
);
CREATE UNIQUE INDEX qd_ms_f_parent_code_uq ON qd_ms_f.parent(code);
CREATE TABLE qd_ms_f.child (
  id int NOT NULL CONSTRAINT qd_ms_f_child_pk PRIMARY KEY,
  parent_id int NOT NULL,
  parent_code varchar(32) NULL
);
CREATE TABLE qd_ms_f.orphan_target (
  id int NOT NULL CONSTRAINT qd_ms_f_orphan_target_pk PRIMARY KEY
);
INSERT INTO qd_ms_f.parent(id, code) VALUES (1, 'parent-one');
INSERT INTO qd_ms_f.child(id, parent_id, parent_code) VALUES (1, 1, 'parent-one');
```

## Manual Acceptance

1. Connect with a SQL login that can `SELECT` the fixture tables, has `ALTER` on `qd_ms_f.child`, and `REFERENCES` on `qd_ms_f.parent`. Open the relationship diagram and start a relationship from `child`.
2. Select `parent_id`, then target `parent`. Confirm the adapter offers `id` as a compatible primary key and `code` as a compatible unique-index key. Confirm `parent_code` → `id` is incompatible because the types differ.
3. Stage `fk_child_parent` from `child.parent_id` to `parent.id`. Confirm Runbook preview shows bracket-quoted SQL Server DDL and the database has no FK before Apply.
4. Apply, then verify the constraint in SQL Server:

   ```sql
   SELECT fk.name, OBJECT_SCHEMA_NAME(fk.parent_object_id) AS source_schema,
          OBJECT_NAME(fk.parent_object_id) AS source_table,
          OBJECT_SCHEMA_NAME(fk.referenced_object_id) AS target_schema,
          OBJECT_NAME(fk.referenced_object_id) AS target_table
   FROM sys.foreign_keys AS fk
   WHERE fk.name = N'fk_child_parent';
   ```

5. Stage removal of `fk_child_parent`, switch to `parent`, then stage a drop for `parent`. Confirm the aggregate preview orders `DROP CONSTRAINT` before `DROP TABLE`. Apply and verify both the FK and parent table are absent while `child` remains.
6. Recreate the fixture and FK. Stage only a drop of `parent`; confirm preview identifies `qd_ms_f.child` and `fk_child_parent` as a blocker. Verify Apply is unavailable or rejected and no object changed.
7. Recreate the fixture. Stage an FK targeting `orphan_target`, then stage dropping `orphan_target` in the same batch. Confirm preview rejects the conflicting batch and names the new FK and dropped target.
8. Connect as a read-only login. Confirm field editing, table rename, FK changes, and table drops are unavailable. Connect as a role without target `REFERENCES`; confirm the FK helper explains the missing permission and Apply rejects direct invalid requests.
9. Confirm a SQL Server principal with only schema/object drop rights sees the table-drop action without seeing field editing, rename, or create-table controls.
10. Test an FK target that grants `REFERENCES` but not `SELECT`. Confirm it remains selectable as a relationship target, while the data browsing action stays hidden.

## Automated Checks

- [x] Unit coverage for SQL Server FK statement quoting, FK type/size compatibility, editable-constraint mapping, and identifying unstaged inbound dependencies.
- [x] Controller coverage for SQL Server FK target-choice dispatch and schema capability advertisement.
- [x] Add opt-in disposable SQL Server integration coverage for FK create/remove, dependency-ordered table drops, invalid-data rollback, and conflicting batches.
- [ ] Run `pnpm run test:integration` with `QUERYDOCK_TEST_SQLSERVER_HOST`, `QUERYDOCK_TEST_SQLSERVER_DATABASE`, `QUERYDOCK_TEST_SQLSERVER_USERNAME`, and `QUERYDOCK_TEST_SQLSERVER_PASSWORD` set for a disposable database whose name includes `test`. Optional settings are `QUERYDOCK_TEST_SQLSERVER_PORT`, `QUERYDOCK_TEST_SQLSERVER_ENCRYPT=false`, and `QUERYDOCK_TEST_SQLSERVER_TRUST_CERT=true` for local self-signed TLS only.
- [ ] Add query execution and mixed schema/data/custom-SQL Runbook coverage.
- [ ] Verify workspace query pages preserve independent query text, results, and connection identity.
- [ ] Complete manual cases above and record the SQL Server version and tested permission grants before sign-off.
