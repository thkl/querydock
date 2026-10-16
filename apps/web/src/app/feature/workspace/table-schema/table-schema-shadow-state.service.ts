import { Injectable, signal } from '@angular/core';
import type { ForeignKeyEditorRow } from './foreign-key-editor-state';

export type SchemaShadowStatus = 'live' | 'draft' | 'staged';

export interface SchemaShadowRow {
  status: SchemaShadowStatus;
  row: unknown;
}

export interface TemporaryForeignKeyEditor {
  row: ForeignKeyEditorRow;
  name: string;
  localFields: string[];
  targetSchema: string;
  targetTable: string;
  selectedTargetSet: string;
}

/** In-memory shadow of one table's live metadata and local editor lifecycle. */
export interface TableSchemaShadowState {
  fields: SchemaShadowRow[];
  constraints: SchemaShadowRow[];
  fieldDraftRow: unknown | null;
  constraintDraftRow: unknown | null;
  foreignKeyEditor: TemporaryForeignKeyEditor | null;
}

/** Keeps connection-scoped schema rows available while workspace components change. */
@Injectable({ providedIn: 'root' })
export class TableSchemaShadowStateService {
  readonly tables = signal<ReadonlyMap<string, TableSchemaShadowState>>(new Map());

  /** Returns the in-memory schema shadow for a connection-scoped table. */
  get(key: string): TableSchemaShadowState | null {
    return this.tables().get(key) ?? null;
  }

  /** Replaces the shadow for one table while retaining its identity in the signal map. */
  save(key: string, state: TableSchemaShadowState): void {
    const current = this.tables();
    const previous = current.get(key);
    if (previous && JSON.stringify(previous) === JSON.stringify(state)) return;
    this.tables.update((entries) => new Map(entries).set(key, state));
  }
}

/** Builds a stable key that isolates temporary edits by connection, schema, and table. */
export function tableSchemaShadowKey(connectionId: string, schema: string, table: string): string {
  return JSON.stringify([connectionId, schema, table]);
}
