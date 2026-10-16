import { Injectable, signal } from '@angular/core';

export interface CheckConstraintEditorRow {
  sourceName: string | null;
  operationName: string | null;
  isUncommitted: boolean;
  isGridInput: boolean;
  kind: string;
  name: string;
  fields: string;
}

@Injectable()
export class CheckConstraintEditorState {
  readonly row = signal<CheckConstraintEditorRow | null>(null);

  /** Selects a CHECK row for contextual expression help. */
  open(row: CheckConstraintEditorRow): void { this.row.set(row); }
  /** Closes the CHECK helper. */
  close(): void { this.row.set(null); }
}
