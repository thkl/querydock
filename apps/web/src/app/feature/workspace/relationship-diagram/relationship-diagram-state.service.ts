import { Injectable, signal } from '@angular/core';
import type { TableSnapshot } from '@querydock/contracts';

export interface DiagramPoint {
  x: number;
  y: number;
}

export interface RelationshipDiagramViewState {
  snapshots: TableSnapshot[] | null;
  partialLoadCount: number;
  tablePositions: Record<string, DiagramPoint>;
  scrollLeft: number;
  scrollTop: number;
}

@Injectable({ providedIn: 'root' })
export class RelationshipDiagramStateService {
  readonly byConnection = signal<ReadonlyMap<string, RelationshipDiagramViewState>>(new Map());

  viewFor(connectionId: string): RelationshipDiagramViewState {
    const view = this.byConnection().get(connectionId);
    return view ? { ...view, tablePositions: { ...view.tablePositions } } : {
      snapshots: null,
      partialLoadCount: 0,
      tablePositions: {},
      scrollLeft: 0,
      scrollTop: 0,
    };
  }

  saveSnapshots(connectionId: string, snapshots: TableSnapshot[], partialLoadCount: number): void {
    this.update(connectionId, (current) => ({
      ...current,
      snapshots: [...snapshots],
      partialLoadCount,
    }));
  }

  saveTablePositions(connectionId: string, tablePositions: Record<string, DiagramPoint>): void {
    this.update(connectionId, (current) => ({ ...current, tablePositions: { ...tablePositions } }));
  }

  saveViewport(connectionId: string, scrollLeft: number, scrollTop: number): void {
    this.update(connectionId, (current) => ({ ...current, scrollLeft, scrollTop }));
  }

  private update(
    connectionId: string,
    change: (current: RelationshipDiagramViewState) => RelationshipDiagramViewState,
  ): void {
    const next = new Map(this.byConnection());
    next.set(connectionId, change(this.viewFor(connectionId)));
    this.byConnection.set(next);
  }
}
