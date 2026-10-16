import { expect, type Page, type Route } from '@playwright/test';

export const connection = {
  connectionId: 'b7b16b9c-f9e0-4f65-a7de-fad0f548d9d3',
  target: {
    adapter: 'postgresql', host: 'localhost', port: 5432,
    database: 'querydock_e2e', username: 'e2e_user',
  },
  serverVersion: '17.2',
  capabilities: {
    discoverResources: true, inspectTables: true, browseData: true,
    mutateData: false, editSchema: true, executeSql: false,
  },
  schemaCapabilities: { createTableIfNotExists: true },
};

export const resources = [
  { schema: 'public', name: 'customers', kind: 'table', isUpdatable: true },
];

export const editableTypes = [
  { value: 'text', label: 'text', typeSchema: 'pg_catalog', typeName: 'text', identityGenerationSupported: false },
  { value: 'varchar', label: 'varchar', typeSchema: 'pg_catalog', typeName: 'varchar', identityGenerationSupported: false },
  { value: 'integer', label: 'integer', typeSchema: 'pg_catalog', typeName: 'int4', identityGenerationSupported: true },
];

export const tableSnapshot = {
  schema: 'public', name: 'customers', kind: 'table', canAlter: true,
  fingerprint: 'a'.repeat(64), editableFieldTypes: editableTypes,
  editableConstraintKinds: [
    { value: 'primaryKey', label: 'Primary key' }, { value: 'unique', label: 'Unique' },
    { value: 'foreignKey', label: 'Foreign key' }, { value: 'check', label: 'Check' },
  ],
  editableIdentityGenerations: [
    { value: 'none', label: 'None' }, { value: 'always', label: 'Always' },
    { value: 'byDefault', label: 'By default' },
  ],
  fields: [{
    ordinalPosition: 1, name: 'name', typeSchema: 'pg_catalog', typeName: 'text', dataType: 'text',
    editableType: 'text', editable: true, identityEditable: false,
    characterMaximumLength: null, numericPrecision: null, numericScale: null, nullable: false,
    defaultExpression: null, identityGeneration: null, generated: false, generationExpression: null,
  }],
  constraints: [],
};

export interface MockApiOptions {
  connectStatus?: number;
  applyStatus?: number;
  previewError?: string;
  warnings?: string[];
  readOnly?: boolean;
}

export interface ApiCall {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

export async function installMockApi(page: Page, options: MockApiOptions = {}): Promise<ApiCall[]> {
  const calls: ApiCall[] = [];
  let connected = connection;
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;
    let body: Record<string, unknown> | undefined;
    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      try { body = request.postDataJSON() as Record<string, unknown>; } catch { body = undefined; }
    }
    calls.push({ method, path, body });

    if (path === '/api/connections' && method === 'GET') return route.fulfill({ json: [] });
    if (path === '/api/connections' && method === 'POST') {
      if (options.connectStatus && options.connectStatus !== 200) {
        return route.fulfill({ status: options.connectStatus, json: { message: 'PostgreSQL authentication failed. Check the username and password.' } });
      }
      const config = body ?? {};
      connected = {
        ...connection,
        connectionId: `b7b16b9c-f9e0-4f65-a7de-00000000000${calls.filter((call) => call.method === 'POST' && call.path === '/api/connections').length}`,
        target: { ...connection.target, database: String(config.database ?? connection.target.database), username: String(config.username ?? connection.target.username) },
        capabilities: options.readOnly
          ? { ...connection.capabilities, editSchema: false }
          : connection.capabilities,
      };
      return route.fulfill({ json: connected });
    }
    if (path.endsWith('/resources') && method === 'GET') return route.fulfill({ json: resources });
    if (path.endsWith('/schema/field-types') && method === 'GET') return route.fulfill({ json: editableTypes });
    if (path.endsWith('/tables') && method === 'GET') {
      const tableName = url.searchParams.get('table') ?? 'customers';
      return route.fulfill({ json: { ...tableSnapshot, name: tableName, canAlter: !options.readOnly } });
    }
    if (path.endsWith('/migrations/field-draft') && method === 'POST') {
      if (options.previewError) return route.fulfill({ status: 400, json: { message: options.previewError } });
      const draft = body?.draft as Record<string, unknown> | undefined;
      const operation = {
        kind: 'addNullableField', name: draft?.name ?? 'draft_field', type: draft?.type ?? 'text',
      };
      return route.fulfill({ json: {
        baselineFingerprint: body?.baselineFingerprint,
        operations: [operation], statements: [`ALTER TABLE "public"."customers" ADD COLUMN "${operation.name}" ${operation.type}`],
        warnings: options.warnings ?? [],
      } });
    }
    if (path.endsWith('/migrations/preview') && method === 'POST') {
      if (options.previewError) return route.fulfill({ status: 400, json: { message: options.previewError } });
      const ops = (body?.operations as Array<Record<string, unknown>>) ?? [];
      const statements = ops.map((operation) => {
        if (operation.kind === 'createTable') return `CREATE TABLE${operation.ifNotExists ? ' IF NOT EXISTS' : ''} "public"."${operation.table}" (...)`;
        if (operation.kind === 'renameTable') return `ALTER TABLE "public"."customers" RENAME TO "${operation.newName}"`;
        if (operation.kind === 'dropTable') return 'DROP TABLE "public"."customers"';
        if (operation.kind === 'addNullableField') return `ALTER TABLE "public"."customers" ADD COLUMN "${operation.name}" ${operation.type}`;
        if (operation.kind === 'addConstraint') return `ALTER TABLE "public"."customers" ADD CONSTRAINT "${operation.name}" ${operation.constraintKind}`;
        return `${String(operation.kind)} "public"."customers"`;
      });
      return route.fulfill({ json: { baselineFingerprint: body?.baselineFingerprint ?? null, statements, warnings: options.warnings ?? [] } });
    }
    if (path.endsWith('/migrations/apply') && method === 'POST') {
      if (options.applyStatus && options.applyStatus !== 200) return route.fulfill({ status: options.applyStatus, json: { message: 'The migration was rejected by the database. No changes were applied.' } });
      return route.fulfill({ json: { appliedStatements: body?.reviewedStatements ?? [], snapshots: [{ ...tableSnapshot }] } });
    }
    if (path.includes('/foreign-key-targets/') && method === 'POST') {
      return route.fulfill({ json: { fieldSets: [{ fieldNames: ['id'], label: 'id', compatible: true, reason: null }] } });
    }
    if (path.startsWith('/api/connections/') && method === 'DELETE') return route.fulfill({ status: 204, body: '' });
    return route.fulfill({ status: 404, json: { message: `Unmocked API request: ${method} ${path}` } });
  });
  return calls;
}

export async function connectFromHome(
  page: Page,
  database = 'querydock_e2e',
  username = 'e2e_user',
  connected = true,
): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add / Open connection' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect to PostgreSQL' });
  await dialog.getByLabel('Database').fill(database);
  await dialog.getByLabel('Username').fill(username);
  await dialog.getByLabel('Password').fill('test-password');
  await dialog.getByLabel('Password').press('Enter');
  if (connected) {
    await expect(page.locator('.connection-item').filter({ hasText: username })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open table structure' })).toBeVisible();
  }
}
