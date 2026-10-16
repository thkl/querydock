import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { combineLatest } from 'rxjs';
import type { TableDataQueryRequest, TableDataQueryResponse } from '@querydock/contracts';
import {
  AgridComponent,
  AgridControl,
  AgridProvider,
  AgridServerSideRowModel,
  type AgridServerSideRequest,
  type ColDef,
  type ColumnFilter,
} from '@thkl/agrid';
import { ConnectionApiService } from '../connections/connection-api.service';
import { WorkspacePagesService } from '../workspace-pages.service';

type TableDataRow = Record<string, string | null>;
type TableDataFilter = TableDataQueryRequest['filters'][number];

@Component({
  selector: 'qd-table-data',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AgridComponent],
  templateUrl: './table-data.component.html',
  styleUrl: './table-data.component.css',
})
export class TableDataComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly workspacePages = inject(WorkspacePagesService);
  readonly connections = inject(ConnectionApiService);
  readonly routeState = toSignal(
    combineLatest([this.route.paramMap, this.route.queryParamMap]),
    { initialValue: [this.route.snapshot.paramMap, this.route.snapshot.queryParamMap] as const },
  );
  readonly error = signal<string | null>(null);
  readonly loaded = signal(false);
  private id = signal<string | null>(null);
  private requestVersion = 0;
  private currentColumns: TableDataQueryResponse['columns'] = [];
  private gridState = this.createGridState();
  readonly provider = signal(this.gridState.provider);
  readonly gridControl = new AgridControl({ allowRowReorder: false, pageSize: 20 });

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
      this.currentColumns = [];
      this.gridState = this.createGridState();
      this.provider.set(this.gridState.provider);
      console.log(`Loading ${schema}.${table}`)
      if (!connection || !table || !connection.capabilities.browseData) return;
      this.workspacePages.registerOpenedTableData(connection.connectionId, schema, table);
    });
  }

  /** Reloads the current server-side grid page and clears the previous error notice. */
  refresh(): void {
    this.error.set(null);
    this.gridState.rowModel.refresh({ purge: true });
  }

  /** Creates a read-only paged grid provider bound to the current route and connection. */
  private createGridState(): {
    rowModel: AgridServerSideRowModel<TableDataRow>;
    provider: AgridProvider<TableDataRow>;
  } {
    const rowModel = new AgridServerSideRowModel<TableDataRow>({
      blockSize: 50,
      maxBlocksInCache: 4,
      datasource: { getRows: (request) => this.loadRows(request) },
    });

    const provider = new AgridProvider<TableDataRow>({
      serverSideRowModel: rowModel,
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
    return { rowModel, provider };
  }

  /** Loads a requested page, maps filters, and ignores stale responses after navigation. */
  private async loadRows(request: AgridServerSideRequest) {
    const [params, query] = this.routeState();
    const connection = this.connections.activeConnection();
    const table = params.get('tableName');
    const schema = query.get('schema') ?? 'public';
    if (!connection || !table || !connection.capabilities.browseData) return { rows: [], rowCount: 0 };
    const version = this.requestVersion;
    const queryRequest: TableDataQueryRequest = {
      offset: request.startRow,
      limit: Math.min(100, Math.max(1, request.endRow - request.startRow)),
      sort: request.sort.map(({ field, direction }) => ({ field, direction })),
      filters: mapFilters(request.filters),
      quickFilter: request.quickFilter,
    };
    try {
      const result = await this.connections.queryTableData(connection.connectionId, schema, table, queryRequest);
      if (version !== this.requestVersion) return { rows: [], rowCount: 0 };
      if (!sameColumns(this.currentColumns, result.columns)) {
        this.currentColumns = result.columns;
        const columns: ColDef<TableDataRow>[] = result.columns.map((column) => ({
          field: column.name,
          header: column.name,
          type: 'text',
          editable: false,
          width: column.name.length > 18 ? 190 : 150,
        }));
        this.gridState.provider.columns.set(columns);
      }
      this.error.set(null);
      this.loaded.set(true);
      return { rows: result.rows, rowCount: result.totalRows };
    } catch (error) {
      if (version === this.requestVersion) {
        this.error.set(error instanceof Error ? error.message : 'Unable to load rows from this table.');
      }
      throw error;
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
