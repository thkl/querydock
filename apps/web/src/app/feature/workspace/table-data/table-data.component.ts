import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { combineLatest } from 'rxjs';
import type { TableDataQueryRequest, TableDataQueryResponse } from '@querydock/contracts';
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
  private id = signal<string | null>(null);
  private requestVersion = 0;
  private lastGridCriteria = '';
  private currentColumns: TableDataQueryResponse['columns'] = [];
  private keyFields: string[] = [];
  private rowVersions: string[] = [];
  private originalRows: TableDataRow[] = [];
  private newRows = new Map<number, { draftId: string; baseline: TableDataRow }>();
  readonly gridControl = new AgridControl({ allowRowReorder: false, pageSize: PAGE_SIZE });
  private gridState = this.createGridState();
  readonly provider = signal(this.gridState.provider);

  /** Rebuilds the table data provider for route/connection changes and registers its tab. */
  constructor() {
    effect(() => {
      const [params, query] = this.routeState();
      const connection = this.connections.activeConnection();
      const table = params.get('tableName');
      const schema = query.get('schema') ?? 'public';
      this.requestVersion += 1;
      this.id.set(`${schema}.${table}`);
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
      this.newRows.clear();
      this.saveChangesToRunbook.set(false);
      this.gridControl.setPage(1);
      this.gridState = this.createGridState();
      this.provider.set(this.gridState.provider);
      if (!connection) {
        if (this.connections.sessionRestoreComplete()) void this.router.navigateByUrl('/');
        return;
      }
      if (!table || !connection.capabilities.browseData) return;
      this.workspacePages.registerOpenedTableData(connection.connectionId, schema, table);
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

  /** Creates a row-editable grid; provider events still save only after a row is completed. */
  private createGridState(): {
    datasource: AgridDataSource<TableDataRow>;
    provider: AgridProvider<TableDataRow>;
  } {
    const datasource = new AgridDataSource<TableDataRow>([]);

    const provider = new AgridProvider<TableDataRow>({
      datasource,
      control: this.gridControl,
      columns: [],
      readonly: false,
      serverSideFiltering: true,
      enableQuickFilter: true,
      showFilterPanel: true,
      showSidebar: true,
      hideGridStatusBar: false,
      allowAddRows: false,
      showChangedCellIndicator: true,
      zebraStripes: true,
      rowSelection: 'single',
      gridId: `query_data_${this.id()}`,
      showRowNumbers: true,
      enableColumnMarking: false,
      resizableSidebar: true,
      emptyText: 'This table has no rows. The column headers are still available for filtering and sorting.',
    });
    return { datasource, provider };
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
      const result = await this.connections.queryTableData(connection.connectionId, schema, table, queryRequest);
      if (version !== this.requestVersion) return;
      this.totalRows.set(result.totalRows);
      this.gridState.datasource.setData(result.rows);
      this.keyFields = result.keyFields;
      this.rowVersions = result.rowVersions;
      this.originalRows = result.rows.map((row) => ({ ...row }));
      this.newRows.clear();
      this.canUpdateRows.set(result.canUpdateRows);
      this.canInsertRows.set(result.canInsertRows);
      gridProvider.allowAddRows = result.canInsertRows;
      this.gridControl.setTotalRows(result.totalRows);
      if (!sameColumns(this.currentColumns, result.columns)) {
        this.currentColumns = result.columns;
        const columns: ColDef<TableDataRow>[] = result.columns.map((column) => ({
          field: column.name,
          header: column.name,
          type: 'text',
          editable: column.editable || column.insertable,
          cellReadonly: ({ originalIndex }) => this.newRows.has(originalIndex)
            ? !column.insertable || !this.canInsertRows()
            : !column.editable || !this.canUpdateRows(),
          width: column.name.length > 18 ? 190 : 150,
        }));
        gridProvider.columns.set(columns);
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
    this.error.set(null);
    try {
      if (this.saveChangesToRunbook()) {
        const snapshot = await this.connections.inspectTable(connection.connectionId, schema, table);
        await this.runbook.stageDataRowUpdate(connection, snapshot, update);
        this.gridControl.clearChangedCells(event.originalIndex);
        this.error.set(null);
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

  /** Saves or stages a completed new row, omitting untouched blank cells so database defaults apply. */
  private async saveNewRow(
    event: RowUpdateEvent<TableDataRow>,
    draft: { draftId: string; baseline: TableDataRow },
  ): Promise<void> {
    const [params, query] = this.routeState();
    const connection = this.connections.activeConnection();
    const table = params.get('tableName');
    const schema = query.get('schema') ?? 'public';
    if (!connection || !table || !this.canInsertRows()) return;
    const values: Record<string, string | null> = {};
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
      if (this.saveChangesToRunbook()) {
        const snapshot = await this.connections.inspectTable(connection.connectionId, schema, table);
        await this.runbook.stageDataRowInsert(connection, snapshot, insert);
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
