import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PostgresConnectRequest } from '@querydock/contracts';

const { clientConstructor } = vi.hoisted(() => ({ clientConstructor: vi.fn() }));
vi.mock('pg', () => ({ Client: clientConstructor }));

import { MigrationPlanError, PostgresAdapter, PostgresConnectionError } from '../src/feature/postgres/postgres.adapter.ts';

const configuration: PostgresConnectRequest = {
  adapter: 'postgresql', host: 'db.example', port: 5432, database: 'querydock_test', username: 'tester',
  password: 'secret', sslMode: 'disable',
};

const client = {
  connect: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
};

function metadataResponses(canAlter = true): void {
  client.query
    .mockResolvedValueOnce({ rows: [{ schema: 'public', name: 'items', kind: 'table', canAlter, isUpdatable: true, canCreateTable: true }] })
    .mockResolvedValueOnce({ rows: [{
      ordinalPosition: 1, name: 'id', typeSchema: 'pg_catalog', typeName: 'int8', dataType: 'bigint',
      characterMaximumLength: null, numericPrecision: 64, numericScale: 0, nullable: false,
      defaultExpression: null, identityGeneration: null, generated: false, generationExpression: null,
    }] })
    .mockResolvedValueOnce({ rows: [{
      name: 'items_pk', constraintType: 'p', fieldNames: ['id'], definition: 'PRIMARY KEY (id)',
      referencedSchema: null, referencedTable: null, referencedFieldNames: [],
    }] });
}

function mockBrowseQueries(total = '1', rows: Record<string, string | null>[] = [{ id: '7' }]): void {
  client.query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('BEGIN') || sql.startsWith('SET LOCAL') || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { command: sql, rows: [] };
    }
    if (sql.includes('AS "canAlter"')) {
      return { rows: [{ schema: 'public', name: 'items', kind: 'table', canAlter: true, isUpdatable: true, canCreateTable: true }] };
    }
    if (sql.includes('columns.ordinal_position')) {
      return { rows: [{
        ordinalPosition: 1, name: 'id', typeSchema: 'pg_catalog', typeName: 'int8', dataType: 'bigint',
        characterMaximumLength: null, numericPrecision: 64, numericScale: 0, nullable: false,
        defaultExpression: null, identityGeneration: null, generated: false, generationExpression: null,
      }] };
    }
    if (sql.includes('constraint_row.conname')) {
      return { rows: [{
        name: 'items_pk', constraintType: 'p', fieldNames: ['id'], definition: 'PRIMARY KEY (id)',
        referencedSchema: null, referencedTable: null, referencedFieldNames: [],
      }] };
    }
    if (sql.startsWith('SELECT count(*)')) return { rows: [{ total }] };
    if (sql.startsWith('SELECT "id"::text')) return { rows };
    throw new Error(`Unexpected mock SQL: ${sql}`);
  });
}

describe('PostgresAdapter connection and data operations', () => {
  const adapter = new PostgresAdapter();

  beforeEach(() => {
    vi.clearAllMocks();
    client.connect.mockResolvedValue(undefined);
    client.end.mockResolvedValue(undefined);
    clientConstructor.mockImplementation(function ClientStub() { return client; });
  });

  afterEach(() => vi.unstubAllEnvs());

  it('advertises PostgreSQL schema capabilities and supported field types', () => {
    expect(adapter.schemaCapabilities()).toEqual({ createTableIfNotExists: true });
    expect(adapter.editableFieldTypes().map(({ value }) => value)).toContain('jsonb');
  });

  it('verifies the connection and maps ssl modes into pg client options', async () => {
    client.query.mockResolvedValueOnce({ rows: [{ serverVersion: '17.1' }] });
    await expect(adapter.verifyConnection({ ...configuration, sslMode: 'verify-full' }))
      .resolves.toEqual({ serverVersion: '17.1' });
    expect(clientConstructor).toHaveBeenCalledWith(expect.objectContaining({
      host: 'db.example', database: 'querydock_test', ssl: { rejectUnauthorized: true }, application_name: 'QueryDock',
    }));
    expect(client.end).toHaveBeenCalledOnce();
  });

  it('returns unknown for a missing server version and safely maps connection errors', async () => {
    client.query.mockResolvedValueOnce({ rows: [] });
    await expect(adapter.verifyConnection(configuration)).resolves.toEqual({ serverVersion: 'unknown' });
    client.connect.mockRejectedValueOnce(Object.assign(new Error('authentication failed'), { code: '28P01' }));
    await expect(adapter.verifyConnection(configuration)).rejects.toMatchObject({
      safeMessage: 'PostgreSQL authentication failed. Check the username and password.',
    } satisfies Partial<PostgresConnectionError>);
    expect(client.end).toHaveBeenCalled();
  });

  it('enforces the optional allowed-host list after normalizing host case, brackets, and trailing dots', async () => {
    vi.stubEnv('QUERYDOCK_ALLOWED_DATABASE_HOSTS', 'DB.EXAMPLE., [::1]');
    client.query.mockResolvedValueOnce({ rows: [{ serverVersion: '16' }] });
    await expect(adapter.verifyConnection(configuration)).resolves.toEqual({ serverVersion: '16' });
    await expect(adapter.verifyConnection({ ...configuration, host: 'other.example' }))
      .rejects.toMatchObject({ safeMessage: 'This database host is not allowed by the server configuration.' });
    expect(clientConstructor).toHaveBeenCalledOnce();
  });

  it('lists resources using visible relation metadata and returns an empty result unchanged', async () => {
    client.query.mockResolvedValueOnce({ rows: [
      { schema: 'public', name: 'items', kind: 'table', isUpdatable: true, canCreateTable: true },
      { schema: 'public', name: 'item_view', kind: 'view', isUpdatable: false, canCreateTable: true },
    ] });
    await expect(adapter.listResources(configuration)).resolves.toEqual([
      { schema: 'public', name: 'items', kind: 'table', isUpdatable: true, canCreateTable: true },
      { schema: 'public', name: 'item_view', kind: 'view', isUpdatable: false, canCreateTable: true },
    ]);
    client.query.mockResolvedValueOnce({ rows: [] });
    await expect(adapter.listResources(configuration)).resolves.toEqual([]);
  });

  it('validates identifiers before connecting and returns table metadata with stable fingerprint and capabilities', async () => {
    await expect(adapter.inspectTable(configuration, '', 'items')).rejects.toMatchObject({ kind: 'invalid' });
    expect(clientConstructor).not.toHaveBeenCalled();
    metadataResponses();
    const result = await adapter.inspectTable(configuration, 'public', 'items');
    expect(result).toMatchObject({
      schema: 'public', name: 'items', kind: 'table', canAlter: true,
      fields: [{ name: 'id', editableType: 'bigint', editable: true, identityEditable: true }],
      constraints: [{ name: 'items_pk', kind: 'primaryKey', fieldNames: ['id'], editable: true }],
      editableIdentityGenerations: [{ value: 'none' }, { value: 'always' }, { value: 'byDefault' }],
    });
    expect(result?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    metadataResponses(false);
    const readOnly = await adapter.inspectTable(configuration, 'public', 'items');
    expect(readOnly).toMatchObject({ canAlter: false, fields: [{ editable: false, identityEditable: false }] });
    expect(readOnly?.fingerprint).not.toBe(result?.fingerprint);
  });

  it('returns undefined for a resource that is not visible and closes the database client', async () => {
    client.query.mockResolvedValueOnce({ rows: [] });
    await expect(adapter.inspectTable(configuration, 'public', 'missing')).resolves.toBeUndefined();
    expect(client.query).toHaveBeenCalledOnce();
    expect(client.end).toHaveBeenCalledOnce();
  });

  it('returns candidate foreign-key keys with database-adapter type compatibility explanations', async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes("CASE relation.relkind WHEN 'p'")) return { rows: [{ kind: 'table' }] };
      if (sql.includes('idx.indisunique')) return { rows: [{ fieldNames: ['id'] }, { fieldNames: ['code'] }] };
      if (sql.includes('attribute.attname AS name')) {
        if (sql.includes('ANY($3::text[])')) return { rows: [{ name: 'local_id', typeName: 'integer' }] };
        return { rows: [{ name: 'id', typeName: 'integer' }, { name: 'code', typeName: 'text' }] };
      }
      throw new Error(`Unexpected mock SQL: ${sql}`);
    });

    await expect(adapter.foreignKeyFieldChoices(configuration, 'public', 'child', 'public', 'parent', ['local_id']))
      .resolves.toEqual({ fieldSets: [
        { fieldNames: ['id'], label: 'id', compatible: true, reason: null },
        { fieldNames: ['code'], label: 'code', compatible: false,
          reason: 'Local field "local_id" (integer) is not compatible with target field "code" (text).' },
      ] });
  });

  it('turns a schema field draft into a preview and rejects a stale metadata fingerprint', async () => {
    metadataResponses();
    const snapshot = await adapter.inspectTable(configuration, 'public', 'items');
    expect(snapshot).toBeDefined();

    client.query.mockReset();
    client.connect.mockResolvedValue(undefined);
    client.end.mockResolvedValue(undefined);
    metadataResponses();
    const request = {
      schema: 'public', table: 'items', baselineFingerprint: snapshot!.fingerprint, operations: [],
      draft: { sourceName: null, name: 'note', type: 'text', typeDetails: '', defaultValue: '' },
    };
    await expect(adapter.previewSchemaFieldDraft(configuration, request)).resolves.toMatchObject({
      operations: [{ kind: 'addNullableField', name: 'note', type: 'text' }],
      statements: ['ALTER TABLE "public"."items" ADD COLUMN "note" text;'],
    });

    client.query.mockReset();
    client.connect.mockResolvedValue(undefined);
    client.end.mockResolvedValue(undefined);
    metadataResponses();
    await expect(adapter.previewSchemaFieldDraft(configuration, { ...request, baselineFingerprint: '0'.repeat(64) }))
      .rejects.toMatchObject({ kind: 'drift' });
  });

  it('executes table browsing in a read-only transaction and binds filter values and paging', async () => {
    mockBrowseQueries();
    const value = "x%' OR true --";
    const result = await adapter.queryTableData(configuration, 'public', 'items', {
      offset: 25,
      limit: 50,
      sort: [{ field: 'id', direction: 'desc' }],
      filters: [{ field: 'id', operator: 'eq', value }],
      quickFilter: value,
    });
    expect(result).toMatchObject({ totalRows: 1, rows: [{ id: '7' }], columns: [{ name: 'id' }] });
    expect(client.query.mock.calls.map(([sql]) => sql)).toContain('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const countCall = client.query.mock.calls.find(([sql]) => String(sql).startsWith('SELECT count(*)'));
    expect(countCall?.[1]).toEqual([value, `%${value.replaceAll('%', '!%')}%`]);
    const pageCall = client.query.mock.calls.find(([sql]) => String(sql).startsWith('SELECT "id"::text'));
    expect(String(pageCall?.[0])).toContain('ORDER BY "id" DESC');
    expect(pageCall?.[1]).toEqual([value, `%${value.replaceAll('%', '!%')}%`, 50, 25]);
  });

  it('rolls back table data requests with invalid sort/filter fields or incomplete filter operands', async () => {
    mockBrowseQueries();
    await expect(adapter.queryTableData(configuration, 'public', 'items', {
      offset: 0, limit: 20, sort: [{ field: 'missing', direction: 'asc' }], filters: [], quickFilter: '',
    })).rejects.toMatchObject({ kind: 'invalid' });
    expect(client.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');

    client.query.mockReset();
    client.connect.mockResolvedValue(undefined);
    client.end.mockResolvedValue(undefined);
    mockBrowseQueries();
    await expect(adapter.queryTableData(configuration, 'public', 'items', {
      offset: 0, limit: 20, sort: [], filters: [{ field: 'id', operator: 'between', value: '1' }], quickFilter: '',
    })).rejects.toThrow(/needs both a start and end value/);
    expect(client.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });
});
