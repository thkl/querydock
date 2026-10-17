import '@angular/compiler';
import 'fake-indexeddb/auto';
import { Injector, signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectResponse, CreateTableField, MigrationPreviewRequest } from '@querydock/contracts';
import { ApiRequestError, ConnectionApiService } from '../src/app/feature/workspace/connections/connection-api.service';
import { RunbookService } from '../src/app/feature/workspace/runbook/runbook.service';

function connection(id: string, database: string): ConnectResponse {
  return {
    connectionId: id,
    target: { adapter: 'postgresql', host: 'localhost', port: 5432, database, username: 'tester' },
    serverVersion: '16.2',
    capabilities: {
      discoverResources: true, inspectTables: true, browseData: true,
      mutateData: true, editSchema: true, executeSql: true,
    },
    schemaCapabilities: { createTableIfNotExists: true },
  };
}

function createHarness() {
  const alpha = connection('connection-alpha', 'alpha_test');
  const beta = connection('connection-beta', 'beta_test');
  const activeId = signal(alpha.connectionId);
  const connections = {
    activeConnectionId: activeId,
    connections: signal([alpha, beta]),
    activeConnection: () => [alpha, beta].find(({ connectionId: id }) => id === activeId()) ?? null,
    previewMigration: vi.fn(async (_connectionId: string, request: MigrationPreviewRequest) => ({
      baselineFingerprint: request.baselineFingerprint,
      statements: request.operations.map((operation) => `${operation.kind}:${'table' in operation ? operation.table : 'operation'}`),
      warnings: [],
    })),
    applyMigration: vi.fn(async (_connectionId: string, plan: { reviewedStatements: string[] }) => ({
      appliedStatements: plan.reviewedStatements,
      snapshots: [],
    })),
    inspectTable: vi.fn(async () => { throw new Error('Unexpected table inspection.'); }),
    refreshResources: vi.fn(async () => [
      { schema: 'public', name: 'customers' },
      { schema: 'public', name: 'invoices' },
    ]),
  };
  const injector = Injector.create({ providers: [
    { provide: ConnectionApiService, useValue: connections },
    RunbookService,
  ] });
  return { service: injector.get(RunbookService), connections, alpha, beta };
}

const fields: CreateTableField[] = [
  { name: 'id', type: 'integer', nullable: false, defaultExpression: null, identityGeneration: 'always' },
];

beforeEach(async () => clearRunbookStore());

describe('RunbookService', () => {
  it('stages multiple table drafts into one same-schema runbook with server preview SQL', async () => {
    const { service, connections, alpha } = createHarness();

    await service.stageCreateTable(alpha, 'public', 'customers', fields, true, 'draft-customers');
    await service.stageCreateTable(alpha, 'public', 'invoices', fields, false, 'draft-invoices');

    expect(service.runbook()?.operations).toEqual([
      { kind: 'createTable', draftId: 'draft-customers', table: 'customers', ifNotExists: true, fields },
      { kind: 'createTable', draftId: 'draft-invoices', table: 'invoices', ifNotExists: false, fields },
    ]);
    expect(service.previewSql()).toBe('createTable:customers\n\ncreateTable:invoices');
    expect(connections.previewMigration).toHaveBeenLastCalledWith('connection-alpha', expect.objectContaining({
      schema: 'public', baselineFingerprint: null,
    }));
  });

  it('keeps runbooks isolated by database connection and restores the selected target state', async () => {
    const { service, connections, alpha, beta } = createHarness();
    await service.stageCreateTable(alpha, 'public', 'alpha_table', fields, false, 'draft-alpha');

    connections.activeConnectionId.set(beta.connectionId);
    expect(service.runbook()).toBeNull();
    await service.stageCreateTable(beta, 'public', 'beta_table', fields, false, 'draft-beta');
    expect(service.runbook()?.table).toBe('beta_table');

    connections.activeConnectionId.set(alpha.connectionId);
    expect(service.runbook()?.table).toBe('alpha_table');
  });

  it('rejects a second schema while the new-table batch is pending', async () => {
    const { service, alpha } = createHarness();
    await service.stageCreateTable(alpha, 'public', 'customers', fields, false, 'draft-customers');

    await expect(service.stageCreateTable(alpha, 'archive', 'old_customers', fields, false, 'draft-archive'))
      .rejects.toThrow('one schema at a time');
    expect(service.runbook()?.operations).toHaveLength(1);
  });

  it('removes a closed staged draft and refreshes the preview for remaining drafts', async () => {
    const { service, alpha, connections } = createHarness();
    await service.stageCreateTable(alpha, 'public', 'customers', fields, false, 'draft-customers');
    await service.stageCreateTable(alpha, 'public', 'invoices', fields, false, 'draft-invoices');

    await service.discardCreateTableDraft('draft-customers', 'customers');

    expect(service.runbook()?.operations).toEqual([
      { kind: 'createTable', draftId: 'draft-invoices', table: 'invoices', ifNotExists: false, fields },
    ]);
    expect(connections.previewMigration).toHaveBeenLastCalledWith('connection-alpha', expect.objectContaining({
      table: 'invoices', operations: [expect.objectContaining({ draftId: 'draft-invoices' })],
    }));
  });

  it('applies reviewed statements, records server-confirmed SQL, and clears pending work', async () => {
    const { service, alpha, connections } = createHarness();
    await service.stageCreateTable(alpha, 'public', 'customers', fields, false, 'draft-customers');
    expect(service.canApply()).toBe(true);

    await service.applyPending();

    expect(connections.applyMigration).toHaveBeenCalledWith('connection-alpha', expect.objectContaining({
      reviewedStatements: ['createTable:customers'],
      operations: [expect.objectContaining({ table: 'customers' })],
    }));
    expect(service.pendingOperationCount()).toBe(0);
    expect(service.appliedStatements()).toEqual(['createTable:customers']);
    expect(service.canApply()).toBe(false);
    expect(connections.refreshResources).toHaveBeenCalledWith('connection-alpha');
  });

  it('restores staged runbook operations from IndexedDB in a new service instance', async () => {
    const first = createHarness();
    await first.service.stageCreateTable(first.alpha, 'public', 'durable_table', fields, false, 'draft-durable');
    expect(first.service.storageAvailable()).toBe(true);

    const restored = createHarness();
    await restored.service.ready;

    expect(restored.service.runbook()).toMatchObject({
      table: 'durable_table',
      operations: [{ kind: 'createTable', draftId: 'draft-durable', table: 'durable_table' }],
      preview: { statements: ['createTable:durable_table'] },
    });
  });

  it('keeps a lost apply outcome uncertain until the database confirms the batch was not applied', async () => {
    const { service, connections, alpha } = createHarness();
    await service.stageCreateTable(alpha, 'public', 'uncertain_table', fields, false, 'draft-uncertain');
    connections.applyMigration.mockRejectedValueOnce(new Error('Network disconnected after request submission.'));

    await expect(service.applyPending()).rejects.toThrow('Network disconnected');
    expect(service.runbook()?.applyOutcomeUnknown).toBe(true);
    await expect(service.clearRunbook()).resolves.toBeUndefined();
    expect(service.runbook()?.applyOutcomeUnknown).toBe(true);

    connections.inspectTable.mockRejectedValueOnce(new ApiRequestError('The table is not visible.', 404));
    await service.resolveUnknownApply('notApplied');

    expect(service.runbook()?.applyOutcomeUnknown).toBe(false);
    expect(service.runbook()?.operations).toHaveLength(1);
    expect(service.reconciling()).toBe(false);
  });
});

function clearRunbookStore(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('querydock-browser-state', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('runbooks');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('runbooks', 'readwrite');
      transaction.objectStore('runbooks').clear();
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => { database.close(); reject(transaction.error); };
      transaction.onabort = () => { database.close(); reject(transaction.error); };
    };
  });
}
