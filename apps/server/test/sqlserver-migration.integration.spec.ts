import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sql from 'mssql';
import type { MigrationApplyRequest, MigrationPreviewRequest, SqlServerConnectRequest } from '@querydock/contracts';
import { SqlServerAdapter } from '../src/feature/sqlserver/sqlserver.adapter.ts';
import { MigrationPlanError } from '../src/feature/database/database-errors.js';

const host = process.env.QUERYDOCK_TEST_SQLSERVER_HOST;
const database = process.env.QUERYDOCK_TEST_SQLSERVER_DATABASE;
const username = process.env.QUERYDOCK_TEST_SQLSERVER_USERNAME;
const password = process.env.QUERYDOCK_TEST_SQLSERVER_PASSWORD;
const enabled = Boolean(host && database && username && password);

describe.skipIf(!enabled)('SQL Server schema migration integration (disposable database)', () => {
  const adapter = new SqlServerAdapter();
  let config: SqlServerConnectRequest;
  let pool: sql.ConnectionPool;
  let schema: string;

  beforeAll(async () => {
    const testDatabase = database ?? '';
    if (!/(?:^|[-_])test(?:$|[-_0-9])/i.test(testDatabase)) {
      throw new Error('QUERYDOCK_TEST_SQLSERVER_DATABASE must name a disposable database ending in or containing "test".');
    }
    config = {
      adapter: 'sqlserver',
      host: host!,
      port: Number(process.env.QUERYDOCK_TEST_SQLSERVER_PORT || 1433),
      database: testDatabase,
      username: username!,
      password: password!,
      encrypt: process.env.QUERYDOCK_TEST_SQLSERVER_ENCRYPT !== 'false',
      trustServerCertificate: process.env.QUERYDOCK_TEST_SQLSERVER_TRUST_CERT === 'true',
    };
    pool = new sql.ConnectionPool({
      server: config.host, port: config.port, database: config.database,
      user: config.username, password: config.password,
      options: { encrypt: config.encrypt, trustServerCertificate: config.trustServerCertificate, appName: 'QueryDock test' },
      connectionTimeout: 8000, requestTimeout: 30000,
    });
    await pool.connect();
    schema = `qd_f_${randomUUID().replaceAll('-', '')}`;
    await pool.request().query(`CREATE SCHEMA [${schema}];`);
    await pool.request().query(`
      CREATE TABLE [${schema}].[parent] (
        [id] int NOT NULL CONSTRAINT [qd_f_parent_pk] PRIMARY KEY,
        [code] varchar(32) NOT NULL
      );
      CREATE UNIQUE INDEX [qd_f_parent_code_uq] ON [${schema}].[parent] ([code]);
      CREATE TABLE [${schema}].[child] (
        [id] int NOT NULL CONSTRAINT [qd_f_child_pk] PRIMARY KEY,
        [parent_id] int NOT NULL,
        [parent_code] varchar(32) NULL
      );
      CREATE TABLE [${schema}].[orphan_child] (
        [id] int NOT NULL CONSTRAINT [qd_f_orphan_child_pk] PRIMARY KEY,
        [parent_id] int NOT NULL
      );
      CREATE TABLE [${schema}].[future_parent] (
        [id] int NOT NULL CONSTRAINT [qd_f_future_parent_pk] PRIMARY KEY
      );
      INSERT INTO [${schema}].[parent] ([id], [code]) VALUES (1, 'parent-one');
      INSERT INTO [${schema}].[child] ([id], [parent_id], [parent_code]) VALUES (1, 1, 'parent-one');
      INSERT INTO [${schema}].[orphan_child] ([id], [parent_id]) VALUES (1, 999);
      INSERT INTO [${schema}].[future_parent] ([id]) VALUES (1);
    `);
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    if (schema) {
      await pool.request().query(`
        IF OBJECT_ID(N'${schema}.child', N'U') IS NOT NULL DROP TABLE [${schema}].[child];
        IF OBJECT_ID(N'${schema}.orphan_child', N'U') IS NOT NULL DROP TABLE [${schema}].[orphan_child];
        IF OBJECT_ID(N'${schema}.future_parent', N'U') IS NOT NULL DROP TABLE [${schema}].[future_parent];
        IF OBJECT_ID(N'${schema}.parent', N'U') IS NOT NULL DROP TABLE [${schema}].[parent];
        IF SCHEMA_ID(N'${schema}') IS NOT NULL EXEC(N'DROP SCHEMA [${schema}]');
      `).catch(() => undefined);
    }
    await pool.close();
  }, 30_000);

  it('creates/removes foreign keys, validates types and dependencies, and applies batches atomically', async () => {
    const parent = await adapter.inspectTable(config, schema, 'parent');
    const child = await adapter.inspectTable(config, schema, 'child');
    const orphan = await adapter.inspectTable(config, schema, 'orphan_child');
    const futureParent = await adapter.inspectTable(config, schema, 'future_parent');
    if (!parent || !child || !orphan || !futureParent) throw new Error('SQL Server did not return the integration fixture metadata.');
    expect(child.canEditConstraints).toBe(true);
    expect(child.canEditFields).toBe(false);
    expect(child.canRenameTable).toBe(false);
    expect(child.canDropTable).toBe(true);

    const choices = await adapter.foreignKeyFieldChoices(config, schema, 'child', schema, 'parent', ['parent_id']);
    expect(choices.fieldSets).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldNames: ['id'], compatible: true }),
      expect.objectContaining({ fieldNames: ['code'], compatible: false }),
    ]));

    const invalidFk: MigrationPreviewRequest = {
      schema, table: 'orphan_child', baselineFingerprint: orphan.fingerprint,
      operations: [{ kind: 'addConstraint', constraintKind: 'foreignKey', name: 'fk_orphan_parent',
        fieldNames: ['parent_id'], referencedSchema: schema, referencedTable: 'parent', referencedFieldNames: ['id'] }],
    };
    const invalidPreview = await adapter.previewMigration(config, invalidFk);
    const invalidApply: MigrationApplyRequest = {
      ...invalidFk, reviewedStatements: invalidPreview.statements, acknowledgedWarnings: invalidPreview.warnings,
    };
    await expect(adapter.applyMigration(config, invalidApply)).rejects.toThrow(/existing rows violate the relationship/);
    expect((await adapter.inspectTable(config, schema, 'orphan_child'))?.constraints.some(({ name }) => name === 'fk_orphan_parent')).toBe(false);

    const addFk: MigrationPreviewRequest = {
      schema, table: 'child', baselineFingerprint: child.fingerprint,
      operations: [{ kind: 'addConstraint', constraintKind: 'foreignKey', name: 'fk_child_parent',
        fieldNames: ['parent_id'], referencedSchema: schema, referencedTable: 'parent', referencedFieldNames: ['id'] }],
    };
    const addPreview = await adapter.previewMigration(config, addFk);
    expect(addPreview.statements[0]).toContain('WITH CHECK ADD CONSTRAINT [fk_child_parent]');
    await adapter.applyMigration(config, { ...addFk, reviewedStatements: addPreview.statements, acknowledgedWarnings: addPreview.warnings });
    const childWithFk = await adapter.inspectTable(config, schema, 'child');
    const parentWithFk = await adapter.inspectTable(config, schema, 'parent');
    if (!childWithFk || !parentWithFk) throw new Error('SQL Server did not return the updated FK snapshots.');

    const dropOnly: MigrationPreviewRequest = {
      schema, table: 'parent', baselineFingerprint: parentWithFk.fingerprint,
      operations: [{ kind: 'dropTable' }],
    };
    await expect(adapter.previewMigration(config, dropOnly)).rejects.toThrow(/child.*fk_child_parent/);

    const batchPlans: NonNullable<MigrationPreviewRequest['tablePlans']> = [
      { schema, table: 'child', baselineFingerprint: childWithFk.fingerprint, operations: [{ kind: 'dropConstraint', name: 'fk_child_parent' }] },
      { schema, table: 'parent', baselineFingerprint: parentWithFk.fingerprint, operations: [{ kind: 'dropTable' }] },
    ];
    const batchPreview = await adapter.previewMigration(config, { ...batchPlans[0]!, tablePlans: batchPlans });
    expect(batchPreview.statements[0]).toContain('DROP CONSTRAINT [fk_child_parent]');
    expect(batchPreview.statements[1]).toBe(`DROP TABLE [${schema}].[parent];`);
    const batchApply: MigrationApplyRequest = {
      ...batchPlans[0]!, tablePlans: batchPlans,
      reviewedStatements: batchPreview.statements, acknowledgedWarnings: batchPreview.warnings,
    };
    const applied = await adapter.applyMigration(config, batchApply);
    expect(applied.tableResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ schema, table: 'parent', resultingTable: null, snapshot: null }),
      expect.objectContaining({ schema, table: 'child', resultingTable: 'child' }),
    ]));

    const childAfter = await adapter.inspectTable(config, schema, 'child');
    const futureAfter = await adapter.inspectTable(config, schema, 'future_parent');
    if (!childAfter || !futureAfter) throw new Error('SQL Server did not return the remaining test objects.');
    const conflictPlans: NonNullable<MigrationPreviewRequest['tablePlans']> = [
      { schema, table: 'child', baselineFingerprint: childAfter.fingerprint, operations: [{
        kind: 'addConstraint', constraintKind: 'foreignKey', name: 'fk_child_future_parent',
        fieldNames: ['parent_id'], referencedSchema: schema, referencedTable: 'future_parent', referencedFieldNames: ['id'],
      }] },
      { schema, table: 'future_parent', baselineFingerprint: futureAfter.fingerprint, operations: [{ kind: 'dropTable' }] },
    ];
    await expect(adapter.previewMigration(config, { ...conflictPlans[0]!, tablePlans: conflictPlans }))
      .rejects.toThrow(/references .*future_parent.*which this batch drops/);
  }, 90_000);
});
