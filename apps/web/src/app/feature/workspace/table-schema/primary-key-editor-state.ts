import { Injectable, signal } from '@angular/core';

export interface PrimaryKeyEditorRow {
  sourceName: string | null;
  operationName: string | null;
  isUncommitted: boolean;
  isGridInput: boolean;
  kind: string;
  name: string;
  fields: string;
}

/** Tracks the primary-key grid row currently being edited in the field picker. */
@Injectable()
export class PrimaryKeyEditorState {
  readonly row = signal<PrimaryKeyEditorRow | null>(null);

  /** Opens the picker for a new or staged primary-key row. */
  open(row: PrimaryKeyEditorRow): void { this.row.set(row); }
  /** Closes the picker. Selected fields remain in the grid row. */
  close(): void { this.row.set(null); }
}
