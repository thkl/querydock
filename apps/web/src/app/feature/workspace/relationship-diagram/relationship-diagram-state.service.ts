import { Injectable, signal } from '@angular/core';
import type { TableSnapshot } from '@querydock/contracts';

export interface DiagramPoint {
  x: number;
  y: number;
}

export interface RelationshipDiagramViewState {
  snapshots: TableSnapshot[] | null;
  schemaRevision: number;
  partialLoadCount: number;
  tablePositions: Record<string, DiagramPoint>;
  scrollLeft: number;
  scrollTop: number;
}

@Injectable({ providedIn: 'root' })
export class RelationshipDiagramStateService {
  readonly byConnection = signal<ReadonlyMap<string, RelationshipDiagramViewState>>(new Map());

  /** Returns persisted diagram state for one connection without sharing mutable position objects. */
  viewFor(connectionId: string): RelationshipDiagramViewState {
    const view = this.byConnection().get(connectionId);
    return view ? {
      ...view,
      tablePositions: Object.fromEntries(Object.entries(view.tablePositions).map(([key, point]) => [key, { ...point }])),
    } : {
      snapshots: null,
      schemaRevision: 0,
      partialLoadCount: 0,
      tablePositions: {},
      scrollLeft: 0,
      scrollTop: 0,
    };
  }

  /** Caches loaded table snapshots and whether loading was limited to a partial result. */
  saveSnapshots(connectionId: string, snapshots: TableSnapshot[], partialLoadCount: number, schemaRevision = 0): void {
    this.update(connectionId, (current) => ({
      ...current,
      snapshots: [...snapshots],
      schemaRevision,
      partialLoadCount,
    }));
  }

  /** Persists node positions independently for each connected database. */
  saveTablePositions(connectionId: string, tablePositions: Record<string, DiagramPoint>): void {
    this.update(connectionId, (current) => ({
      ...current,
      tablePositions: Object.fromEntries(Object.entries(tablePositions).map(([key, point]) => [key, { ...point }])),
    }));
  }

  /** Persists the diagram scroll offset so tab changes restore the same viewport. */
  saveViewport(connectionId: string, scrollLeft: number, scrollTop: number): void {
    this.update(connectionId, (current) => ({ ...current, scrollLeft, scrollTop }));
  }

  /** Copies the connection map before applying one immutable view-state update. */
  private update(
    connectionId: string,
    change: (current: RelationshipDiagramViewState) => RelationshipDiagramViewState,
  ): void {
    const next = new Map(this.byConnection());
    next.set(connectionId, change(this.viewFor(connectionId)));
    this.byConnection.set(next);
  }
}
