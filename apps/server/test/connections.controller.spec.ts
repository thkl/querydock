import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectResponse, PostgresConnectRequest } from '@querydock/contracts';
import { ConnectionSessionsService } from '../src/feature/connections/connection-sessions.service.ts';
import { ConnectionsController } from '../src/feature/connections/connections.controller.ts';
import { MigrationPlanError, PostgresAdapter, PostgresConnectionError } from '../src/feature/postgres/postgres.adapter.ts';

const configuration: PostgresConnectRequest = {
  adapter: 'postgresql', host: 'localhost', port: 5432, database: 'querydock_test', username: 'tester',
  password: 'secret', sslMode: 'disable',
};
const connectionId = 'd9d9aa8d-7292-48ea-a7de-3118153871e0';
const connection: ConnectResponse = {
  connectionId,
  target: { adapter: 'postgresql', host: 'localhost', port: 5432, database: 'querydock_test', username: 'tester' },
  serverVersion: '16.2',
  capabilities: {
    discoverResources: true, inspectTables: true, browseData: true,
    mutateData: false, editSchema: true, executeSql: false,
  },
  schemaCapabilities: { createTableIfNotExists: true },
};

function request(): Request {
  return { headers: { cookie: 'qd_session=test' }, secure: false } as Request;
}

function response(): Response {
  return { setHeader: vi.fn() } as unknown as Response;
}

function status(error: unknown): number {
  return error instanceof HttpException ? error.getStatus() : 0;
}

async function expectHttpFailure(
  operation: Promise<unknown>,
  expectedStatus: number,
  responseIncludes?: string,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    expect(status(error)).toBe(expectedStatus);
    if (responseIncludes) {
      const body = error instanceof HttpException ? error.getResponse() : '';
      expect(JSON.stringify(body)).toContain(responseIncludes);
    }
    return;
  }
  throw new Error(`Expected an HTTP ${expectedStatus} failure.`);
}

describe('ConnectionsController', () => {
  let controller: ConnectionsController;
  let sessions: Record<string, ReturnType<typeof vi.fn>>;
  let postgres: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    sessions = {
      addConnection: vi.fn().mockReturnValue(connection),
      listConnections: vi.fn().mockReturnValue([connection]),
      requireConnection: vi.fn().mockReturnValue(configuration),
      removeConnection: vi.fn(),
    };
    postgres = {
      verifyConnection: vi.fn().mockResolvedValue({ serverVersion: '16.2' }),
      schemaCapabilities: vi.fn().mockReturnValue({ createTableIfNotExists: true }),
      listResources: vi.fn().mockResolvedValue([{ schema: 'public', name: 'customers', kind: 'table', isUpdatable: true }]),
      editableFieldTypes: vi.fn().mockReturnValue([{ value: 'text', label: 'Text' }]),
      inspectTable: vi.fn().mockResolvedValue({ schema: 'public', name: 'customers' }),
      queryTableData: vi.fn().mockResolvedValue({ columns: [], rows: [], totalRows: 0 }),
      foreignKeyFieldChoices: vi.fn().mockResolvedValue({ fieldSets: [] }),
      previewMigration: vi.fn().mockResolvedValue({ baselineFingerprint: null, statements: ['CREATE TABLE'], warnings: [] }),
      previewSchemaFieldDraft: vi.fn().mockResolvedValue({ baselineFingerprint: 'a'.repeat(64), statements: [], warnings: [], operations: [] }),
      applyMigration: vi.fn().mockResolvedValue({ appliedStatements: ['ALTER TABLE'], snapshots: [] }),
    };
    controller = new ConnectionsController(
      sessions as unknown as ConnectionSessionsService,
      postgres as unknown as PostgresAdapter,
    );
  });

  it('validates connection settings, verifies PostgreSQL, and stores only advertised capabilities', async () => {
    const result = await controller.connect(configuration, request(), response());
    expect(postgres.verifyConnection).toHaveBeenCalledWith(configuration);
    expect(sessions.addConnection).toHaveBeenCalledWith(expect.anything(), expect.anything(), configuration, expect.objectContaining({
      serverVersion: '16.2',
      capabilities: expect.objectContaining({ browseData: true, mutateData: false, executeSql: false }),
    }));
    expect(result).toEqual(connection);
  });

  it('rejects invalid connection bodies and converts PostgreSQL connection failures to safe gateway errors', async () => {
    await expectHttpFailure(controller.connect({ ...configuration, port: 0 }, request(), response()), 400);
    postgres.verifyConnection.mockRejectedValueOnce(new PostgresConnectionError('private db detail', 'Check PostgreSQL credentials.'));
    await expectHttpFailure(controller.connect(configuration, request(), response()), 502, 'Check PostgreSQL credentials.');
    expect(sessions.addConnection).not.toHaveBeenCalled();
  });

  it('lists session connections and exposes discovered resources', async () => {
    expect(controller.listConnections(request(), response())).toEqual([connection]);
    await expect(controller.listResources(connectionId, request(), response())).resolves.toMatchObject([{ name: 'customers' }]);
    expect(postgres.listResources).toHaveBeenCalledWith(configuration);
  });

  it('maps resource discovery failures to a safe gateway error', async () => {
    postgres.listResources.mockRejectedValueOnce(new Error('private connection string'));
    await expectHttpFailure(controller.listResources(connectionId, request(), response()), 502);
  });

  it('requires a session before returning adapter field types', () => {
    expect(controller.editableFieldTypes(connectionId, request(), response())).toEqual([{ value: 'text', label: 'Text' }]);
    expect(sessions.requireConnection).toHaveBeenCalledWith(expect.anything(), expect.anything(), connectionId);
  });

  it('validates table inspection parameters and maps not-found, adapter, and connection errors', async () => {
    await expectHttpFailure(controller.inspectTable(connectionId, ['public'], 'customers', request(), response()), 400);
    await expect(controller.inspectTable(connectionId, 'public', 'customers', request(), response())).resolves.toMatchObject({ name: 'customers' });
    postgres.inspectTable.mockResolvedValueOnce(undefined);
    await expectHttpFailure(controller.inspectTable(connectionId, 'public', 'missing', request(), response()), 404);
    postgres.inspectTable.mockRejectedValueOnce(new MigrationPlanError('drift', 'Refresh the table.'));
    await expectHttpFailure(controller.inspectTable(connectionId, 'public', 'customers', request(), response()), 409);
    postgres.inspectTable.mockRejectedValueOnce(new PostgresConnectionError('private', 'Permission denied.'));
    await expectHttpFailure(controller.inspectTable(connectionId, 'public', 'customers', request(), response()), 502);
  });

  it('validates, defaults, and dispatches bounded table data queries', async () => {
    await expect(controller.queryTableData(connectionId, 'public', 'customers', {
      offset: 0, limit: 50,
    }, request(), response())).resolves.toMatchObject({ totalRows: 0 });
    expect(postgres.queryTableData).toHaveBeenCalledWith(configuration, 'public', 'customers', {
      offset: 0, limit: 50, sort: [], filters: [], quickFilter: '',
    });
    await expectHttpFailure(controller.queryTableData(connectionId, 'public', 'customers', {
      offset: 0, limit: 101,
    }, request(), response()), 400);
  });

  it('maps table data plan errors and hides raw database failures', async () => {
    postgres.queryTableData.mockRejectedValueOnce(new MigrationPlanError('not-found', 'Not visible.'));
    await expectHttpFailure(controller.queryTableData(connectionId, 'public', 'missing', { offset: 0, limit: 25 }, request(), response()), 404);
    postgres.queryTableData.mockRejectedValueOnce(new Error('secret SQL and values'));
    await expectHttpFailure(controller.queryTableData(connectionId, 'public', 'customers', { offset: 0, limit: 25 }, request(), response()), 502);
  });

  it('validates foreign-key choices and maps adapter validation errors', async () => {
    await expectHttpFailure(controller.foreignKeyFieldChoices(connectionId, 'public', 'child', 'public', 'parent', {}, request(), response()), 400);
    await expect(controller.foreignKeyFieldChoices(connectionId, 'public', 'child', 'public', 'parent', {
      localFieldNames: ['parent_id'],
    }, request(), response())).resolves.toEqual({ fieldSets: [] });
    expect(postgres.foreignKeyFieldChoices).toHaveBeenCalledWith(configuration, 'public', 'child', 'public', 'parent', ['parent_id']);
    postgres.foreignKeyFieldChoices.mockRejectedValueOnce(new MigrationPlanError('invalid', 'Choose compatible fields.'));
    await expectHttpFailure(controller.foreignKeyFieldChoices(connectionId, 'public', 'child', 'public', 'parent', {
      localFieldNames: ['parent_id'],
    }, request(), response()), 400);
  });

  it('validates migration preview and maps migration error kinds', async () => {
    const body = {
      schema: 'public', table: 'customers', baselineFingerprint: null,
      operations: [{ kind: 'createTable', table: 'fresh', ifNotExists: false, fields: [
        { name: 'id', type: 'integer', nullable: false, defaultExpression: null, identityGeneration: null },
      ] }],
    };
    await expectHttpFailure(controller.previewMigration(connectionId, {}, request(), response()), 400);
    await expect(controller.previewMigration(connectionId, body, request(), response())).resolves.toMatchObject({ statements: ['CREATE TABLE'] });
    postgres.previewMigration.mockRejectedValueOnce(new MigrationPlanError('not-found', 'Missing table.'));
    await expectHttpFailure(controller.previewMigration(connectionId, { ...body, baselineFingerprint: 'a'.repeat(64) }, request(), response()), 404);
    postgres.previewMigration.mockRejectedValueOnce(new MigrationPlanError('drift', 'Refresh first.'));
    await expectHttpFailure(controller.previewMigration(connectionId, { ...body, baselineFingerprint: 'a'.repeat(64) }, request(), response()), 409);
    postgres.previewMigration.mockRejectedValueOnce(new MigrationPlanError('unknown', 'Inspect the database.'));
    await expectHttpFailure(controller.previewMigration(connectionId, { ...body, baselineFingerprint: 'a'.repeat(64) }, request(), response()), 500);
  });

  it('validates field-draft requests and returns adapter previews', async () => {
    const body = {
      schema: 'public', table: 'customers', baselineFingerprint: 'a'.repeat(64), operations: [],
      draft: { sourceName: null, name: 'nickname', type: 'text', typeDetails: '', defaultValue: '' },
    };
    await expectHttpFailure(controller.previewSchemaFieldDraft(connectionId, {}, request(), response()), 400);
    await expect(controller.previewSchemaFieldDraft(connectionId, body, request(), response()))
      .resolves.toMatchObject({ operations: [] });
    postgres.previewSchemaFieldDraft.mockRejectedValueOnce(new MigrationPlanError('invalid', 'Unsupported field.'));
    await expectHttpFailure(controller.previewSchemaFieldDraft(connectionId, body, request(), response()), 400);
  });

  it('validates migration apply, returns adapter results, and maps safe errors', async () => {
    const body = {
      schema: 'public', table: 'customers', baselineFingerprint: 'a'.repeat(64),
      operations: [{ kind: 'addNullableField', name: 'nickname', type: 'text' }],
      reviewedStatements: ['ALTER TABLE'], acknowledgedWarnings: [],
    };
    await expectHttpFailure(controller.applyMigration(connectionId, {}, request(), response()), 400);
    await expect(controller.applyMigration(connectionId, body, request(), response()))
      .resolves.toMatchObject({ appliedStatements: ['ALTER TABLE'] });
    postgres.applyMigration.mockRejectedValueOnce(new MigrationPlanError('review-mismatch', 'Review the current SQL.'));
    await expectHttpFailure(controller.applyMigration(connectionId, body, request(), response()), 400);
    postgres.applyMigration.mockRejectedValueOnce(new MigrationPlanError('unknown', 'Inspect before retrying.'));
    await expectHttpFailure(controller.applyMigration(connectionId, body, request(), response()), 500);
    postgres.applyMigration.mockRejectedValueOnce(new PostgresConnectionError('private', 'Database unavailable.'));
    await expectHttpFailure(controller.applyMigration(connectionId, body, request(), response()), 502);
  });

  it('disconnects the requested session connection', () => {
    expect(controller.disconnect(connectionId, request(), response())).toBeUndefined();
    expect(sessions.removeConnection).toHaveBeenCalledWith(expect.anything(), expect.anything(), connectionId);
  });
});
