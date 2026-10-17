import { computed, Injectable, inject, signal } from '@angular/core';
import type {
  ConnectResponse,
  ConnectionTarget,
  CreateTableField,
  MigrationApplyRequest,
  MigrationTablePlan,
  MigrationPreviewResponse,
  DataRunbookPreviewRequest,
  SchemaFieldDraftRequest,
  SchemaOperation,
  TableSnapshot,
  TableDataRowUpdate,
  TableDataRowInsert,
  TableDataRowDelete,
} from '@querydock/contracts';
import { ApiRequestError, ConnectionApiService } from '../connections/connection-api.service';

export interface SchemaRunbook {
  target: ConnectionTarget;
  schema: string;
  table: string;
  baseline: TableSnapshot | null;
  operations: SchemaOperation[];
  /** Per-table draft plans; absent in older browser-stored runbooks. */
  tableChanges?: SchemaRunbookTableChange[];
  preview: MigrationPreviewResponse | null;
  appliedBatches: { statements: string[]; appliedAt: string }[];
  applyOutcomeUnknown: boolean;
  lastAppliedTableAction?: 'dropped';
}

export interface SchemaRunbookTableChange {
  schema: string;
  table: string;
  baseline: TableSnapshot | null;
  operations: SchemaOperation[];
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
  readonly pendingOperationCount = computed(() => this.runbook()?.tableChanges?.reduce((total, plan) => total + plan.operations.length, 0)
    ?? this.runbook()?.operations.length ?? 0);
  readonly noticeLabel = computed(() => {
    const current = this.runbook();
    if (!current) return null;
    if (this.applying()) return 'Applying runbook…';
    if (current.applyOutcomeUnknown) return 'Runbook outcome unknown · Review';
    const count = current.tableChanges?.reduce((total, plan) => total + plan.operations.length, 0) ?? current.operations.length;
    return count ? `${count} uncommitted ${count === 1 ? 'change' : 'changes'} · Review runbook` : null;
  });
  readonly previewing = signal(false);
  readonly applying = signal(false);
  readonly reconciling = signal(false);
  readonly error = signal<string | null>(null);
  readonly storageAvailable = signal(true);
  readonly canApply = computed(() => {
    const current = this.runbook();
    return Boolean(current?.preview && this.pendingOperationCount() && !current.applyOutcomeUnknown
      && this.matchingConnection(current.target));
  });
  readonly previewSql = computed(() => {
    const statements = this.runbook()?.preview?.statements ?? [];
    return statements.length ? statements.join('\n\n') : '-- No pending SQL is staged in this runbook yet.';
  });
  readonly pendingStatementCount = computed(() => this.runbook()?.preview?.statements.length ?? 0);
  readonly appliedStatements = computed(() => this.runbook()?.appliedBatches.flatMap(({ statements }) => statements) ?? []);
  readonly ready = this.restore();

  /** Returns row-key identities marked for deletion while staged deletes await Apply. */
  pendingDeletedRowIdentities(connection: ConnectResponse, schema: string, table: string): ReadonlySet<string> {
    const current = this.runbookForTarget(connection.target);
    if (!current) return new Set();
    return new Set(this.operationsForResource(current, schema, table).flatMap((operation) => operation.kind === 'deleteDataRow'
      ? [rowKeyIdentity(operation.key)] : []));
  }

  /** Returns staged inserts for restoring their draft rows when the data page is reopened. */
  pendingDataRowInserts(connection: ConnectResponse, schema: string, table: string): TableDataRowInsert[] {
    const current = this.runbookForTarget(connection.target);
    if (!current) return [];
    return this.operationsForResource(current, schema, table).flatMap((operation) => operation.kind === 'insertDataRow'
      ? [{ draftId: operation.draftId, values: operation.values }]
      : []);
  }

  /** Returns staged row updates so the data grid can restore their draft values after navigation. */
  pendingDataRowUpdates(connection: ConnectResponse, schema: string, table: string): TableDataRowUpdate[] {
    const current = this.runbookForTarget(connection.target);
    if (!current) return [];
    return this.operationsForResource(current, schema, table).flatMap((operation) => operation.kind === 'updateDataRow'
      ? [{ key: operation.key, expectedVersion: operation.expectedVersion, changes: operation.changes }]
      : []);
  }

  /** Returns staged operations belonging to one table, including dependency-batch plans. */
  operationsForResource(runbook: SchemaRunbook, schema: string, table: string): SchemaOperation[] {
    const changes = this.tableChangesOf(runbook);
    return changes.find((plan) => plan.schema === schema && plan.table === table)?.operations ?? [];
  }

  /** Returns the table plan held by the active database runbook, if one exists. */
  tableChangeForResource(schema: string, table: string): SchemaRunbookTableChange | null {
    const current = this.runbook();
    return current ? this.tableChangesOf(current).find((plan) => plan.schema === schema && plan.table === table) ?? null : null;
  }

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
    const changes = current ? this.tableChangesOf(current) : [];
    const planIndex = changes.findIndex(({ schema, table }) => schema === snapshot.schema && table === snapshot.name);
    const existingPlan = planIndex >= 0 ? changes[planIndex] : null;
    if (current?.applyOutcomeUnknown) {
      throw new Error('The previous Apply outcome is unknown. Inspect the database before staging or applying more changes.');
    }
    if (existingPlan?.operations.some((operation) => operation.kind === 'renameTable' || operation.kind === 'dropTable')) {
      throw new Error('Apply or discard the pending table rename/drop before staging field changes for that table.');
    }
    if (changes.some((plan) => plan.operations.some(isDataOperation))) {
      throw new Error('Apply or discard pending data changes before staging schema changes in this runbook.');
    }
    const baseline = existingPlan?.baseline ?? snapshot;
    const existingOperations = existingPlan?.operations ?? [];
    const key = draft.sourceName ?? replacementName ?? draft.name;
    const matches = (candidate: SchemaOperation): boolean =>
      (candidate.kind === 'addNullableField' || candidate.kind === 'alterField') && candidate.name === key;
    const retained = existingOperations.filter((candidate) =>
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
      const nextOperations = fieldPreview.operations;
      const nextChanges = this.replaceTableChange(changes, {
        schema: baseline.schema,
        table: baseline.name,
        baseline,
        operations: nextOperations,
      });
      if (!fieldPreview.operations.length) {
        if (!nextChanges.length && !current) return;
        const preview = await this.previewTableChanges(connection.connectionId, nextChanges);
        const updated = this.runbookWithTableChanges(current, connection.target, nextChanges, preview);
        this.setRunbookForTarget(connection.target, updated);
        await this.persist(updated);
        return;
      }
      const preview = await this.previewTableChanges(connection.connectionId, nextChanges);
      const runbook = this.runbookWithTableChanges(current, connection.target, nextChanges, preview);
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

  /** Stages a rename or drop, retaining staged foreign-key removals before a drop. */
  async stageTableOperation(
    connection: ConnectResponse,
    snapshot: TableSnapshot,
    operation: Extract<SchemaOperation, { kind: 'renameTable' | 'dropTable' }>,
  ): Promise<void> {
    await this.ready;
    this.error.set(null);
    const current = this.runbookForTarget(connection.target);
    const changes = current ? this.tableChangesOf(current) : [];
    const existingPlan = changes.find(({ schema, table }) => schema === snapshot.schema && table === snapshot.name) ?? null;
    if (current?.applyOutcomeUnknown) throw new Error('Reconcile the previous Apply outcome before staging another change.');
    if (changes.some((plan) => plan.operations.some(isDataOperation))) {
      throw new Error('Apply or discard pending data changes before staging table schema changes.');
    }
    const existingOperations = existingPlan?.operations ?? [];
    const canDropAfterStagingForeignKeyRemovals = operation.kind === 'dropTable'
      && existingOperations.length > 0
      && existingOperations.every((candidate) => candidate.kind === 'dropConstraint'
        && (existingPlan?.baseline ?? snapshot).constraints.some(({ name, kind }) =>
          name === candidate.name && kind === 'foreignKey'));
    if (existingOperations.length && existingOperations.some((candidate) =>
      candidate.kind !== 'renameTable' && candidate.kind !== 'dropTable')
      && !canDropAfterStagingForeignKeyRemovals) {
      throw new Error('Apply or discard the pending field and constraint changes before renaming or dropping this table.');
    }
    const baseline = existingPlan?.baseline ?? snapshot;
    const operations = canDropAfterStagingForeignKeyRemovals
      ? [...existingOperations, operation]
      : [operation];
    const nextChanges = this.replaceTableChange(changes, {
      schema: baseline.schema,
      table: baseline.name,
      baseline,
      operations,
    });
    this.previewing.set(true);
    try {
      const preview = await this.previewTableChanges(connection.connectionId, nextChanges);
      const updated = this.runbookWithTableChanges(current, connection.target, nextChanges, preview);
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
    const changes = current ? this.tableChangesOf(current) : [];
    const planIndex = changes.findIndex(({ schema, table }) => schema === snapshot.schema && table === snapshot.name);
    const existingPlan = planIndex >= 0 ? changes[planIndex] : null;
    if (current?.applyOutcomeUnknown) {
      throw new Error('The previous Apply outcome is unknown. Inspect the database before staging or applying more changes.');
    }
    if (changes.some((plan) => plan.operations.some(isDataOperation))) {
      throw new Error('Apply or discard pending data changes before staging schema changes in this runbook.');
    }
    if (existingPlan?.operations.some((candidate) => candidate.kind === 'renameTable' || candidate.kind === 'dropTable')) {
      throw new Error('Apply or discard the pending table rename/drop before staging constraints for that table.');
    }

    const baseline = existingPlan?.baseline ?? snapshot;
    const retained = (existingPlan?.operations ?? []).filter((candidate) =>
      !(candidate.kind === 'addConstraint' || candidate.kind === 'dropConstraint') || !replacementNames.includes(candidate.name));
    const operations = [...retained, ...replacements];
    const nextChanges = this.replaceTableChange(changes, {
      schema: baseline.schema,
      table: baseline.name,
      baseline,
      operations,
    });
    if (!operations.length) {
      if (!nextChanges.length && !current) return;
      const preview = await this.previewTableChanges(connection.connectionId, nextChanges);
      const updated = this.runbookWithTableChanges(current, connection.target, nextChanges, preview);
      this.setRunbookForTarget(connection.target, updated);
      await this.persist(updated);
      return;
    }

    this.previewing.set(true);
    try {
      const preview = await this.previewTableChanges(connection.connectionId, nextChanges);
      const runbook = this.runbookWithTableChanges(current, connection.target, nextChanges, preview);
      this.setRunbookForTarget(connection.target, runbook);
      await this.persist(runbook);
    } catch (error) {
      this.error.set(messageOf(error));
      throw error;
    } finally {
      this.previewing.set(false);
    }
  }

  /** Stages one completed row edit as server-generated SQL in the database runbook. */
  async stageDataRowUpdate(
    connection: ConnectResponse,
    schema: string,
    table: string,
    update: TableDataRowUpdate,
  ): Promise<void> {
    await this.ready;
    this.error.set(null);
    const current = this.runbookForTarget(connection.target);
    const matches = current && sameRunbookResource(current, connection.target, schema, table);
    if (current?.applyOutcomeUnknown) throw new Error('The previous Apply outcome is unknown. Inspect the database before staging or applying more changes.');
    this.assertDataOperationCanBeStaged(current, schema, table);
    if (current?.operations.length && !matches) {
      throw new Error('This database runbook has pending changes for another table. Apply or clear those changes before staging a row edit.');
    }
    if (current?.operations.some((operation) => operation.kind !== 'updateDataRow'
      && operation.kind !== 'insertDataRow' && operation.kind !== 'deleteDataRow')) {
      throw new Error('Apply or discard the pending schema changes before staging data row edits.');
    }

    const identity = rowKeyIdentity(update.key);
    const retained = ((current?.operations ?? []).filter((operation) =>
      (operation.kind !== 'updateDataRow' && operation.kind !== 'deleteDataRow')
      || rowKeyIdentity(operation.key) !== identity)) as DataRunbookPreviewRequest['operations'];
    const operations = [...retained, { kind: 'updateDataRow' as const, ...update }];
    this.previewing.set(true);
    try {
      const generated = await this.connections.previewDataRunbook(connection.connectionId, schema, table, operations);
      if (matches && current?.baseline && current.baseline.fingerprint !== generated.snapshot.fingerprint) {
        throw new Error('The table structure changed since this Runbook was started. Refresh the table and review the pending operations again.');
      }
      const baseline = matches ? current?.baseline ?? generated.snapshot : generated.snapshot;
      const runbook: SchemaRunbook = {
        target: connection.target,
        schema: baseline.schema,
        table: baseline.name,
        baseline,
        operations,
        preview: generated.preview,
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

  /** Stages one new grid row as reviewed SQL, replacing a prior edit to the same draft row. */
  async stageDataRowInsert(
    connection: ConnectResponse,
    schema: string,
    table: string,
    insert: TableDataRowInsert,
  ): Promise<void> {
    await this.ready;
    this.error.set(null);
    const current = this.runbookForTarget(connection.target);
    const matches = current && sameRunbookResource(current, connection.target, schema, table);
    if (current?.applyOutcomeUnknown) throw new Error('The previous Apply outcome is unknown. Inspect the database before staging or applying more changes.');
    this.assertDataOperationCanBeStaged(current, schema, table);
    if (current?.operations.length && !matches) {
      throw new Error('This database runbook has pending changes for another table. Apply or clear those changes before staging a row.');
    }
    if (current?.operations.some((operation) => operation.kind !== 'updateDataRow'
      && operation.kind !== 'insertDataRow' && operation.kind !== 'deleteDataRow')) {
      throw new Error('Apply or discard the pending schema changes before staging data rows.');
    }
    const retained = ((current?.operations ?? []).filter((operation) =>
      operation.kind !== 'insertDataRow' || operation.draftId !== insert.draftId)) as DataRunbookPreviewRequest['operations'];
    const operations = [...retained, { kind: 'insertDataRow' as const, ...insert }];
    this.previewing.set(true);
    try {
      const generated = await this.connections.previewDataRunbook(connection.connectionId, schema, table, operations);
      if (matches && current?.baseline && current.baseline.fingerprint !== generated.snapshot.fingerprint) {
        throw new Error('The table structure changed since this Runbook was started. Refresh the table and review the pending operations again.');
      }
      const baseline = matches ? current?.baseline ?? generated.snapshot : generated.snapshot;
      const runbook: SchemaRunbook = {
        target: connection.target,
        schema: baseline.schema,
        table: baseline.name,
        baseline,
        operations,
        preview: generated.preview,
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

  /** Removes a staged insert when its draft row is deleted from the grid before Apply. */
  async discardDataRowInsert(
    connection: ConnectResponse,
    schema: string,
    table: string,
    draftId: string,
  ): Promise<void> {
    await this.ready;
    const current = this.runbookForTarget(connection.target);
    if (!current || !sameRunbookResource(current, connection.target, schema, table)) return;
    if (current.operations.some((operation) => operation.kind !== 'updateDataRow'
      && operation.kind !== 'insertDataRow' && operation.kind !== 'deleteDataRow')) {
      throw new Error('Apply or discard the pending schema changes before removing a staged data row.');
    }
    const operations = current.operations.filter((operation) =>
      operation.kind !== 'insertDataRow' || operation.draftId !== draftId) as DataRunbookPreviewRequest['operations'];
    if (operations.length === current.operations.length) return;
    this.previewing.set(true);
    try {
      const preview = operations.length
        ? (await this.connections.previewDataRunbook(connection.connectionId, schema, table, operations)).preview
        : null;
      const updated = { ...current, operations, preview, applyOutcomeUnknown: false };
      this.setRunbookForTarget(connection.target, updated);
      await this.persist(updated);
    } catch (error) {
      this.error.set(messageOf(error));
      throw error;
    } finally {
      this.previewing.set(false);
    }
  }

  /** Stages a guarded row deletion as server-generated SQL in the current data Runbook. */
  async stageDataRowDelete(
    connection: ConnectResponse,
    schema: string,
    table: string,
    deletion: TableDataRowDelete,
  ): Promise<void> {
    await this.ready;
    this.error.set(null);
    const current = this.runbookForTarget(connection.target);
    const matches = current && sameRunbookResource(current, connection.target, schema, table);
    if (current?.applyOutcomeUnknown) throw new Error('The previous Apply outcome is unknown. Inspect the database before staging or applying more changes.');
    this.assertDataOperationCanBeStaged(current, schema, table);
    if (current?.operations.length && !matches) {
      throw new Error('This database runbook has pending changes for another table. Apply or clear those changes before staging a row delete.');
    }
    if (current?.operations.some((operation) => operation.kind !== 'updateDataRow'
      && operation.kind !== 'insertDataRow' && operation.kind !== 'deleteDataRow')) {
      throw new Error('Apply or discard the pending schema changes before staging data row deletes.');
    }
    const identity = rowKeyIdentity(deletion.key);
    const retained = ((current?.operations ?? []).filter((operation) =>
      (operation.kind !== 'updateDataRow' && operation.kind !== 'deleteDataRow')
      || rowKeyIdentity(operation.key) !== identity)) as DataRunbookPreviewRequest['operations'];
    const operations = [...retained, { kind: 'deleteDataRow' as const, ...deletion }];
    this.previewing.set(true);
    try {
      const generated = await this.connections.previewDataRunbook(connection.connectionId, schema, table, operations);
      if (matches && current?.baseline && current.baseline.fingerprint !== generated.snapshot.fingerprint) {
        throw new Error('The table structure changed since this Runbook was started. Refresh the table and review the pending operations again.');
      }
      const baseline = matches ? current?.baseline ?? generated.snapshot : generated.snapshot;
      const runbook: SchemaRunbook = {
        target: connection.target,
        schema: baseline.schema,
        table: baseline.name,
        baseline,
        operations,
        preview: generated.preview,
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
    const tableChanges = current ? this.tableChangesOf(current) : [];
    if (!current?.preview || !tableChanges.length) throw new Error('There is no reviewed SQL to apply.');
    if (current.applyOutcomeUnknown) throw new Error('This batch has an unknown outcome and cannot be applied again automatically.');
    const connection = this.matchingConnection(current.target);
    if (!connection) throw new Error('Connect to the runbook target database before applying.');

    const tablePlans: MigrationTablePlan[] = tableChanges.map(({ schema, table, baseline, operations }) => ({
      schema,
      table,
      baselineFingerprint: baseline?.fingerprint ?? null,
      operations,
    }));
    const schemaChanged = this.hasSchemaChanges(tableChanges);
    const plan: MigrationApplyRequest = {
      ...tablePlans[0]!,
      ...(tablePlans.length > 1 ? { tablePlans } : {}),
      reviewedStatements: current.preview.statements,
      acknowledgedWarnings,
    };
    this.applying.set(true);
    this.error.set(null);
    const inFlight = { ...current, applyOutcomeUnknown: true };
    this.setRunbookForTarget(current.target, inFlight);
    await this.persist(inFlight);
    let serverConfirmedApply = false;
    try {
      const result = await this.connections.applyMigration(connection.connectionId, plan);
      serverConfirmedApply = true;
      const hasLifecycle = tableChanges.some(({ operations }) =>
        operations.some((operation) => operation.kind === 'createTable' || operation.kind === 'renameTable' || operation.kind === 'dropTable'));
      if (hasLifecycle) {
        await this.refreshAndConfirmTableChanges(connection.connectionId, current);
      }
      const primaryResult = result.tableResults?.find(({ schema, table }) =>
        schema === current.schema && table === current.table);
      const primaryLifecycle = tableChanges[0]?.operations.find((operation) =>
        operation.kind === 'renameTable' || operation.kind === 'dropTable');
      const resultingTable = primaryResult?.resultingTable
        ?? (primaryLifecycle?.kind === 'renameTable' ? primaryLifecycle.newName : current.table);
      const isDropped = primaryResult?.resultingTable === null || primaryLifecycle?.kind === 'dropTable';
      const updated: SchemaRunbook = {
        ...current,
        table: resultingTable,
        baseline: primaryResult?.snapshot ?? (isDropped ? null : result.snapshots[0] ?? current.baseline),
        operations: [],
        tableChanges: [],
        preview: null,
        appliedBatches: [...current.appliedBatches, { statements: result.appliedStatements, appliedAt: new Date().toISOString() }],
        applyOutcomeUnknown: false,
        lastAppliedTableAction: isDropped && tableChanges.length === 1 ? 'dropped' : undefined,
      };
      this.setRunbookForTarget(current.target, updated);
      if (schemaChanged) this.connections.markSchemaChanged(connection.connectionId);
      await this.persist(updated);
    } catch (error) {
      if (!serverConfirmedApply && !isUncertainApplyError(error)) {
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
    const tableChanges = this.tableChangesOf(current);
    const refreshed: SchemaRunbookTableChange[] = [];
    for (const change of tableChanges) {
      let baseline = change.baseline;
      if (connection && baseline) {
        try { baseline = await this.connections.inspectTable(connection.connectionId, change.schema, change.table); }
        catch { /* Keep the stored baseline when the database cannot be reached. */ }
      }
      refreshed.push({ ...change, baseline });
    }
    const updated = {
      ...current,
      baseline: refreshed[0]?.baseline ?? current.baseline,
      operations: [],
      tableChanges: [],
      preview: null,
    };
    this.setRunbookForTarget(current.target, updated);
    this.error.set(null);
    await this.persist(updated);
  }

  /** Reconciles an uncertain apply result by inspecting the actual database state. */
  async resolveUnknownApply(outcome: 'applied' | 'notApplied'): Promise<void> {
    await this.ready;
    if (this.reconciling()) return;
    const current = this.runbook();
    this.reconciling.set(true);
    this.error.set(null);
    try {
      await this.reconcileUnknownApply(outcome);
      const connection = current ? this.matchingConnection(current.target) : null;
      if (outcome === 'applied' && connection && current && this.hasSchemaChanges(this.tableChangesOf(current))) {
        this.connections.markSchemaChanged(connection.connectionId);
      }
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
    const tableChanges = this.tableChangesOf(current);
    if (tableChanges.length > 1) {
      await this.reconcileUnknownBatch(current, tableChanges, outcome);
      return;
    }
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
        await this.refreshAndConfirmTableChanges(connection.connectionId, current);
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

    const tableOperation = current.operations.find((operation) =>
      operation.kind === 'renameTable' || operation.kind === 'dropTable');
    if (tableOperation?.kind === 'renameTable' || tableOperation?.kind === 'dropTable') {
      const oldTable = current.table;
      const newTable = tableOperation.kind === 'renameTable' ? tableOperation.newName : null;
      const oldSnapshot = await this.inspectMaybe(connection.connectionId, current.schema, oldTable);
      const newSnapshot = newTable ? await this.inspectMaybe(connection.connectionId, current.schema, newTable) : null;
      if (outcome === 'applied') {
        const applied = tableOperation.kind === 'dropTable' ? oldSnapshot === null : newSnapshot !== null && oldSnapshot === null;
        if (!applied) throw new Error('The database does not match the expected table rename/drop result. Keep the outcome unknown and inspect it manually.');
        await this.refreshAndConfirmTableChanges(connection.connectionId, current);
        const updated: SchemaRunbook = {
          ...current, table: newTable ?? oldTable, baseline: tableOperation.kind === 'renameTable' ? newSnapshot : null,
          operations: [], preview: null,
          appliedBatches: [...current.appliedBatches, { statements: current.preview.statements, appliedAt: new Date().toISOString() }],
          applyOutcomeUnknown: false, lastAppliedTableAction: tableOperation.kind === 'dropTable' ? 'dropped' : undefined,
        };
        this.setRunbookForTarget(current.target, updated);
        this.error.set(null);
        await this.persist(updated);
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

  /** Confirms every plan in a cross-table transaction before clearing its pending state. */
  private async reconcileUnknownBatch(
    current: SchemaRunbook,
    changes: SchemaRunbookTableChange[],
    outcome: 'applied' | 'notApplied',
  ): Promise<void> {
    const connection = this.matchingConnection(current.target);
    if (!connection) throw new Error('Reconnect to the runbook target before reconciling the batch.');
    for (const change of changes) {
      const lifecycle = change.operations.find((operation) =>
        operation.kind === 'createTable' || operation.kind === 'renameTable' || operation.kind === 'dropTable');
      const expectedName = lifecycle?.kind === 'createTable' ? lifecycle.table
        : lifecycle?.kind === 'renameTable' ? lifecycle.newName
          : change.table;
      const original = await this.inspectMaybe(connection.connectionId, change.schema, change.table);
      const resulting = expectedName === change.table
        ? original
        : await this.inspectMaybe(connection.connectionId, change.schema, expectedName);
      if (outcome === 'applied') {
        if (lifecycle?.kind === 'dropTable') {
          if (original) throw new Error(`The database still contains ${change.schema}.${change.table}; keep the batch outcome unknown.`);
        } else {
          if (!resulting || !change.operations.every((operation) => operationMatchesSnapshot(resulting, operation))) {
            throw new Error(`The database does not match every expected change for ${change.schema}.${expectedName}; keep the batch outcome unknown.`);
          }
        }
      } else {
        if (change.baseline === null) {
          if (resulting) throw new Error(`The database contains ${change.schema}.${expectedName}; this batch cannot be marked unapplied.`);
        } else if (!original || original.fingerprint !== change.baseline.fingerprint
          || (expectedName !== change.table && resulting)) {
          throw new Error(`The original state of ${change.schema}.${change.table} is not intact; this batch cannot be marked unapplied.`);
        }
      }
    }
    if (outcome === 'applied' && changes.some(({ operations }) => operations.some((operation) =>
      operation.kind === 'createTable' || operation.kind === 'renameTable' || operation.kind === 'dropTable'))) {
      await this.refreshAndConfirmTableChanges(connection.connectionId, current);
    }
    const updated = outcome === 'applied'
      ? { ...current, operations: [], tableChanges: [], preview: null,
        appliedBatches: [...current.appliedBatches, { statements: current.preview!.statements, appliedAt: new Date().toISOString() }],
        applyOutcomeUnknown: false }
      : { ...current, applyOutcomeUnknown: false };
    this.setRunbookForTarget(current.target, updated);
    this.error.set(null);
    await this.persist(updated);
  }

  /** Refreshes database resources and verifies the visible result of table lifecycle operations. */
  private async refreshAndConfirmTableChanges(connectionId: string, runbook: SchemaRunbook): Promise<void> {
    const resources = await this.connections.refreshResources(connectionId);
    const hasResource = (schema: string, table: string): boolean =>
      resources.some((resource) => resource.schema === schema && resource.name === table);
    for (const change of this.tableChangesOf(runbook)) {
      const operation = change.operations.find((candidate) => candidate.kind === 'renameTable' || candidate.kind === 'dropTable');
      if (change.baseline === null) {
        const missingTables = change.operations
          .filter((candidate) => candidate.kind === 'createTable' && !hasResource(change.schema, candidate.table))
          .map((candidate) => candidate.kind === 'createTable' ? candidate.table : '');
        if (missingTables.length) {
          throw new Error(`The database accepted the create, but the refreshed table list does not contain ${missingTables.join(', ')}. The runbook outcome remains unknown until the resource list confirms the changes.`);
        }
      } else if (operation?.kind === 'dropTable' && hasResource(change.schema, change.table)) {
        throw new Error(`The database accepted the drop, but the refreshed table list still contains ${change.schema}.${change.table}. The runbook outcome remains unknown until the resource list confirms its removal.`);
      } else if (operation?.kind === 'renameTable'
        && (hasResource(change.schema, change.table) || !hasResource(change.schema, operation.newName))) {
        throw new Error(`The database accepted the rename, but the refreshed table list does not confirm ${change.schema}.${operation.newName}. The runbook outcome remains unknown until the resource list confirms the change.`);
      }
    }
  }

  /** Returns persisted per-table plans, upgrading older single-table state in memory. */
  private tableChangesOf(runbook: SchemaRunbook): SchemaRunbookTableChange[] {
    return runbook.tableChanges ?? (runbook.operations.length
      ? [{ schema: runbook.schema, table: runbook.table, baseline: runbook.baseline, operations: runbook.operations }]
      : []);
  }

  /** Keeps data runbooks single-table and prevents row staging from overwriting schema plans. */
  private assertDataOperationCanBeStaged(current: SchemaRunbook | null, schema: string, table: string): void {
    if (!current) return;
    const changes = this.tableChangesOf(current);
    if (changes.some((change) => change.schema !== schema || change.table !== table
      || change.operations.some((operation) => !isDataOperation(operation)))) {
      throw new Error('Apply or discard the pending schema changes before staging data row edits. Data runbooks support one table at a time.');
    }
  }

  /** Replaces one table's pending operations, removing its plan when nothing remains. */
  private replaceTableChange(
    changes: SchemaRunbookTableChange[],
    replacement: SchemaRunbookTableChange,
  ): SchemaRunbookTableChange[] {
    const existingIndex = changes.findIndex(({ schema, table }) =>
      schema === replacement.schema && table === replacement.table);
    const next = [...changes];
    if (replacement.operations.length) {
      if (existingIndex >= 0) next[existingIndex] = replacement;
      else next.push(replacement);
    } else if (existingIndex >= 0) {
      next.splice(existingIndex, 1);
    }
    return next;
  }

  /** Builds a runbook record while retaining the legacy primary-table fields for existing UI. */
  private runbookWithTableChanges(
    current: SchemaRunbook | null,
    target: ConnectionTarget,
    changes: SchemaRunbookTableChange[],
    preview: MigrationPreviewResponse | null,
  ): SchemaRunbook {
    const primary = changes[0];
    return {
      ...(current ?? { target, schema: primary?.schema ?? '', table: primary?.table ?? '', baseline: null,
        operations: [], appliedBatches: [], applyOutcomeUnknown: false }),
      target,
      schema: primary?.schema ?? current?.schema ?? '',
      table: primary?.table ?? current?.table ?? '',
      baseline: primary ? primary.baseline : current?.baseline ?? null,
      operations: primary?.operations ?? [],
      tableChanges: changes,
      preview,
      applyOutcomeUnknown: false,
    };
  }

  /** Requests one combined preview; the PostgreSQL adapter orders cross-table DDL dependencies. */
  private async previewTableChanges(
    connectionId: string,
    changes: SchemaRunbookTableChange[],
  ): Promise<MigrationPreviewResponse | null> {
    if (!changes.length) return null;
    const tablePlans: MigrationTablePlan[] = changes.map(({ schema, table, baseline, operations }) => ({
      schema,
      table,
      baselineFingerprint: baseline?.fingerprint ?? null,
      operations,
    }));
    const first = tablePlans[0]!;
    return this.connections.previewMigration(connectionId, {
      ...first,
      ...(tablePlans.length > 1 ? { tablePlans } : {}),
    });
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

  /** Detects schema operations so successful row-only runs do not reload diagram metadata. */
  private hasSchemaChanges(tableChanges: SchemaRunbookTableChange[]): boolean {
    return tableChanges.some(({ operations }) => operations.some((operation) => !isDataOperation(operation)));
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

/** Creates a stable identity for a composite primary key independent of object property order. */
function rowKeyIdentity(key: Record<string, string | null>): string {
  return JSON.stringify(Object.entries(key).sort(([a], [b]) => a.localeCompare(b)));
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
  const normalizeOperations = (operations: SchemaOperation[], table: string): SchemaOperation[] => operations.map((operation) => {
    if (operation.kind !== 'createTable') return operation;
    const legacy = operation as typeof operation & { table?: string; ifNotExists?: boolean };
    return {
      ...operation,
      table: legacy.table ?? table,
      ifNotExists: legacy.ifNotExists ?? false,
    };
  });
  return {
    ...runbook,
    operations: normalizeOperations(runbook.operations, runbook.table),
    tableChanges: runbook.tableChanges?.map((change) => ({
      ...change,
      operations: normalizeOperations(change.operations, change.table),
    })),
  };
}

/** Converts errors into a stable message for the runbook notice area. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'The runbook request failed.';
}

/** Identifies row operations so schema and data batches cannot overwrite each other. */
function isDataOperation(operation: SchemaOperation): boolean {
  return operation.kind === 'updateDataRow' || operation.kind === 'insertDataRow' || operation.kind === 'deleteDataRow';
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
