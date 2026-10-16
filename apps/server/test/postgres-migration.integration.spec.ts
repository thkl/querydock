import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  MigrationApplyRequest,
  MigrationPreviewRequest,
  PostgresConnectRequest,
  SchemaFieldDraftRequest,
} from '@querydock/contracts';
import { MigrationPlanError, PostgresAdapter } from '../src/feature/postgres/postgres.adapter.ts';

interface PgClient {
  connect(): Promise<void>;
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}

type PgClientConstructor = new (options: { connectionString: string }) => PgClient;
const requireFromServer = createRequire(resolve(process.cwd(), 'apps/server/package.json'));
const { Client } = requireFromServer('pg') as { Client: PgClientConstructor };
const databaseUrl = process.env.QUERYDOCK_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('PostgreSQL Milestone D integration (disposable database)', () => {
  const adapter = new PostgresAdapter();
  let admin: PgClient;
  let schema: string;
  let configuration: PostgresConnectRequest;

  beforeAll(async () => {
    if (!databaseUrl) return;
    const url = new URL(databaseUrl);
    const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
    if (!/(?:^|[-_])test(?:$|[-_0-9])/i.test(database)) {
      throw new Error('QUERYDOCK_TEST_DATABASE_URL must name a disposable database ending in or containing "test".');
    }
    const sslMode = url.searchParams.get('sslmode');
    configuration = {
      adapter: 'postgresql',
      host: url.hostname,
      port: Number(url.port || 5432),
      database,
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      sslMode: sslMode === 'verify-full' ? 'verify-full' : sslMode && sslMode !== 'disable' ? 'require' : 'disable',
    };
    admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    schema = `qd_ms_d_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
  }, 30_000);

  afterAll(async () => {
    if (admin && schema) {
      try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
      finally { await admin.end(); }
    }
  }, 30_000);

  it('creates, alters, constrains, renames, drops, detects drift, and rolls back invalid changes', async () => {
    const createOperations: MigrationPreviewRequest['operations'] = [
      { kind: 'createTable', table: 'parent', ifNotExists: false, fields: [
        { name: 'id', type: 'bigint', nullable: false, defaultExpression: null, identityGeneration: 'always' },
        { name: 'code', type: 'varchar', typeDetails: '60', nullable: false, defaultExpression: null, identityGeneration: null },
      ] },
      { kind: 'createTable', table: 'child', ifNotExists: false, fields: [
        { name: 'id', type: 'bigint', nullable: false, defaultExpression: null, identityGeneration: 'byDefault' },
        { name: 'parent_id', type: 'bigint', nullable: false, defaultExpression: null, identityGeneration: null },
        { name: 'label', type: 'varchar', typeDetails: '40', nullable: true, defaultExpression: null, identityGeneration: null },
      ] },
    ];
    const createPlan: MigrationPreviewRequest = {
      schema, table: 'parent', baselineFingerprint: null, operations: createOperations,
    };
    const createPreview = await adapter.previewMigration(configuration, createPlan);
    const created = await adapter.applyMigration(configuration, {
      ...createPlan, reviewedStatements: createPreview.statements, acknowledgedWarnings: createPreview.warnings,
    });
    expect(created.snapshots.map(({ name }) => name)).toEqual(['parent', 'child']);

    const parent = await adapter.inspectTable(configuration, schema, 'parent');
    const child = await adapter.inspectTable(configuration, schema, 'child');
    if (!parent || !child) throw new Error('The create plan did not produce both test tables.');
    await admin.query(`INSERT INTO "${schema}"."parent" (code) VALUES ('P-1')`);
    await admin.query(`INSERT INTO "${schema}"."child" (parent_id, label) VALUES (1, 'first')`);

    const verified = await adapter.verifyConnection(configuration);
    expect(verified.serverVersion).toMatch(/^\d/);
    expect(adapter.editableFieldTypes().some(({ value }) => value === 'jsonb')).toBe(true);
    expect((await adapter.listResources(configuration)).some((resource) => resource.schema === schema && resource.name === 'child')).toBe(true);
    expect(child.fields.map(({ name }) => name)).toEqual(['id', 'parent_id', 'label']);

    const filteredRows = await adapter.queryTableData(configuration, schema, 'child', {
      offset: 0, limit: 10, sort: [{ field: 'id', direction: 'asc' }],
      filters: [{ field: 'label', operator: 'contains', value: 'fir' }], quickFilter: '',
    });
    expect(filteredRows).toMatchObject({
      totalRows: 1,
      columns: [
        { name: 'id', dataType: 'bigint' },
        { name: 'parent_id', dataType: 'bigint' },
        { name: 'label', dataType: 'character varying' },
      ],
      rows: [{ id: '1', parent_id: '1', label: 'first' }],
    });
    await expect(adapter.queryTableData(configuration, schema, 'child', {
      offset: 0, limit: 10, sort: [],
      filters: [{ field: 'missing', operator: 'eq', value: 'x' }], quickFilter: '',
    })).rejects.toMatchObject({ kind: 'invalid' });
    await expect(adapter.queryTableData(configuration, schema, 'missing', {
      offset: 0, limit: 10, sort: [], filters: [], quickFilter: '',
    })).rejects.toMatchObject({ kind: 'not-found' });

    const fieldDraft: SchemaFieldDraftRequest = {
      schema,
      table: 'child',
      baselineFingerprint: child.fingerprint,
      operations: [],
      draft: { sourceName: null, name: 'note', type: 'text', typeDetails: '', defaultValue: '' },
    };
    const fieldPreview = await adapter.previewSchemaFieldDraft(configuration, fieldDraft);
    expect(fieldPreview.operations).toMatchObject([{ kind: 'addNullableField', name: 'note', type: 'text' }]);
    expect(fieldPreview.statements).toEqual([`ALTER TABLE "${schema}"."child" ADD COLUMN "note" text;`]);

    await apply(parent.name, parent.fingerprint, [
      { kind: 'addConstraint', constraintKind: 'primaryKey', name: 'parent_pk', fieldNames: ['id'] },
    ]);
    expect(await adapter.foreignKeyFieldChoices(configuration, schema, 'child', schema, 'parent', ['parent_id']))
      .toMatchObject({ fieldSets: [{ fieldNames: ['id'], compatible: true, reason: null }] });
    expect(await adapter.foreignKeyFieldChoices(configuration, schema, 'child', schema, 'parent', ['label']))
      .toMatchObject({ fieldSets: [{ fieldNames: ['id'], compatible: false }] });
    const childBaseline = await adapter.inspectTable(configuration, schema, 'child');
    if (!childBaseline) throw new Error('The child table disappeared before its migration.');
    await expect(adapter.previewMigration(configuration, {
      schema, table: 'child', baselineFingerprint: childBaseline.fingerprint,
      operations: [
        { kind: 'renameTable', newName: 'child_renamed' },
        { kind: 'addNullableField', name: 'pending_note', type: 'text' },
      ],
    })).rejects.toMatchObject({ kind: 'invalid' });
    await expect(adapter.previewMigration(configuration, {
      schema, table: 'child', baselineFingerprint: childBaseline.fingerprint,
      operations: [{ kind: 'addConstraint', constraintKind: 'foreignKey', name: 'invalid_child_parent_fk',
        fieldNames: ['label'], referencedSchema: schema, referencedTable: 'parent', referencedFieldNames: ['code'] }],
    })).rejects.toMatchObject({ kind: 'invalid' });
    const childOperations: MigrationPreviewRequest['operations'] = [
      { kind: 'alterField', name: 'label', newName: 'label', type: 'varchar', characterMaximumLength: 80,
        numericPrecision: null, numericScale: null, defaultExpression: "'unnamed'", nullable: false },
      { kind: 'addConstraint', constraintKind: 'foreignKey', name: 'child_parent_fk', fieldNames: ['parent_id'],
        referencedSchema: schema, referencedTable: 'parent', referencedFieldNames: ['id'] },
      { kind: 'addConstraint', constraintKind: 'unique', name: 'child_label_uq', fieldNames: ['label'] },
      { kind: 'addConstraint', constraintKind: 'check', name: 'child_positive_id', expression: 'id > 0' },
    ];
    await apply('child', childBaseline.fingerprint, childOperations);
    const changedChild = await adapter.inspectTable(configuration, schema, 'child');
    expect(changedChild?.fields.find(({ name }) => name === 'label')).toMatchObject({
      characterMaximumLength: 80, nullable: false,
    });
    expect(changedChild?.constraints.map(({ kind }) => kind).sort()).toEqual(['check', 'foreignKey', 'unique']);

    const parentWithDependency = await adapter.inspectTable(configuration, schema, 'parent');
    if (!parentWithDependency) throw new Error('The parent table disappeared before restricted-drop check.');
    const restrictedDrop = await adapter.previewMigration(configuration, {
      schema, table: 'parent', baselineFingerprint: parentWithDependency.fingerprint, operations: [{ kind: 'dropTable' }],
    });
    await expect(adapter.applyMigration(configuration, {
      schema, table: 'parent', baselineFingerprint: parentWithDependency.fingerprint, operations: [{ kind: 'dropTable' }],
      reviewedStatements: restrictedDrop.statements, acknowledgedWarnings: restrictedDrop.warnings,
    })).rejects.toBeInstanceOf(MigrationPlanError);
    expect(await adapter.inspectTable(configuration, schema, 'parent')).toBeDefined();

    const rename = await adapter.inspectTable(configuration, schema, 'child');
    if (!rename) throw new Error('The child table disappeared before rename.');
    await expect(adapter.previewMigration(configuration, {
      schema, table: 'child', baselineFingerprint: rename.fingerprint,
      operations: [{ kind: 'renameTable', newName: 'parent' }],
    })).rejects.toMatchObject({ kind: 'invalid' });
    await apply('child', rename.fingerprint, [{ kind: 'renameTable', newName: 'child archive' }]);
    expect(await adapter.inspectTable(configuration, schema, 'child archive')).toMatchObject({ name: 'child archive' });

    const drop = await adapter.inspectTable(configuration, schema, 'child archive');
    if (!drop) throw new Error('The renamed child table disappeared before drop.');
    const dropPreview = await adapter.previewMigration(configuration, {
      schema, table: drop.name, baselineFingerprint: drop.fingerprint, operations: [{ kind: 'dropTable' }],
    });
    expect(dropPreview.warnings.join(' ')).toContain('permanently removes the table and its data');
    const dropped = await adapter.applyMigration(configuration, {
      schema, table: drop.name, baselineFingerprint: drop.fingerprint, operations: [{ kind: 'dropTable' }],
      reviewedStatements: dropPreview.statements, acknowledgedWarnings: dropPreview.warnings,
    });
    expect(dropped.snapshots).toEqual([]);

    const ifMissingPlan: MigrationPreviewRequest = {
      schema, table: 'parent', baselineFingerprint: null,
      operations: [{ kind: 'createTable', table: 'parent', ifNotExists: true, fields: [
        { name: 'id', type: 'text', nullable: true, defaultExpression: null, identityGeneration: null },
      ] }],
    };
    const ifMissingPreview = await adapter.previewMigration(configuration, ifMissingPlan);
    expect(ifMissingPreview.warnings.join(' ')).toContain('does not compare their structure');
    const ifMissingResult = await adapter.applyMigration(configuration, {
      ...ifMissingPlan, reviewedStatements: ifMissingPreview.statements, acknowledgedWarnings: ifMissingPreview.warnings,
    });
    expect(ifMissingResult.snapshots[0]?.fields.find(({ name }) => name === 'id')?.dataType).toBe('bigint');

    const driftBaseline = await adapter.inspectTable(configuration, schema, 'parent');
    if (!driftBaseline) throw new Error('The parent table disappeared before drift check.');
    await admin.query(`ALTER TABLE "${schema}"."parent" ADD COLUMN external_change boolean`);
    await expect(adapter.previewMigration(configuration, {
      schema, table: 'parent', baselineFingerprint: driftBaseline.fingerprint,
      operations: [{ kind: 'addNullableField', name: 'pending', type: 'text' }],
    })).rejects.toMatchObject({ kind: 'drift' });

    const parentAfterDrift = await adapter.inspectTable(configuration, schema, 'parent');
    if (!parentAfterDrift) throw new Error('The parent table disappeared before rollback check.');
    const invalidCheck: MigrationPreviewRequest['operations'][number] = {
      kind: 'addConstraint', constraintKind: 'check', name: 'must_fail', expression: 'id > 5000',
    };
    const failedPreview = await adapter.previewMigration(configuration, {
      schema, table: 'parent', baselineFingerprint: parentAfterDrift.fingerprint, operations: [invalidCheck],
    });
    await expect(adapter.applyMigration(configuration, {
      schema, table: 'parent', baselineFingerprint: parentAfterDrift.fingerprint, operations: [invalidCheck],
      reviewedStatements: failedPreview.statements, acknowledgedWarnings: failedPreview.warnings,
    })).rejects.toBeInstanceOf(MigrationPlanError);
    const afterRollback = await adapter.inspectTable(configuration, schema, 'parent');
    expect(afterRollback?.constraints.some(({ name }) => name === 'must_fail')).toBe(false);
  }, 60_000);

  async function apply(
    table: string,
    baselineFingerprint: string,
    operations: MigrationPreviewRequest['operations'],
  ): Promise<void> {
    const request: MigrationPreviewRequest = { schema, table, baselineFingerprint, operations };
    const preview = await adapter.previewMigration(configuration, request);
    const applyRequest: MigrationApplyRequest = {
      ...request, reviewedStatements: preview.statements, acknowledgedWarnings: preview.warnings,
    };
    await adapter.applyMigration(configuration, applyRequest);
  }
});
