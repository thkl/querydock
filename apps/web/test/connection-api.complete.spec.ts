import '@angular/compiler';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectResponse } from '@querydock/contracts';
import { ApiRequestError, ConnectionApiService } from '../src/app/feature/workspace/connections/connection-api.service';

const target = {
  adapter: 'postgresql' as const, host: 'localhost', port: 5432, database: 'alpha_test', username: 'tester',
};
const connection: ConnectResponse = {
  connectionId: 'connection/one',
  target,
  serverVersion: '17.2',
  capabilities: {
    discoverResources: true, inspectTables: true, browseData: true,
    mutateData: false, editSchema: true, executeSql: false,
  },
  schemaCapabilities: { createTableIfNotExists: true },
};
const tableSnapshot = {
  schema: 'public', name: 'people', kind: 'table', canAlter: true, fingerprint: 'a'.repeat(64),
  fields: [], constraints: [],
};
const migrationPreview = {
  baselineFingerprint: 'a'.repeat(64), statements: ['ALTER TABLE "public"."people" ADD COLUMN "note" text;'], warnings: [],
};
const applyResult = { appliedStatements: ['ALTER TABLE "public"."people" ADD COLUMN "note" text;'], snapshots: [tableSnapshot] };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: body === null ? undefined : { 'Content-Type': 'application/json' },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('ConnectionApiService API surface', () => {
  it('restores session connections and resources, then derives active connection and schema groups', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/connections') return jsonResponse([connection]);
      if (url.endsWith('/resources')) return jsonResponse([
        { schema: 'public', name: 'people', kind: 'table', isUpdatable: true, canCreateTable: true },
        { schema: 'audit', name: 'events', kind: 'table', isUpdatable: false, canCreateTable: false },
      ]);
      return jsonResponse({ message: 'unexpected request' }, 500);
    });
    vi.stubGlobal('fetch', fetchMock);
    const service = new ConnectionApiService();
    await vi.waitFor(() => expect(service.sessionRestoreComplete()).toBe(true));

    expect(service.activeConnection()).toEqual(connection);
    expect(service.activeResources()).toHaveLength(2);
    expect(service.resourceGroups()).toEqual([
      { schema: 'public', canCreateTable: true, resources: [expect.objectContaining({ name: 'people' })] },
      { schema: 'audit', canCreateTable: false, resources: [expect.objectContaining({ name: 'events' })] },
    ]);
    expect(fetchMock).toHaveBeenCalledWith('/api/connections', expect.objectContaining({ credentials: 'same-origin' }));
  });

  it('connects, stores the returned connection, loads resources, and honors close-on-success', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === '/api/connections' && init?.method === 'POST') return jsonResponse(connection);
      if (String(input) === '/api/connections') return jsonResponse([]);
      if (String(input).endsWith('/resources')) return jsonResponse([]);
      return jsonResponse(connection);
    });
    vi.stubGlobal('fetch', fetchMock);
    const service = new ConnectionApiService();
    await vi.waitFor(() => expect(service.sessionRestoreComplete()).toBe(true));
    service.openConnectDialog();

    const connected = await service.connect({
      adapter: 'postgresql', host: target.host, port: target.port, database: target.database,
      username: target.username, password: 'secret', sslMode: 'disable',
    }, false);

    expect(connected).toBe(true);
    expect(service.connections()).toEqual([connection]);
    expect(service.activeConnectionId()).toBe(connection.connectionId);
    expect(service.connectDialogOpen()).toBe(true);
    expect(service.connecting()).toBe(false);
    const post = fetchMock.mock.calls.map(([url, init]) => [String(url), init] as const)
      .find(([url, init]) => url === '/api/connections' && init?.method === 'POST');
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ database: 'alpha_test', password: 'secret' });
  });

  it('keeps the dialog open while connecting, blocks close, then reports API errors safely', async () => {
    let resolvePost!: (value: Response) => void;
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (String(input) === '/api/connections' && init?.method === 'POST') {
        return new Promise((resolve) => { resolvePost = resolve; });
      }
      if (String(input) === '/api/connections') return Promise.resolve(jsonResponse([]));
      return Promise.resolve(jsonResponse([]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const service = new ConnectionApiService();
    await vi.waitFor(() => expect(service.sessionRestoreComplete()).toBe(true));
    service.openConnectDialog();
    const pending = service.connect({
      adapter: 'postgresql', host: 'localhost', port: 5432, database: 'alpha_test',
      username: 'tester', password: 'bad', sslMode: 'disable',
    });
    service.closeConnectDialog();
    expect(service.connectDialogOpen()).toBe(true);
    resolvePost(jsonResponse({ message: 'PostgreSQL authentication failed.' }, 502));

    await expect(pending).resolves.toBe(false);
    expect(service.connectError()).toBe('PostgreSQL authentication failed.');
    expect(service.connecting()).toBe(false);
    service.closeConnectDialog();
    expect(service.connectDialogOpen()).toBe(false);
  });

  it('selects only known connections and exposes table inspection and encoded request paths', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/connections') return jsonResponse([connection]);
      if (url.endsWith('/resources')) return jsonResponse([]);
      if (url.includes('/tables?')) return jsonResponse(tableSnapshot);
      return jsonResponse({ message: 'unexpected request' }, 500);
    });
    vi.stubGlobal('fetch', fetchMock);
    const service = new ConnectionApiService();
    await vi.waitFor(() => expect(service.sessionRestoreComplete()).toBe(true));
    service.selectConnection('unknown');
    expect(service.activeConnectionId()).toBe(connection.connectionId);
    service.selectConnection(connection.connectionId);
    await expect(service.inspectTable(connection.connectionId, 'sales west', 'people list')).resolves.toEqual(tableSnapshot);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('schema=sales+west&table=people+list'), expect.anything());
  });

  it('validates table query responses and reports malformed server payloads', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === '/api/connections') return jsonResponse([]);
      return jsonResponse({ columns: [{ ordinalPosition: 1, name: 'id', dataType: 'integer', nullable: false }],
        rows: [{ id: '1' }], totalRows: 1 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const service = new ConnectionApiService();
    await vi.waitFor(() => expect(service.sessionRestoreComplete()).toBe(true));
    await expect(service.queryTableData('connection/one', 'public', 'people', {
      offset: 0, limit: 25, sort: [], filters: [], quickFilter: '',
    })).resolves.toMatchObject({ rows: [{ id: '1' }], totalRows: 1 });
    expect(fetchMock).toHaveBeenCalledWith('/api/connections/connection%2Fone/tables/public/people/data/query', expect.anything());

    fetchMock.mockImplementation(async (input) => String(input) === '/api/connections'
      ? jsonResponse([]) : jsonResponse({ rows: [], columns: [], totalRows: 'many' }));
    await expect(service.queryTableData('c', 'public', 'people', {
      offset: 0, limit: 25, sort: [], filters: [], quickFilter: '',
    })).rejects.toThrow('invalid table data response');
  });

  it('dispatches field types, foreign-key choices, migration previews, field drafts, and apply', async () => {
    const fieldDraft = {
      ...migrationPreview,
      operations: [{ kind: 'addNullableField', name: 'note', type: 'text' }],
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/connections') return jsonResponse([]);
      if (url.endsWith('/schema/field-types')) return jsonResponse([{ value: 'text', label: 'Text' }]);
      if (url.endsWith('/foreign-key-targets/public/people/fields')) return jsonResponse({ fieldSets: [] });
      if (url.endsWith('/migrations/preview')) return jsonResponse(migrationPreview);
      if (url.endsWith('/migrations/field-draft')) return jsonResponse(fieldDraft);
      if (url.endsWith('/migrations/apply')) return jsonResponse(applyResult);
      return jsonResponse({ message: 'unexpected request' }, 500);
    });
    vi.stubGlobal('fetch', fetchMock);
    const service = new ConnectionApiService();
    await vi.waitFor(() => expect(service.sessionRestoreComplete()).toBe(true));
    await expect(service.editableFieldTypes('connection/one')).resolves.toEqual([{ value: 'text', label: 'Text' }]);
    await expect(service.foreignKeyFieldChoices('connection/one', 'public', 'people', 'public', 'people', ['id']))
      .resolves.toEqual({ fieldSets: [] });
    await expect(service.previewMigration('connection/one', {
      schema: 'public', table: 'people', baselineFingerprint: 'a'.repeat(64), operations: [
        { kind: 'addNullableField', name: 'note', type: 'text' },
      ],
    })).resolves.toEqual(migrationPreview);
    await expect(service.previewSchemaFieldDraft('connection/one', {
      schema: 'public', table: 'people', baselineFingerprint: 'a'.repeat(64), operations: [],
      draft: { sourceName: null, name: 'note', type: 'text', typeDetails: '', defaultValue: '' },
    })).resolves.toMatchObject({ operations: [{ kind: 'addNullableField', name: 'note' }] });
    await expect(service.applyMigration('connection/one', {
      schema: 'public', table: 'people', baselineFingerprint: 'a'.repeat(64),
      operations: [{ kind: 'addNullableField', name: 'note', type: 'text' }],
      reviewedStatements: migrationPreview.statements, acknowledgedWarnings: [],
    })).resolves.toEqual(applyResult);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('foreign-key-targets/public/people/fields'))).toBe(true);
  });

  it('rejects malformed migration and field-draft responses and extracts structured API errors', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/connections') return jsonResponse([]);
      if (url.endsWith('/migrations/preview')) return jsonResponse({});
      if (url.endsWith('/migrations/field-draft')) return jsonResponse({ ...migrationPreview, operations: 'invalid' });
      return jsonResponse({ message: 'A specific API error.' }, 409);
    });
    vi.stubGlobal('fetch', fetchMock);
    const service = new ConnectionApiService();
    await vi.waitFor(() => expect(service.sessionRestoreComplete()).toBe(true));
    await expect(service.previewMigration('c', {
      schema: 'public', table: 'people', baselineFingerprint: 'a'.repeat(64),
      operations: [{ kind: 'dropTable' }],
    })).rejects.toThrow('invalid migration preview');
    await expect(service.previewSchemaFieldDraft('c', {
      schema: 'public', table: 'people', baselineFingerprint: 'a'.repeat(64), operations: [],
      draft: { sourceName: null, name: 'x', type: 'text', typeDetails: '', defaultValue: '' },
    })).rejects.toThrow('invalid schema field preview');
    await expect(service.editableFieldTypes('c')).rejects.toMatchObject({
      message: 'A specific API error.', status: 409,
    } satisfies Partial<ApiRequestError>);
  });
});

