import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { combineLatest } from 'rxjs';
import type { TableDataQueryRequest, TableDataQueryResponse, TableDataRowDelete } from '@querydock/contracts';
import {
  AgridComponent,
  AgridControl,
  AgridDataSource,
  AgridProvider,
  type AgridServerQuery,
  type ColDef,
  type ColumnFilter,
  type NewRecord,
  type RowUpdateEvent,
  type RowRemovedEvent,
} from '@thkl/agrid';
import { ConnectionApiService } from '../connections/connection-api.service';
import { WorkspaceHomeComponent } from '../workspace-home/workspace-home.component';
import { WorkspacePagesService } from '../workspace-pages.service';
import { RunbookService } from '../runbook/runbook.service';

type TableDataRow = Record<string, string | null>;
type TableDataFilter = TableDataQueryRequest['filters'][number];
const PAGE_SIZE = 50;

@Component({
  selector: 'qd-table-data',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AgridComponent, WorkspaceHomeComponent],
  templateUrl: './table-data.component.html',
  styleUrl: './table-data.component.css',
})
export class TableDataComponent {
  private readonly dataGrid = viewChild<AgridComponent<TableDataRow>>(AgridComponent);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly workspacePages = inject(WorkspacePagesService);
  private readonly runbook = inject(RunbookService);
  readonly connections = inject(ConnectionApiService);
  readonly routeState = toSignal(
    combineLatest([this.route.paramMap, this.route.queryParamMap]),
    { initialValue: [this.route.snapshot.paramMap, this.route.snapshot.queryParamMap] as const },
  );
  readonly error = signal<string | null>(null);
  readonly loaded = signal(false);
  readonly totalRows = signal(0);
  readonly saveChangesToRunbook = signal(false);
  readonly canUpdateRows = signal(false);
  readonly canInsertRows = signal(false);
  readonly canDeleteRows = signal(false);
  readonly pendingDeleteKeys = computed(() => {
    const [params, query] = this.routeState();
    const connection = this.connections.activeConnection();
    const table = params.get('tableName');
    return connection && table
      ? this.runbook.pendingDeletedRowIdentities(connection, query.get('schema') ?? 'public', table)
      : new Set<string>();
  });
  readonly pendingDeleteCount = computed(() => {
    return this.pendingDeleteKeys().size;
  });
  readonly pendingInsertCount = computed(() => {
    const [params, query] = this.routeState();
    const connection = this.connections.activeConnection();
    const table = params.get('tableName');
    return connection && table
      ? this.runbook.pendingDataRowInserts(connection, query.get('schema') ?? 'public', table).length
      : 0;
  });
  readonly pendingUpdateKeys = computed(() => {
    const [params, query] = this.routeState();
    const connection = this.connections.activeConnection();
    const table = params.get('tableName');
    return connection && table
      ? new Set(this.runbook.pendingDataRowUpdates(connection, query.get('schema') ?? 'public', table)
        .map(({ key }) => rowIdentity(Object.keys(key), key)))
      : new Set<string>();
  });
  readonly pendingUpdateCount = computed(() => this.pendingUpdateKeys().size);
  private id = signal<string | null>(null);
  private readonly gridControlStates = new Map<string, ReturnType<AgridControl['toJSON']>>();
  private requestVersion = 0;
  private lastGridCriteria = '';
  private currentColumns: TableDataQueryResponse['columns'] = [];
  private keyFields: string[] = [];
  private rowVersions: string[] = [];
  private originalRows: TableDataRow[] = [];
  private newRows = new Map<number, { draftId: string; baseline: TableDataRow; stagedValues?: Record<string, string | null> }>();
  gridControl = new AgridControl({ allowRowReorder: false, pageSize: PAGE_SIZE });
  private gridState = this.createGridState();
  readonly provider = signal(this.gridState.provider);

  /** Rebuilds the table data provider for route/connection changes and registers its tab. */
  constructor() {
    effect(() => {
      const [params, query] = this.routeState();
      const connection = this.connections.activeConnection();
      const table = params.get('tableName');
      const schema = query.get('schema') ?? 'public';
      const previousPageId = this.id();
      if (previousPageId) this.gridControlStates.set(previousPageId, this.gridControl.toJSON());
      const pageId = connection && table ? JSON.stringify([connection.connectionId, schema, table]) : null;
      this.requestVersion += 1;
      this.id.set(pageId);
      this.gridControl = new AgridControl(this.gridControlStates.get(pageId ?? '')
        ?? { allowRowReorder: false, pageSize: PAGE_SIZE });
      this.error.set(null);
      this.loaded.set(false);
      this.totalRows.set(0);
      this.lastGridCriteria = '';
      this.currentColumns = [];
      this.keyFields = [];
      this.rowVersions = [];
      this.originalRows = [];
      this.canUpdateRows.set(false);
      this.canInsertRows.set(false);
      this.canDeleteRows.set(false);
      this.newRows.clear();
      this.saveChangesToRunbook.set(connection && table
        ? untracked(() => this.workspacePages.saveDataChangesToRunbook(connection.connectionId, schema, table))
        : false);
      this.gridControl.setPage(1);
      this.gridState = this.createGridState();
      this.provider.set(this.gridState.provider);
      if (!connection) {
        if (this.connections.sessionRestoreComplete()) void this.router.navigateByUrl('/');
        return;
      }
      if (!table || !connection.capabilities.browseData) return;
      untracked(() => this.workspacePages.registerOpenedTableData(connection.connectionId, schema, table));
    });
    effect(() => {
      const gridProvider = this.provider();
      const query = gridProvider.serverQuery();
      if (!query) return;
      void this.loadRows(query, gridProvider);
    });
  }

  /** Reloads the current aGrid query without changing its page or filter state. */
  refresh(): void {
    const gridProvider = this.provider();
    const query = gridProvider.serverQuery();
    if (!query) return;
    this.error.set(null);
    this.loaded.set(false);
    void this.loadRows(query, gridProvider);
  }

  /** Keeps the Runbook toggle with this workspace page while its route component is replaced. */
  setSaveChangesToRunbook(enabled: boolean): void {
    this.saveChangesToRunbook.set(enabled);
    const [params, query] = this.routeState();
    const connection = this.connections.activeConnection();
    const table = params.get('tableName');
    if (connection && table) {
      this.workspacePages.setSaveDataChangesToRunbook(
        connection.connectionId,
        query.get('schema') ?? 'public',
        table,
        enabled,
      );
    }
  }

  /** Opens the Runbook so staged data changes can be reviewed or discarded. */
  openRunbook(): void {
    void this.router.navigateByUrl('/runbook');
  }

  /** Creates a row-editable grid; provider events still save only after a row is completed. */
  private createGridState(): {
    datasource: AgridDataSource<TableDataRow>;
    provider: AgridProvider<TableDataRow>;
  } {
    const datasource = new AgridDataSource<TableDataRow>([]);
    return { datasource, provider: this.createProvider(datasource, [], false) };
  }

  /** Creates a provider from the current table permissions so aGrid derives its controls correctly. */
  private createProvider(
    datasource: AgridDataSource<TableDataRow>,
    columns: ColDef<TableDataRow>[],
    allowAddRows: boolean,
  ): AgridProvider<TableDataRow> {
    return new AgridProvider<TableDataRow>({
      datasource,
      control: this.gridControl,
      columns,
      readonly: false,
      serverSideFiltering: true,
      enableQuickFilter: true,
      showFilterPanel: true,
      showSidebar: true,
      hideGridStatusBar: false,
      allowAddRows,
      confirmRowDelete: true,
      getRowClass: ({ row, index }) => {
        if (this.newRows.has(index)) return 'row-pending-insert';
        const identity = rowIdentity(this.keyFields, row);
        if (this.pendingDeleteKeys().has(identity)) return 'row-pending-delete';
        return this.pendingUpdateKeys().has(identity) ? 'row-pending-update' : '';
      },
      getCellMenuItems: () => this.canDeleteRows() && this.gridControl.readonly()
        ? [{
          label: 'Delete row',
          danger: true,
          action: ({ originalIndex }) => this.dataGrid()?.deleteRow(originalIndex),
        }]
        : [],
      showChangedCellIndicator: true,
      zebraStripes: true,
      rowSelection: 'single',
      gridId: `query_data_v2_${this.id()}`,
      showRowNumbers: true,
      enableColumnMarking: false,
      resizableSidebar: true,
      emptyText: 'This table has no rows. The column headers are still available for filtering and sorting.',
    });
  }

  /** Loads the page and query criteria emitted by aGrid, discarding stale responses. */
  private async loadRows(request: AgridServerQuery, gridProvider: AgridProvider<TableDataRow>): Promise<void> {
    const [params, query] = this.routeState();
    const connection = this.connections.activeConnection();
    const table = params.get('tableName');
    const schema = query.get('schema') ?? 'public';
    if (!connection || !table || !connection.capabilities.browseData) return;
    const criteria = JSON.stringify({ sort: request.sort, filters: request.filters, quickFilter: request.quickFilter });
    if (this.lastGridCriteria && this.lastGridCriteria !== criteria && request.startRow > 0) {
      this.lastGridCriteria = criteria;
      this.gridControl.setPage(1);
      return;
    }
    this.lastGridCriteria = criteria;
    const version = ++this.requestVersion;
    const queryRequest: TableDataQueryRequest = {
      offset: Math.max(0, request.startRow),
      limit: Math.min(100, Math.max(1, request.pageSize || PAGE_SIZE)),
      sort: request.sort.map(({ field, direction }) => ({ field, direction })),
      filters: mapFilters(request.filters),
      quickFilter: request.quickFilter,
    };
    try {
      await this.runbook.ready;
      const result = await this.connections.queryTableData(connection.connectionId, schema, table, queryRequest);
      if (version !== this.requestVersion) return;
      this.totalRows.set(result.totalRows);
      this.keyFields = result.keyFields;
      this.rowVersions = [...result.rowVersions];
      this.originalRows = result.rows.map((row) => ({ ...row }));
      this.newRows.clear();
      const stagedUpdates = this.runbook.pendingDataRowUpdates(connection, schema, table);
      const updatesByIdentity = new Map(stagedUpdates.map((update) => [rowIdentity(result.keyFields, update.key), update.changes]));
      const displayedRows = result.rows.map((row) => ({
        ...row,
        ...(updatesByIdentity.get(rowIdentity(result.keyFields, row)) ?? {}),
      }));
      const stagedInserts = this.runbook.pendingDataRowInserts(connection, schema, table);
      const restoredDrafts = stagedInserts.map(({ draftId, values }) => {
        const baseline = Object.fromEntries(result.columns.map(({ name }) => [name, null])) as TableDataRow;
        return { row: { ...baseline, ...values }, draftId, baseline, stagedValues: values };
      });
      restoredDrafts.forEach((draft, index) => this.newRows.set(result.rows.length + index, {
        draftId: draft.draftId,
        baseline: draft.baseline,
        stagedValues: draft.stagedValues,
      }));
      this.gridState.datasource.setData([...displayedRows, ...restoredDrafts.map(({ row }) => row)]);
      this.canUpdateRows.set(result.canUpdateRows);
      this.canInsertRows.set(result.canInsertRows);
      this.canDeleteRows.set(result.canDeleteRows);
      this.gridControl.setTotalRows(this.totalRows());
      const columns: ColDef<TableDataRow>[] = result.columns.map((column) => ({
        field: column.name,
        header: column.name,
        type: 'text',
        editable: column.editable || column.insertable,
        cellReadonly: ({ originalIndex }) => {
          if (this.newRows.has(originalIndex)) return !column.insertable || !this.canInsertRows();
          const row = this.originalRows[originalIndex];
          return !column.editable || !this.canUpdateRows()
            || Boolean(row && this.pendingDeleteKeys().has(rowIdentity(this.keyFields, row)));
        },
        width: column.name.length > 18 ? 190 : 150,
      }));
      if (!sameColumns(this.currentColumns, result.columns)) {
        this.currentColumns = result.columns;
        gridProvider.columns.set(columns);
      }
      if (gridProvider.allowAddRows !== result.canInsertRows) {
        const nextProvider = this.createProvider(this.gridState.datasource, columns, result.canInsertRows);
        this.gridState = { datasource: this.gridState.datasource, provider: nextProvider };
        this.provider.set(nextProvider);
      }
      this.error.set(null);
      this.loaded.set(true);
    } catch (error) {
      if (version === this.requestVersion) {
        this.error.set(error instanceof Error ? error.message : 'Unable to load rows from this table.');
      }
    }
  }

  /** Records the blank row so its editable cells and eventual insert can be permission-gated. */
  prepareAddRow(event: NewRecord<TableDataRow>): void {
    if (!this.canInsertRows()) return;
    this.newRows.set(event.index, {
      draftId: crypto.randomUUID(),
      baseline: { ...event.data },
    });
  }

  /** Persists or stages one fully edited row, never issuing a request for an individual cell. */
  async saveRow(event: RowUpdateEvent<TableDataRow>): Promise<void> {
    const [params, query] = this.routeState();
    const connection = this.connections.activeConnection();
    const table = params.get('tableName');
    const schema = query.get('schema') ?? 'public';
    const newRow = this.newRows.get(event.originalIndex);
    if (newRow) {
      await this.saveNewRow(event, newRow);
      return;
    }
    const baseline = this.originalRows[event.originalIndex];
    const expectedVersion = this.rowVersions[event.originalIndex];
    if (!connection || !table || !baseline || !expectedVersion || !this.keyFields.length) return;
    const changes: Record<string, string | null> = {};
    for (const column of this.currentColumns) {
      if (column.editable && event.row[column.name] !== baseline[column.name]) {
        changes[column.name] = event.row[column.name];
      }
    }
    if (!Object.keys(changes).length) {
      this.gridControl.clearChangedCells(event.originalIndex);
      return;
    }
    const key = Object.fromEntries(this.keyFields.map((field) => [field, baseline[field]]));
    const update = { key, expectedVersion, changes };
    const hasStagedUpdate = this.pendingUpdateKeys().has(rowIdentity(this.keyFields, baseline));
    this.error.set(null);
    try {
      if (this.saveChangesToRunbook() || hasStagedUpdate) {
        await this.runbook.stageDataRowUpdate(connection, schema, table, update);
        this.gridControl.clearChangedCells(event.originalIndex);
        this.error.set(null);
        this.refresh();
        return;
      }
      await this.connections.updateTableDataRow(connection.connectionId, schema, table, update);
      this.gridControl.indicate(event.originalIndex,'var(--color-success)');
      this.gridControl.clearChangedCells(event.originalIndex);
      this.refresh();
    } catch (error) {
      this.gridControl.indicate(event.originalIndex, 'var(--color-danger)');
      this.error.set(error instanceof Error ? error.message : 'Unable to save this row. Refresh the table and try again.');
    }
  }

  /** Deletes a persisted row directly or stages server-generated DELETE SQL in the Runbook. */
  async deleteRow(event: RowRemovedEvent<TableDataRow>): Promise<void> {
    const draft = this.newRows.get(event.index);
    this.shiftDraftRowsAfterDelete(event.index);
    const [params, query] = this.routeState();
    const connection = this.connections.activeConnection();
    const table = params.get('tableName');
    const schema = query.get('schema') ?? 'public';
    if (draft) {
      if (connection && table && draft.stagedValues) {
        try {
          await this.runbook.discardDataRowInsert(connection, schema, table, draft.draftId);
          this.refresh();
        } catch (error) {
          this.error.set(error instanceof Error ? error.message : 'Unable to remove this staged insert from the Runbook.');
          this.refresh();
        }
      }
      return;
    }
    const baseline = this.originalRows[event.index];
    const expectedVersion = this.rowVersions[event.index];
    if (!connection || !table || !this.canDeleteRows() || !baseline || !expectedVersion || !this.keyFields.length) {
      this.refresh();
      this.error.set('This row cannot be deleted with the current database permissions. Refresh the table and try again.');
      return;
    }
    const deletion: TableDataRowDelete = {
      key: Object.fromEntries(this.keyFields.map((field) => [field, event.data[field] ?? baseline[field]])),
      expectedVersion,
    };
    this.error.set(null);
    try {
      if (this.saveChangesToRunbook()) {
        await this.runbook.stageDataRowDelete(connection, schema, table, deletion);
        this.refresh();
        return;
      }
      this.originalRows.splice(event.index, 1);
      this.rowVersions.splice(event.index, 1);
      this.totalRows.update((count) => Math.max(0, count - 1));
      await this.connections.deleteTableDataRow(connection.connectionId, schema, table, deletion);
      this.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to delete this row. Refresh the table and try again.';
      const gridProvider = this.provider();
      const gridQuery = gridProvider.serverQuery();
      if (gridQuery) await this.loadRows(gridQuery, gridProvider);
      this.error.set(message);
    }
  }

  /** Keeps indices for unfinished blank insert rows aligned when aGrid removes a row. */
  private shiftDraftRowsAfterDelete(index: number): void {
    const shifted = new Map<number, { draftId: string; baseline: TableDataRow; stagedValues?: Record<string, string | null> }>();
    for (const [draftIndex, draft] of this.newRows) {
      if (draftIndex < index) shifted.set(draftIndex, draft);
      else if (draftIndex > index) shifted.set(draftIndex - 1, draft);
    }
    this.newRows = shifted;
  }

  /** Saves or stages a completed new row, omitting untouched blank cells so database defaults apply. */
  private async saveNewRow(
    event: RowUpdateEvent<TableDataRow>,
    draft: { draftId: string; baseline: TableDataRow; stagedValues?: Record<string, string | null> },
  ): Promise<void> {
    const [params, query] = this.routeState();
    const connection = this.connections.activeConnection();
    const table = params.get('tableName');
    const schema = query.get('schema') ?? 'public';
    if (!connection || !table || !this.canInsertRows()) return;
    const values: Record<string, string | null> = { ...(draft.stagedValues ?? {}) };
    for (const column of this.currentColumns) {
      if (column.insertable && event.row[column.name] !== draft.baseline[column.name]) {
        values[column.name] = event.row[column.name];
      }
    }
    if (!Object.keys(values).length) {
      this.error.set('Enter a value in at least one insertable field before saving this row.');
      return;
    }
    const insert = { draftId: draft.draftId, values };
    this.error.set(null);
    try {
      if (this.saveChangesToRunbook() || draft.stagedValues) {
        await this.runbook.stageDataRowInsert(connection, schema, table, insert);
        this.newRows.set(event.originalIndex, { ...draft, stagedValues: values });
        this.gridControl.clearChangedCells(event.originalIndex);
        return;
      }
      await this.connections.insertTableDataRow(connection.connectionId, schema, table, insert);
      this.gridControl.clearChangedCells(event.originalIndex);
      this.newRows.delete(event.originalIndex);
      this.refresh();
    } catch (error) {
      this.gridControl.indicate(event.originalIndex, 'var(--color-danger)');
      this.error.set(error instanceof Error ? error.message : 'Unable to add this row. Check the field values and database permissions.');
    }
  }
}

/** Maps grid filter controls into the shared server query filter contract. */
function mapFilters(filters: Readonly<Record<string, ColumnFilter>>): TableDataFilter[] {
  const result: TableDataFilter[] = [];
  for (const [field, filter] of Object.entries(filters)) {
    if (filter.text.trim()) result.push({ field, operator: 'contains', value: filter.text.trim() });
    if (filter.selectedValues?.length) result.push({ field, operator: 'in', values: filter.selectedValues });
    const conditions = filter.conditions?.length
      ? filter.conditions
      : filter.operator && filter.operand !== undefined && filter.operand !== null
        ? [{ operator: filter.operator, operand: filter.operand, operand2: filter.operand2 }]
        : [];
    for (const condition of conditions) {
      if (condition.operator === 'between') {
        if (condition.operand && condition.operand2) {
          result.push({ field, operator: 'between', value: condition.operand, secondValue: condition.operand2 });
        }
        continue;
      }
      const operators: Record<string, TableDataFilter['operator']> = {
        eq: 'eq', neq: 'neq', gt: 'gt', gte: 'gte', lt: 'lt', lte: 'lte',
        like: 'contains', startsWith: 'startsWith', endsWith: 'endsWith',
        includes: 'contains', notIncludes: 'notContains',
      };
      const operator = operators[condition.operator];
      if (operator && condition.operand !== '') result.push({ field, operator, value: condition.operand });
    }
  }
  return result;
}

/** Avoids rebuilding grid columns when a server page returns the same schema. */
function sameColumns(
  left: TableDataQueryResponse['columns'],
  right: TableDataQueryResponse['columns'],
): boolean {
  return left.length === right.length && left.every((column, index) =>
    column.name === right[index]?.name && column.dataType === right[index]?.dataType
    && column.editable === right[index]?.editable
    && column.insertable === right[index]?.insertable);
}

/** Produces the same stable key representation used by staged Runbook row deletes. */
function rowIdentity(fields: string[], row: TableDataRow): string {
  const entries: [string, string | null][] = fields.map((field) => [field, row[field] ?? null]);
  return JSON.stringify(entries.sort(([left], [right]) => left.localeCompare(right)));
}
