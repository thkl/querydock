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
} from '@thkl/agrid';
import { ConnectionApiService } from '../connections/connection-api.service';
import { WorkspaceHomeComponent } from '../workspace-home/workspace-home.component';
import { WorkspacePagesService } from '../workspace-pages.service';

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
  readonly connections = inject(ConnectionApiService);
  readonly routeState = toSignal(
    combineLatest([this.route.paramMap, this.route.queryParamMap]),
    { initialValue: [this.route.snapshot.paramMap, this.route.snapshot.queryParamMap] as const },
  );
  readonly error = signal<string | null>(null);
  readonly loaded = signal(false);
  readonly totalRows = signal(0);
  private id = signal<string | null>(null);
  private requestVersion = 0;
  private lastGridCriteria = '';
  private currentColumns: TableDataQueryResponse['columns'] = [];
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

  /** Creates a read-only grid with aGrid's native server paging and query controls. */
  private createGridState(): {
    datasource: AgridDataSource<TableDataRow>;
    provider: AgridProvider<TableDataRow>;
  } {
    const datasource = new AgridDataSource<TableDataRow>([]);

    const provider = new AgridProvider<TableDataRow>({
      datasource,
      control: this.gridControl,
      columns: [],
      readonly: true,
      serverSideFiltering: true,
      enableQuickFilter: true,
      showFilterPanel: true,
      showSidebar: true,
      hideGridStatusBar: false,
      allowAddRows: false,
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
      this.gridControl.setTotalRows(result.totalRows);
      if (!sameColumns(this.currentColumns, result.columns)) {
        this.currentColumns = result.columns;
        const columns: ColDef<TableDataRow>[] = result.columns.map((column) => ({
          field: column.name,
          header: column.name,
          type: 'text',
          editable: false,
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
    column.name === right[index]?.name && column.dataType === right[index]?.dataType);
}
