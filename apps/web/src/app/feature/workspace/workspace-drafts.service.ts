import { Injectable, signal } from '@angular/core';
import type { GridEditEvent } from '@thkl/agrid';
import type { CustomerRow } from './table-data/data/customer.sample';

@Injectable({ providedIn: 'root' })
export class WorkspaceDraftsService {
  readonly pendingCellEdits = signal<GridEditEvent<CustomerRow>[]>([]);

  recordCellEdit(edit: GridEditEvent<CustomerRow>): void {
    this.pendingCellEdits.update((edits) => [...edits, edit]);
  }

  clearCellEdits(): void {
    this.pendingCellEdits.set([]);
  }
}
