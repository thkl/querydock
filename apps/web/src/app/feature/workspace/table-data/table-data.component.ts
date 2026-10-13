import { Component, signal } from '@angular/core';
import {
  AgridComponent,
  AgridControl,
  AgridDataSource,
  AgridProvider,
  type AgridServerQuery,
  type ColDef,
  type GridEditEvent,
} from '@thkl/agrid';
import { RouterLink } from '@angular/router';
import { WorkspaceDraftsService } from '../workspace-drafts.service';
import { customerFields, sampleCustomers, type CustomerRow } from './data/customer.sample';
import { StatusCellEditorComponent } from './cell-editor/status-cell-editor.component';

const initialQuery: AgridServerQuery = {
  filters: {}, sort: [], quickFilter: '', page: 1, pageSize: 12, startRow: 0, endRow: 11,
};

@Component({
  selector: 'qd-table-data',
  standalone: true,
  imports: [AgridComponent, RouterLink],
  templateUrl: './table-data.component.html',
  styleUrl: './table-data.component.css',
})
export class TableDataComponent {
  readonly pendingChanges = this.drafts.pendingCellEdits;
  readonly loadedRows = signal(0);
  readonly totalRows = signal(sampleCustomers.length);
  readonly requestedRange = signal('Requesting rows 1–12');
  readonly datasource = new AgridDataSource<CustomerRow>([]);
  readonly gridControl = new AgridControl({ pageSize: 12 });
  readonly gridProvider = new AgridProvider<CustomerRow>({
    columns: this.makeColumns(),
    datasource: this.datasource,
    control: this.gridControl,
    serverSideFiltering: true,
    enableQuickFilter: true,
    sortOption: 'single',
    showChangedCellIndicator: true
  });
  private lastQuery = initialQuery;

  constructor(private readonly drafts: WorkspaceDraftsService) {
    this.loadRows(initialQuery);
  }

  onCellEdit(event: GridEditEvent<CustomerRow>): void {
    this.drafts.recordCellEdit(event);
  }

  loadRows(query: AgridServerQuery): void {
    this.lastQuery = query;
    let rows = sampleCustomers.filter((row) => {
      const record = row as unknown as Record<string, unknown>;
      const searchText = query.quickFilter.trim().toLocaleLowerCase();
      if (searchText && !Object.values(record).some((value) => String(value).toLocaleLowerCase().includes(searchText))) {
        return false;
      }

      return Object.entries(query.filters).every(([field, filter]) => {
        const value = String(record[field] ?? '');
        const fieldText = filter.text.trim().toLocaleLowerCase();
        if (fieldText && !value.toLocaleLowerCase().includes(fieldText)) return false;
        return filter.selectedValues === null || filter.selectedValues.includes(value);
      });
    });

    const sort = query.sort[0];
    if (sort) {
      rows = [...rows].sort((left, right) => {
        const leftValue = left[sort.field as keyof CustomerRow];
        const rightValue = right[sort.field as keyof CustomerRow];
        const order = String(leftValue).localeCompare(String(rightValue), undefined, { numeric: true });
        return sort.direction === 'asc' ? order : -order;
      });
    }

    const start = Math.max(0, query.startRow);
    const endExclusive = query.endRow >= start ? query.endRow + 1 : start + (query.pageSize || 12);
    const page = rows.slice(start, endExclusive);

    this.totalRows.set(rows.length);
    this.gridControl.setTotalRows(rows.length);
    this.datasource.setData(page);
    this.loadedRows.set(page.length);
    const first = rows.length === 0 ? 0 : start + 1;
    const last = Math.min(endExclusive, rows.length);
    this.requestedRange.set(`Rows ${first}–${last} of ${rows.length}`);
  }

  refreshPage(): void {
    this.drafts.clearCellEdits();
    this.loadRows(this.lastQuery);
  }

  discardEdits(): void {
    this.drafts.clearCellEdits();
    this.loadRows(this.lastQuery);
  }

  private makeColumns(): ColDef<CustomerRow>[] {
    return customerFields.map((descriptor) => ({
      field: descriptor.field,
      header: descriptor.label,
      type: descriptor.type,
      width: descriptor.width,
      editable: descriptor.editable,
      filterable: true,
      ...(descriptor.values ? { values: [...descriptor.values] } : {}),
      ...(descriptor.customEditor === 'status' ? { cellEditor: StatusCellEditorComponent } : {}),
    })) as ColDef<CustomerRow>[];
  }
}
