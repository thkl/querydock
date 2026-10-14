import { computed, Injectable, inject, signal } from '@angular/core';
import type {
  ConnectResponse,
  ConnectionTarget,
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
  baseline: TableSnapshot;
  operations: SchemaOperation[];
  preview: MigrationPreviewResponse | null;
  appliedBatches: { statements: string[]; appliedAt: string }[];
  applyOutcomeUnknown: boolean;
}

const DATABASE_NAME = 'querydock-browser-state';
const STORE_NAME = 'runbooks';
const ACTIVE_RUNBOOK_KEY = 'active';

@Injectable({ providedIn: 'root' })
export class RunbookService {
  private readonly connections = inject(ConnectionApiService);
  private databasePromise?: Promise<IDBDatabase>;

  readonly runbook = signal<SchemaRunbook | null>(null);
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

  async stageSchemaFieldDraft(
    connection: ConnectResponse,
    snapshot: TableSnapshot,
    draft: SchemaFieldDraftRequest['draft'],
    replacementName: string | null = null,
  ): Promise<void> {
    await this.ready;
    this.error.set(null);
    const current = this.runbook();
    if (current?.applyOutcomeUnknown) {
      throw new Error('The previous Apply outcome is unknown. Inspect the database before staging or applying more changes.');
    }
    if (current && (!sameTarget(current.target, connection.target)
      || current.schema !== snapshot.schema || current.table !== snapshot.name)) {
      throw new Error('The open runbook belongs to another database or table. Export any applied SQL, then clear it before starting a different runbook.');
    }

    const baseline = current?.baseline ?? snapshot;
    const key = draft.sourceName ?? replacementName ?? draft.name;
    const matches = (candidate: SchemaOperation): boolean => candidate.name === key;
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
          this.runbook.set(updated);
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
      this.runbook.set(runbook);
      await this.persist(runbook);
    } catch (error) {
      this.error.set(messageOf(error));
      throw error;
    } finally {
      this.previewing.set(false);
    }
  }

  async stageSchemaOperation(
    connection: ConnectResponse,
    snapshot: TableSnapshot,
    operation: Extract<SchemaOperation, { kind: 'addConstraint' | 'dropConstraint' }> | null,
    replacementName: string,
  ): Promise<void> {
    await this.ready;
    this.error.set(null);
    const current = this.runbook();
    if (current?.applyOutcomeUnknown) {
      throw new Error('The previous Apply outcome is unknown. Inspect the database before staging or applying more changes.');
    }
    if (current && (!sameTarget(current.target, connection.target)
      || current.schema !== snapshot.schema || current.table !== snapshot.name)) {
      throw new Error('The open runbook belongs to another database or table. Export any applied SQL, then clear it before starting a different runbook.');
    }

    const baseline = current?.baseline ?? snapshot;
    const retained = (current?.operations ?? []).filter((candidate) =>
      !(candidate.kind === 'addConstraint' || candidate.kind === 'dropConstraint') || candidate.name !== replacementName);
    const operations = operation ? [...retained, operation] : retained;
    if (!operations.length) {
      if (current) {
        const updated = { ...current, operations: [], preview: null };
        this.runbook.set(updated);
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
      this.runbook.set(runbook);
      await this.persist(runbook);
    } catch (error) {
      this.error.set(messageOf(error));
      throw error;
    } finally {
      this.previewing.set(false);
    }
  }

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
      baselineFingerprint: current.baseline.fingerprint,
      operations: current.operations,
      reviewedStatements: current.preview.statements,
      acknowledgedWarnings,
    };
    this.applying.set(true);
    this.error.set(null);
    const inFlight = { ...current, applyOutcomeUnknown: true };
    this.runbook.set(inFlight);
    await this.persist(inFlight);
    try {
      const result = await this.connections.applyMigration(connection.connectionId, plan);
      const updated: SchemaRunbook = {
        ...current,
        baseline: result.snapshot,
        operations: [],
        preview: null,
        appliedBatches: [...current.appliedBatches, { statements: result.appliedStatements, appliedAt: new Date().toISOString() }],
        applyOutcomeUnknown: false,
      };
      this.runbook.set(updated);
      await this.persist(updated);
    } catch (error) {
      if (!isUncertainApplyError(error)) {
        this.runbook.set(current);
        await this.persist(current);
      }
      this.error.set(messageOf(error));
      throw error;
    } finally {
      this.applying.set(false);
    }
  }

  async discardPending(): Promise<void> {
    await this.ready;
    const current = this.runbook();
    if (!current || current.applyOutcomeUnknown) return;
    const connection = this.matchingConnection(current.target);
    let baseline = current.baseline;
    if (connection) {
      try {
        baseline = await this.connections.inspectTable(connection.connectionId, current.schema, current.table);
      } catch {
        // Keep the stored baseline if the database cannot be reached right now.
      }
    }
    const updated = { ...current, baseline, operations: [], preview: null };
    this.runbook.set(updated);
    this.error.set(null);
    await this.persist(updated);
  }

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

  private async reconcileUnknownApply(outcome: 'applied' | 'notApplied'): Promise<void> {
    const current = this.runbook();
    if (!current?.applyOutcomeUnknown || !current.preview) return;
    const connection = this.matchingConnection(current.target);
    if (!connection) throw new Error('Reconnect to the runbook target before reconciling the batch.');

    const snapshot = await this.connections.inspectTable(connection.connectionId, current.schema, current.table);
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
      this.runbook.set(updated);
      this.error.set(null);
      await this.persist(updated);
      return;
    }

    if (snapshot.fingerprint !== current.baseline.fingerprint) {
      throw new Error('The table no longer matches the original baseline, so this batch cannot be safely marked unapplied. Inspect and reconcile the schema manually.');
    }
    const updated = { ...current, applyOutcomeUnknown: false };
    this.runbook.set(updated);
    this.error.set(null);
    await this.persist(updated);
  }

  async clearRunbook(): Promise<void> {
    await this.ready;
    if (this.runbook()?.applyOutcomeUnknown) {
      this.error.set('Reconcile the unknown batch before clearing this runbook.');
      return;
    }
    this.runbook.set(null);
    this.error.set(null);
    try {
      const database = await this.openDatabase();
      await transactionRequest(database, (store) => store.delete(ACTIVE_RUNBOOK_KEY));
    } catch {
      this.storageAvailable.set(false);
    }
  }

  reportError(error: unknown): void {
    this.error.set(messageOf(error));
  }

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

  private matchingConnection(target: ConnectionTarget): ConnectResponse | undefined {
    return this.connections.connections().find((connection) => sameTarget(connection.target, target));
  }

  private async restore(): Promise<void> {
    try {
      const database = await this.openDatabase();
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const result = await requestResult<SchemaRunbook | undefined>(transaction.objectStore(STORE_NAME).get(ACTIVE_RUNBOOK_KEY));
      this.runbook.set(result ?? null);
    } catch {
      this.storageAvailable.set(false);
    }
  }

  private async persist(runbook: SchemaRunbook): Promise<void> {
    try {
      const database = await this.openDatabase();
      await transactionRequest(database, (store) => store.put(runbook, ACTIVE_RUNBOOK_KEY));
      this.storageAvailable.set(true);
    } catch {
      this.storageAvailable.set(false);
    }
  }

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

function sameTarget(left: ConnectionTarget, right: ConnectionTarget): boolean {
  return left.adapter === right.adapter && left.host === right.host && left.port === right.port
    && left.database === right.database && left.username === right.username;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'The runbook request failed.';
}

function isUncertainApplyError(error: unknown): boolean {
  return !(error instanceof ApiRequestError) || error.status === null || error.status >= 500;
}

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
    ? field.nullable
    : operation.nullable === undefined || field.nullable === operation.nullable;
  return typeMatches && (field.defaultExpression?.trim() ?? null) === defaultExpression && nullableMatches;
}

function operationMatchesSnapshot(snapshot: TableSnapshot, operation: SchemaOperation): boolean {
  if (operation.kind === 'addNullableField' || operation.kind === 'alterField') {
    const name = operation.kind === 'alterField' ? operation.newName : operation.name;
    const field = snapshot.fields.find((candidate) => candidate.name === name);
    return field !== undefined && operationMatchesField(field, operation);
  }
  const constraint = snapshot.constraints.find((candidate) => candidate.name === operation.name);
  if (operation.kind === 'dropConstraint') return constraint === undefined;
  if (!constraint || constraint.kind !== operation.constraintKind) return false;
  if (operation.constraintKind === 'check') {
    const normalize = (value: string) => value.replace(/^CHECK\s*/i, '').replaceAll('"', '')
      .replace(/[\s()]/g, '').toLowerCase();
    return normalize(constraint.definition) === normalize(operation.expression);
  }
  return constraint.fieldNames.length === operation.fieldNames.length
    && constraint.fieldNames.every((name, index) => name === operation.fieldNames[index]);
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

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
