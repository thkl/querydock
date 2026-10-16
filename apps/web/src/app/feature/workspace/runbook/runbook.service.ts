import { computed, Injectable, inject, signal } from '@angular/core';
import type {
  ConnectResponse,
  ConnectionTarget,
  CreateTableField,
  MigrationApplyRequest,
  MigrationPreviewResponse,
  SchemaFieldDraftRequest,
  SchemaOperation,
  TableSnapshot,
} from '@querydock/contracts';
import { ApiRequestError, ConnectionApiService } from '../connections/connection-api.service';

export interface SchemaRunbook {
  target: ConnectionTarget;
  schema: string;
  table: string;
  baseline: TableSnapshot | null;
  operations: SchemaOperation[];
  preview: MigrationPreviewResponse | null;
  appliedBatches: { statements: string[]; appliedAt: string }[];
  applyOutcomeUnknown: boolean;
  lastAppliedTableAction?: 'dropped';
}

const DATABASE_NAME = 'querydock-browser-state';
const STORE_NAME = 'runbooks';
const LEGACY_ACTIVE_RUNBOOK_KEY = 'active';

@Injectable({ providedIn: 'root' })
export class RunbookService {
  private readonly connections = inject(ConnectionApiService);
  private databasePromise?: Promise<IDBDatabase>;

  private readonly runbooksByConnection = signal<ReadonlyMap<string, SchemaRunbook>>(new Map());
  readonly runbook = computed(() => {
    const target = this.connections.activeConnection()?.target;
    return target ? this.runbooksByConnection().get(runbookKey(target)) ?? null : null;
  });
  readonly pendingOperationCount = computed(() => this.runbook()?.operations.length ?? 0);
  readonly noticeLabel = computed(() => {
    const current = this.runbook();
    if (!current) return null;
    if (this.applying()) return 'Applying runbook…';
    if (current.applyOutcomeUnknown) return 'Runbook outcome unknown · Review';
    const count = current.operations.length;
    return count ? `${count} uncommitted ${count === 1 ? 'change' : 'changes'} · Review runbook` : null;
  });
  readonly previewing = signal(false);
  readonly applying = signal(false);
  readonly reconciling = signal(false);
  readonly error = signal<string | null>(null);
  readonly storageAvailable = signal(true);
  readonly canApply = computed(() => {
    const current = this.runbook();
    return Boolean(current?.preview && current.operations.length && !current.applyOutcomeUnknown
      && this.matchingConnection(current.target));
  });
  readonly previewSql = computed(() => {
    const statements = this.runbook()?.preview?.statements ?? [];
    return statements.length ? statements.join('\n\n') : '-- No pending SQL is staged in this runbook yet.';
  });
  readonly pendingStatementCount = computed(() => this.runbook()?.preview?.statements.length ?? 0);
  readonly appliedStatements = computed(() => this.runbook()?.appliedBatches.flatMap(({ statements }) => statements) ?? []);
  readonly ready = this.restore();

  /** Replaces or removes a staged field operation using a fresh server preview. */
  async stageSchemaFieldDraft(
    connection: ConnectResponse,
    snapshot: TableSnapshot,
    draft: SchemaFieldDraftRequest['draft'],
    replacementName: string | null = null,
  ): Promise<void> {
    await this.ready;
    this.error.set(null);
    const current = this.runbookForTarget(connection.target);
    const currentMatches = current && sameRunbookResource(current, connection.target, snapshot.schema, snapshot.name);
    if (current?.applyOutcomeUnknown) {
      throw new Error('The previous Apply outcome is unknown. Inspect the database before staging or applying more changes.');
    }
    if (current?.operations.some((operation) => operation.kind === 'renameTable' || operation.kind === 'dropTable')) {
      throw new Error('Apply or discard the pending table rename/drop before staging field changes.');
    }
    if (current?.operations.length && !currentMatches) {
      throw new Error('This database runbook has pending changes for another table. Apply or clear those changes before staging a different table.');
    }

    const baseline = currentMatches ? current?.baseline ?? snapshot : snapshot;
    const key = draft.sourceName ?? replacementName ?? draft.name;
    const matches = (candidate: SchemaOperation): boolean =>
      (candidate.kind === 'addNullableField' || candidate.kind === 'alterField') && candidate.name === key;
    const retained = (current?.operations ?? []).filter((candidate) =>
      !(candidate.kind === 'addNullableField' || candidate.kind === 'alterField') || !matches(candidate));
    const request: SchemaFieldDraftRequest = {
      schema: baseline.schema,
      table: baseline.name,
      baselineFingerprint: baseline.fingerprint,
      operations: retained,
      draft,
    };

    this.previewing.set(true);
    try {
      const fieldPreview = await this.connections.previewSchemaFieldDraft(connection.connectionId, request);
      if (!fieldPreview.operations.length) {
        if (current) {
          const updated = { ...current, operations: [], preview: null };
          this.setRunbookForTarget(connection.target, updated);
          await this.persist(updated);
        }
        return;
      }
      const { operations, ...preview } = fieldPreview;
      const runbook: SchemaRunbook = {
        target: connection.target,
        schema: baseline.schema,
        table: baseline.name,
        baseline,
        operations,
        preview,
        appliedBatches: current?.appliedBatches ?? [],
        applyOutcomeUnknown: false,
      };
      this.setRunbookForTarget(connection.target, runbook);
      await this.persist(runbook);
    } catch (error) {
      this.error.set(messageOf(error));
      throw error;
    } finally {
      this.previewing.set(false);
    }
  }

  /** Adds or updates a new table draft in the active database runbook. */
  async stageCreateTable(
    connection: ConnectResponse,
    schema: string,
    table: string,
    fields: CreateTableField[],
    ifNotExists: boolean,
    draftId: string,
  ): Promise<void> {
    await this.ready;
    this.error.set(null);
    const current = this.runbookForTarget(connection.target);
    if (current?.applyOutcomeUnknown) {
      throw new Error('The previous Apply outcome is unknown. Inspect the database before staging or applying more changes.');
    }
    const isPendingCreateBatch = current?.baseline === null
      && current.operations.every((operation) => operation.kind === 'createTable');
    if (current?.operations.length && !isPendingCreateBatch) {
      throw new Error('Apply or clear the pending table changes before adding new table drafts to this runbook.');
    }
    if (isPendingCreateBatch && current?.schema !== schema) {
      throw new Error('A runbook can stage new tables from one schema at a time. Apply or clear the current table drafts before switching schemas.');
    }

    const createOperation: SchemaOperation = { kind: 'createTable', draftId, table, ifNotExists, fields };
    const operations: SchemaOperation[] = [
      ...(isPendingCreateBatch ? current.operations.filter((operation) =>
        operation.kind !== 'createTable' || (operation.draftId ? operation.draftId !== draftId : operation.table !== table)) : []),
      createOperation,
    ];
    const firstTable = operations.find((operation) => operation.kind === 'createTable')?.table ?? table;
    this.previewing.set(true);
    try {
      const preview = await this.connections.previewMigration(connection.connectionId, {
        schema,
        table: firstTable,
        baselineFingerprint: null,
        operations,
      });
      const runbook: SchemaRunbook = {
        target: connection.target,
        schema,
        table: firstTable,
        baseline: null,
        operations,
        preview,
        appliedBatches: current?.appliedBatches ?? [],
        applyOutcomeUnknown: false,
      };
      this.setRunbookForTarget(connection.target, runbook);
      await this.persist(runbook);
    } catch (error) {
      this.error.set(messageOf(error));
      throw error;
    } finally {
      this.previewing.set(false);
    }
  }

  /** Stages or removes one table constraint while retaining other staged constraints. */
  async stageSchemaOperation(
    connection: ConnectResponse,
    snapshot: TableSnapshot,
    operation: Extract<SchemaOperation, { kind: 'addConstraint' | 'dropConstraint' }> | null,
    replacementName: string,
  ): Promise<void> {
    await this.stageSchemaOperations(connection, snapshot, operation ? [operation] : [], [replacementName]);
  }

  /** Stages a table rename or drop as an isolated lifecycle batch. */
  async stageTableOperation(
    connection: ConnectResponse,
    snapshot: TableSnapshot,
    operation: Extract<SchemaOperation, { kind: 'renameTable' | 'dropTable' }>,
  ): Promise<void> {
    await this.ready;
    this.error.set(null);
    const current = this.runbookForTarget(connection.target);
    const matches = current && sameRunbookResource(current, connection.target, snapshot.schema, snapshot.name);
    if (current?.applyOutcomeUnknown) throw new Error('Reconcile the previous Apply outcome before staging another change.');
    if (current?.operations.length && !matches) {
      throw new Error('This database runbook has pending changes for another table. Apply or clear them first.');
    }
    if (current?.operations.length && current.operations.some((candidate) =>
      candidate.kind !== 'renameTable' && candidate.kind !== 'dropTable')) {
      throw new Error('Apply or discard the pending field and constraint changes before renaming or dropping this table.');
    }
    const baseline = matches ? current?.baseline ?? snapshot : snapshot;
    this.previewing.set(true);
    try {
      const operations: SchemaOperation[] = [operation];
      const preview = await this.connections.previewMigration(connection.connectionId, {
        schema: baseline.schema, table: baseline.name, baselineFingerprint: baseline.fingerprint, operations,
      });
      const updated: SchemaRunbook = {
        target: connection.target, schema: baseline.schema, table: baseline.name, baseline, operations, preview,
        appliedBatches: current?.appliedBatches ?? [], applyOutcomeUnknown: false,
      };
      this.setRunbookForTarget(connection.target, updated);
      await this.persist(updated);
    } catch (error) {
      this.error.set(messageOf(error));
      throw error;
    } finally {
      this.previewing.set(false);
    }
  }

  /** Removes a closed new-table draft and refreshes preview SQL for remaining drafts. */
  async discardCreateTableDraft(draftId: string, tableName: string): Promise<void> {
    await this.ready;
    const entry = [...this.runbooksByConnection().entries()].find(([, runbook]) =>
      runbook.operations.some((operation) => matchesCreateTableDraft(operation, draftId, tableName)));
    if (!entry) return;
    const [, current] = entry;
    if (current.applyOutcomeUnknown) {
      throw new Error('Reconcile the runbook Apply outcome before closing this staged table draft.');
    }
    if (current.operations.some((operation) => operation.kind !== 'createTable')) {
      throw new Error('Apply or clear the other pending schema changes before removing this table draft.');
    }
    const remaining = current.operations.filter((operation) => !matchesCreateTableDraft(operation, draftId, tableName));
    let preview: MigrationPreviewResponse | null = null;
    const firstTable = remaining.find((operation) => operation.kind === 'createTable')?.table;
    if (firstTable) {
      const connection = this.matchingConnection(current.target);
      if (!connection) throw new Error('Reconnect to this database before removing a staged table from the runbook.');
      preview = await this.connections.previewMigration(connection.connectionId, {
        schema: current.schema,
        table: firstTable,
        baselineFingerprint: null,
        operations: remaining,
      });
    }
    const updated: SchemaRunbook = {
      ...current,
      table: firstTable ?? current.table,
      operations: remaining,
      preview,
    };
    this.setRunbookForTarget(current.target, updated);
    this.error.set(null);
    await this.persist(updated);
  }

  /** Replaces selected constraint operations after validating the updated batch on the server. */
  async stageSchemaOperations(
    connection: ConnectResponse,
    snapshot: TableSnapshot,
    replacements: Extract<SchemaOperation, { kind: 'addConstraint' | 'dropConstraint' }>[],
    replacementNames: string[],
  ): Promise<void> {
    await this.ready;
    this.error.set(null);
    const current = this.runbookForTarget(connection.target);
    const currentMatches = current && sameRunbookResource(current, connection.target, snapshot.schema, snapshot.name);
    if (current?.applyOutcomeUnknown) {
      throw new Error('The previous Apply outcome is unknown. Inspect the database before staging or applying more changes.');
    }
    if (current?.operations.some((operation) => operation.kind === 'renameTable' || operation.kind === 'dropTable')) {
      throw new Error('Apply or discard the pending table rename/drop before adding a new table draft.');
    }
    if (current?.operations.length && !currentMatches) {
      throw new Error('This database runbook has pending changes for another table. Apply or clear those changes before staging a different table.');
    }

    const baseline = currentMatches ? current?.baseline ?? snapshot : snapshot;
    const retained = (current?.operations ?? []).filter((candidate) =>
      !(candidate.kind === 'addConstraint' || candidate.kind === 'dropConstraint') || !replacementNames.includes(candidate.name));
    const operations = [...retained, ...replacements];
    if (!operations.length) {
      if (current) {
        const updated = { ...current, operations: [], preview: null };
        this.setRunbookForTarget(connection.target, updated);
        await this.persist(updated);
      }
      return;
    }

    this.previewing.set(true);
    try {
      const preview = await this.connections.previewMigration(connection.connectionId, {
        schema: baseline.schema,
        table: baseline.name,
        baselineFingerprint: baseline.fingerprint,
        operations,
      });
      const runbook: SchemaRunbook = {
        target: connection.target,
        schema: baseline.schema,
        table: baseline.name,
        baseline,
        operations,
        preview,
        appliedBatches: current?.appliedBatches ?? [],
        applyOutcomeUnknown: false,
      };
      this.setRunbookForTarget(connection.target, runbook);
      await this.persist(runbook);
    } catch (error) {
      this.error.set(messageOf(error));
      throw error;
    } finally {
      this.previewing.set(false);
    }
  }

  /** Applies exactly the reviewed preview and records the confirmed statements as history. */
  async applyPending(acknowledgedWarnings: string[] = []): Promise<void> {
    await this.ready;
    const current = this.runbook();
    if (!current?.preview || !current.operations.length) throw new Error('There is no reviewed SQL to apply.');
    if (current.applyOutcomeUnknown) throw new Error('This batch has an unknown outcome and cannot be applied again automatically.');
    const connection = this.matchingConnection(current.target);
    if (!connection) throw new Error('Connect to the runbook target database before applying.');

    const plan: MigrationApplyRequest = {
      schema: current.schema,
      table: current.table,
      baselineFingerprint: current.baseline?.fingerprint ?? null,
      operations: current.operations,
      reviewedStatements: current.preview.statements,
      acknowledgedWarnings,
    };
    this.applying.set(true);
    this.error.set(null);
    const inFlight = { ...current, applyOutcomeUnknown: true };
    this.setRunbookForTarget(current.target, inFlight);
    await this.persist(inFlight);
    try {
      const result = await this.connections.applyMigration(connection.connectionId, plan);
      const tableAction = current.operations[0];
      const isDropped = tableAction?.kind === 'dropTable';
      const isRenamed = tableAction?.kind === 'renameTable';
      const updated: SchemaRunbook = {
        ...current,
        table: isRenamed ? tableAction.newName : current.table,
        baseline: current.baseline === null ? null : isDropped ? null : result.snapshots[0],
        operations: [],
        preview: null,
        appliedBatches: [...current.appliedBatches, { statements: result.appliedStatements, appliedAt: new Date().toISOString() }],
        applyOutcomeUnknown: false,
        lastAppliedTableAction: isDropped ? 'dropped' : undefined,
      };
      this.setRunbookForTarget(current.target, updated);
      await this.persist(updated);
      if (current.baseline === null || isDropped || isRenamed) {
        const connectionId = connection.connectionId;
        await this.connections.refreshResources(connectionId).catch(() => undefined);
      }
    } catch (error) {
      if (!isUncertainApplyError(error)) {
        this.setRunbookForTarget(current.target, current);
        await this.persist(current);
      }
      this.error.set(messageOf(error));
      throw error;
    } finally {
      this.applying.set(false);
    }
  }

  /** Discards pending operations and refreshes the baseline when the database is reachable. */
  async discardPending(): Promise<void> {
    await this.ready;
    const current = this.runbook();
    if (!current || current.applyOutcomeUnknown) return;
    const connection = this.matchingConnection(current.target);
    let baseline = current.baseline;
    if (connection && baseline) {
      try {
        baseline = await this.connections.inspectTable(connection.connectionId, current.schema, current.table);
      } catch {
        // Keep the stored baseline if the database cannot be reached right now.
      }
    }
    const updated = { ...current, baseline, operations: [], preview: null };
    this.setRunbookForTarget(current.target, updated);
    this.error.set(null);
    await this.persist(updated);
  }

  /** Reconciles an uncertain apply result by inspecting the actual database state. */
  async resolveUnknownApply(outcome: 'applied' | 'notApplied'): Promise<void> {
    await this.ready;
    if (this.reconciling()) return;
    this.reconciling.set(true);
    this.error.set(null);
    try {
      await this.reconcileUnknownApply(outcome);
    } catch (error) {
      this.error.set(messageOf(error));
      throw error;
    } finally {
      this.reconciling.set(false);
    }
  }

  /** Reconciles schema changes, table lifecycle actions, and create batches separately. */
  private async reconcileUnknownApply(outcome: 'applied' | 'notApplied'): Promise<void> {
    const current = this.runbook();
    if (!current?.applyOutcomeUnknown || !current.preview) return;
    const connection = this.matchingConnection(current.target);
    if (!connection) throw new Error('Reconnect to the runbook target before reconciling the batch.');

    if (current.baseline === null && current.operations.length
      && current.operations.every((operation) => operation.kind === 'createTable')) {
      const observed: TableSnapshot[] = [];
      for (const operation of current.operations) {
        if (operation.kind !== 'createTable') continue;
        try {
          const snapshot = await this.connections.inspectTable(connection.connectionId, current.schema, operation.table);
          observed.push(snapshot);
        } catch (error) {
          if (outcome === 'notApplied' && error instanceof ApiRequestError && error.status === 404) continue;
          throw error;
        }
      }
      if (outcome === 'applied') {
        const allChangesPresent = current.operations.every((operation) => operation.kind === 'createTable'
          && observed.some((snapshot) => operationMatchesSnapshot(snapshot, operation)));
        if (!allChangesPresent) {
          throw new Error('The database does not contain every expected table from this batch. Keep the outcome unknown and inspect it manually.');
        }
        const updated: SchemaRunbook = {
          ...current,
          baseline: null,
          operations: [],
          preview: null,
          appliedBatches: [...current.appliedBatches, {
            statements: current.preview.statements,
            appliedAt: new Date().toISOString(),
          }],
          applyOutcomeUnknown: false,
        };
        this.setRunbookForTarget(current.target, updated);
        this.error.set(null);
        await this.persist(updated);
        return;
      }
      if (observed.length) {
        throw new Error('One or more named tables exist, so this batch cannot safely be marked unapplied. Inspect and reconcile the schema manually.');
      }
      const updated = { ...current, applyOutcomeUnknown: false };
      this.setRunbookForTarget(current.target, updated);
      this.error.set(null);
      await this.persist(updated);
      return;
    }

    const tableOperation = current.operations[0];
    if (tableOperation?.kind === 'renameTable' || tableOperation?.kind === 'dropTable') {
      const oldTable = current.table;
      const newTable = tableOperation.kind === 'renameTable' ? tableOperation.newName : null;
      const oldSnapshot = await this.inspectMaybe(connection.connectionId, current.schema, oldTable);
      const newSnapshot = newTable ? await this.inspectMaybe(connection.connectionId, current.schema, newTable) : null;
      if (outcome === 'applied') {
        const applied = tableOperation.kind === 'dropTable' ? oldSnapshot === null : newSnapshot !== null && oldSnapshot === null;
        if (!applied) throw new Error('The database does not match the expected table rename/drop result. Keep the outcome unknown and inspect it manually.');
        const updated: SchemaRunbook = {
          ...current, table: newTable ?? oldTable, baseline: tableOperation.kind === 'renameTable' ? newSnapshot : null,
          operations: [], preview: null,
          appliedBatches: [...current.appliedBatches, { statements: current.preview.statements, appliedAt: new Date().toISOString() }],
          applyOutcomeUnknown: false, lastAppliedTableAction: tableOperation.kind === 'dropTable' ? 'dropped' : undefined,
        };
        this.setRunbookForTarget(current.target, updated);
        this.error.set(null);
        await this.persist(updated);
        await this.connections.refreshResources(connection.connectionId).catch(() => undefined);
        return;
      }
      if (!oldSnapshot || oldSnapshot.fingerprint !== current.baseline?.fingerprint || newSnapshot) {
        throw new Error('The database does not match the original table state, so this batch cannot be marked unapplied. Inspect and reconcile manually.');
      }
      const updated = { ...current, applyOutcomeUnknown: false };
      this.setRunbookForTarget(current.target, updated);
      this.error.set(null);
      await this.persist(updated);
      return;
    }

    let snapshot: TableSnapshot;
    try {
      snapshot = await this.connections.inspectTable(connection.connectionId, current.schema, current.table);
    } catch (error) {
      if (outcome === 'notApplied' && current.baseline === null && error instanceof ApiRequestError && error.status === 404) {
        const updated = { ...current, applyOutcomeUnknown: false };
        this.setRunbookForTarget(current.target, updated);
        this.error.set(null);
        await this.persist(updated);
        return;
      }
      throw error;
    }
    if (outcome === 'applied') {
      const allChangesPresent = current.operations.every((operation) => operationMatchesSnapshot(snapshot, operation));
      if (!allChangesPresent) {
        throw new Error('The database does not contain every expected schema change from this batch. Keep the outcome unknown and inspect it manually.');
      }
      const updated: SchemaRunbook = {
        ...current,
        baseline: snapshot,
        operations: [],
        preview: null,
        appliedBatches: [...current.appliedBatches, {
          statements: current.preview.statements,
          appliedAt: new Date().toISOString(),
        }],
        applyOutcomeUnknown: false,
      };
      this.setRunbookForTarget(current.target, updated);
      this.error.set(null);
      await this.persist(updated);
      return;
    }

    if (!current.baseline || snapshot.fingerprint !== current.baseline.fingerprint) {
      throw new Error('The table no longer matches the original baseline, so this batch cannot be safely marked unapplied. Inspect and reconcile the schema manually.');
    }
    const updated = { ...current, applyOutcomeUnknown: false };
    this.setRunbookForTarget(current.target, updated);
    this.error.set(null);
    await this.persist(updated);
  }

  /** Checks a table's existence while treating only API 404 responses as absence. */
  private async inspectMaybe(connectionId: string, schema: string, table: string): Promise<TableSnapshot | null> {
    try { return await this.connections.inspectTable(connectionId, schema, table); }
    catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) return null;
      throw error;
    }
  }

  /** Deletes the active connection's saved runbook unless an apply result is uncertain. */
  async clearRunbook(): Promise<void> {
    await this.ready;
    if (this.runbook()?.applyOutcomeUnknown) {
      this.error.set('Reconcile the unknown batch before clearing this runbook.');
      return;
    }
    const current = this.runbook();
    if (!current) return;
    this.setRunbookForTarget(current.target, null);
    this.error.set(null);
    try {
      const database = await this.openDatabase();
      await transactionRequest(database, (store) => store.delete(runbookKey(current.target)));
    } catch {
      this.storageAvailable.set(false);
    }
  }

  /** Sets the user-visible error notice from an unknown failure value. */
  reportError(error: unknown): void {
    this.error.set(messageOf(error));
  }

  /** Downloads SQL confirmed by earlier applies as a local .sql file. */
  async exportAppliedSql(): Promise<void> {
    const statements = this.appliedStatements();
    if (!statements.length || this.runbook()?.applyOutcomeUnknown) return;
    const blob = new Blob([`${statements.join('\n\n')}\n`], { type: 'text/sql;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${this.runbook()?.table ?? 'querydock'}-migration.sql`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  /** Finds the runbook held for a database target, independent of the active workspace tab. */
  private runbookForTarget(target: ConnectionTarget): SchemaRunbook | null {
    return this.runbooksByConnection().get(runbookKey(target)) ?? null;
  }

  /** Updates one target's runbook without mutating the signal's existing map. */
  private setRunbookForTarget(target: ConnectionTarget, runbook: SchemaRunbook | null): void {
    this.runbooksByConnection.update((current) => {
      const next = new Map(current);
      const key = runbookKey(target);
      if (runbook) next.set(key, runbook);
      else next.delete(key);
      return next;
    });
  }

  /** Resolves a currently connected database whose target matches the saved runbook. */
  private matchingConnection(target: ConnectionTarget): ConnectResponse | undefined {
    return this.connections.connections().find((connection) => sameTarget(connection.target, target));
  }

  /** Restores stored runbooks, migrates the legacy active record, and marks storage availability. */
  private async restore(): Promise<void> {
    try {
      const database = await this.openDatabase();
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const transactionDone = new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      const [records, keys] = await Promise.all([
        requestResult<SchemaRunbook[]>(store.getAll()),
        requestResult<IDBValidKey[]>(store.getAllKeys()),
      ]);
      const restored = new Map<string, SchemaRunbook>();
      let legacy: SchemaRunbook | null = null;
      for (let index = 0; index < records.length; index += 1) {
        const rawRecord = records[index];
        const key = String(keys[index]);
        const record = rawRecord?.target ? normalizeRunbook(rawRecord) : rawRecord;
        if (!record?.target) continue;
        if (key === LEGACY_ACTIVE_RUNBOOK_KEY) legacy = record;
        else restored.set(runbookKey(record.target), record);
      }
      await transactionDone;
      if (legacy) {
        const migratedKey = runbookKey(legacy.target);
        const stableRecordExists = keys.some((key) => String(key) === migratedKey);
        if (!restored.has(migratedKey)) restored.set(migratedKey, legacy);
        const writeTransaction = database.transaction(STORE_NAME, 'readwrite');
        const writeStore = writeTransaction.objectStore(STORE_NAME);
        const migrationDone = new Promise<void>((resolve, reject) => {
          writeTransaction.oncomplete = () => resolve();
          writeTransaction.onerror = () => reject(writeTransaction.error);
          writeTransaction.onabort = () => reject(writeTransaction.error);
        });
        if (!stableRecordExists) {
          writeStore.put(restored.get(migratedKey) ?? legacy, migratedKey);
        }
        writeStore.delete(LEGACY_ACTIVE_RUNBOOK_KEY);
        await migrationDone;
      }
      this.runbooksByConnection.set(restored);
    } catch {
      this.storageAvailable.set(false);
    }
  }

  /** Persists a runbook by stable database-target key and marks storage availability. */
  private async persist(runbook: SchemaRunbook): Promise<void> {
    try {
      const database = await this.openDatabase();
      await transactionRequest(database, (store) => store.put(runbook, runbookKey(runbook.target)));
      this.storageAvailable.set(true);
    } catch {
      this.storageAvailable.set(false);
    }
  }

  /** Opens the runbook object store and reuses its connection for this service lifetime. */
  private openDatabase(): Promise<IDBDatabase> {
    if (!this.databasePromise) {
      this.databasePromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
          reject(new Error('IndexedDB is unavailable.'));
          return;
        }
        const request = indexedDB.open(DATABASE_NAME, 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return this.databasePromise;
  }
}

/** Builds a stable IndexedDB key from database identity without including credentials. */
function runbookKey(target: ConnectionTarget): string {
  return `connection:${encodeURIComponent(JSON.stringify([
    target.adapter,
    target.host,
    target.port,
    target.database,
    target.username,
  ]))}`;
}

/** Compares target identity while deliberately excluding the password. */
function sameTarget(left: ConnectionTarget, right: ConnectionTarget): boolean {
  return left.adapter === right.adapter && left.host === right.host && left.port === right.port
    && left.database === right.database && left.username === right.username;
}

/** Checks whether pending operations belong to the same connected table. */
function sameRunbookResource(
  runbook: SchemaRunbook,
  target: ConnectionTarget,
  schema: string,
  table: string,
): boolean {
  return sameTarget(runbook.target, target) && runbook.schema === schema && runbook.table === table;
}

/** Matches a create operation by stable draft ID, with legacy table-name fallback. */
function matchesCreateTableDraft(operation: SchemaOperation, draftId: string, tableName: string): boolean {
  return operation.kind === 'createTable'
    && (operation.draftId === draftId || (!operation.draftId && operation.table === tableName));
}

/** Fills fields introduced after the legacy runbook format was stored. */
function normalizeRunbook(runbook: SchemaRunbook): SchemaRunbook {
  return {
    ...runbook,
    operations: runbook.operations.map((operation) => {
      if (operation.kind !== 'createTable') return operation;
      const legacy = operation as typeof operation & { table?: string; ifNotExists?: boolean };
      return {
        ...operation,
        table: legacy.table ?? runbook.table,
        ifNotExists: legacy.ifNotExists ?? false,
      };
    }),
  };
}

/** Converts errors into a stable message for the runbook notice area. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'The runbook request failed.';
}

/** Keeps the pending batch marked uncertain when a failure cannot prove rollback. */
function isUncertainApplyError(error: unknown): boolean {
  return !(error instanceof ApiRequestError) || error.status === null || error.status >= 500;
}

/** Checks whether an observed field matches a staged field operation. */
function operationMatchesField(
  field: TableSnapshot['fields'][number],
  operation: Extract<SchemaOperation, { kind: 'addNullableField' | 'alterField' }>,
): boolean {
  const typeMatches = field.editableType === operation.type
    && field.characterMaximumLength === (operation.characterMaximumLength ?? null)
    && field.numericPrecision === (operation.numericPrecision ?? null)
    && field.numericScale === (operation.numericScale ?? null);
  const defaultExpression = operation.defaultExpression?.trim() ?? null;
  const nullableMatches = operation.kind === 'addNullableField'
    ? operation.identityGeneration ? !field.nullable : field.nullable
    : operation.nullable === undefined || field.nullable === operation.nullable;
  const identityMatches = operation.identityGeneration === undefined
    || field.identityGeneration === operation.identityGeneration;
  return typeMatches && (field.defaultExpression?.trim() ?? null) === defaultExpression
    && nullableMatches && identityMatches;
}

/** Checks whether live metadata proves that one staged schema operation was applied. */
function operationMatchesSnapshot(snapshot: TableSnapshot, operation: SchemaOperation): boolean {
  if (operation.kind === 'createTable') {
    return snapshot.name === operation.table && (operation.ifNotExists || snapshot.fields.length === operation.fields.length
      && operation.fields.every((expected) => {
        const field = snapshot.fields.find((candidate) => candidate.name === expected.name);
        return field !== undefined && createdFieldMatches(field, expected);
      }));
  }
  if (operation.kind === 'renameTable') return snapshot.name === operation.newName;
  if (operation.kind === 'dropTable') return false;
  if (operation.kind === 'addNullableField' || operation.kind === 'alterField') {
    const name = operation.kind === 'alterField' ? operation.newName : operation.name;
    const field = snapshot.fields.find((candidate) => candidate.name === name);
    return field !== undefined && operationMatchesField(field, operation);
  }
  if (operation.kind === 'dropConstraint') {
    return !snapshot.constraints.some((candidate) => candidate.name === operation.name);
  }
  if (operation.kind !== 'addConstraint') return false;
  const constraint = snapshot.constraints.find((candidate) => candidate.name === operation.name);
  if (!constraint || constraint.kind !== operation.constraintKind) return false;
  if (operation.constraintKind === 'check') {
    const normalize = (value: string) => value.replace(/^CHECK\s*/i, '').replaceAll('"', '')
      .replace(/[\s()]/g, '').toLowerCase();
    return normalize(constraint.definition) === normalize(operation.expression);
  }
  const fieldsMatch = constraint.fieldNames.length === operation.fieldNames.length
    && constraint.fieldNames.every((name, index) => name === operation.fieldNames[index]);
  if (!fieldsMatch) return false;
  if (operation.constraintKind !== 'foreignKey') return true;
  return constraint.referencedSchema === operation.referencedSchema
    && constraint.referencedTable === operation.referencedTable
    && constraint.referencedFieldNames.length === operation.referencedFieldNames.length
    && constraint.referencedFieldNames.every((name, index) => name === operation.referencedFieldNames[index]);
}

/** Compares a created table field's type, size, default, nullability, and identity. */
function createdFieldMatches(
  field: TableSnapshot['fields'][number],
  expected: Extract<SchemaOperation, { kind: 'createTable' }>['fields'][number],
): boolean {
  const typeMatches = field.editableType === expected.type;
  let detailsMatch = true;
  if (expected.type === 'varchar') {
    const length = expected.typeDetails?.trim() ? Number(expected.typeDetails.trim()) : null;
    detailsMatch = field.characterMaximumLength === length;
  } else if (expected.type === 'numeric') {
    const match = expected.typeDetails?.trim()
      ? /^(\d+)(?:\s*,\s*(-?\d+))?$/.exec(expected.typeDetails.trim())
      : null;
    if (match) {
      const precision = Number(match[1]);
      const scale = Number(match[2] ?? 0);
      detailsMatch = field.numericPrecision === precision && field.numericScale === scale;
    }
  }
  return typeMatches && detailsMatch && field.nullable === expected.nullable
    && (field.defaultExpression?.trim() ?? null) === (expected.defaultExpression?.trim() || null)
    && (field.identityGeneration ?? null) === expected.identityGeneration;
}

/** Converts an IndexedDB request into a Promise for restoration workflows. */
function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Resolves an object-store operation only after its IndexedDB transaction commits. */
function transactionRequest<T>(
  database: IDBDatabase,
  requestFactory: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const request = requestFactory(transaction.objectStore(STORE_NAME));
    let result: T;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
