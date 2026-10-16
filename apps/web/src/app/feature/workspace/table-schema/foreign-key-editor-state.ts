import { Injectable, signal } from '@angular/core';

export interface ForeignKeyEditorRow {
  sourceName: string | null;
  operationName: string | null;
  isUncommitted: boolean;
  kind: string;
  name: string;
  fields: string;
  references: string;
}

@Injectable()
export class ForeignKeyEditorState {
  readonly row = signal<ForeignKeyEditorRow | null>(null);

  /** Selects the constraint row whose referenced-table fields are being edited. */
  open(row: ForeignKeyEditorRow): void { this.row.set(row); }
  /** Closes the editor and clears its selected constraint row. */
  close(): void { this.row.set(null); }
}
