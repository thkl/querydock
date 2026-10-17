import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, HostListener, afterRenderEffect, computed, effect, inject, signal, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type {
  ConnectResponse,
  ForeignKeyFieldChoices,
  ResourceDescriptor,
  SchemaOperation,
  TableConstraintDescriptor,
  TableSnapshot,
} from '@querydock/contracts';
import { ConnectionApiService } from '../connections/connection-api.service';
import { RunbookService } from '../runbook/runbook.service';
import { WorkspacePagesService } from '../workspace-pages.service';
import { RelationshipDiagramStateService, type DiagramPoint } from './relationship-diagram-state.service';

type FieldSet = ForeignKeyFieldChoices['fieldSets'][number];

interface DiagramRelationship {
  id: string;
  sourceSchema: string;
  sourceTable: string;
  name: string;
  fieldNames: string[];
  referencedSchema: string;
  referencedTable: string;
  referencedFieldNames: string[];
  editable: boolean;
  pending: boolean;
}

interface FieldAnchor { left: number; right: number; y: number; }
interface RelationshipContextMenu { x: number; y: number; relationshipIds: string[]; }

const CARD_WIDTH = 284;
const CANVAS_BOTTOM_PADDING = 24;
const COLUMN_GAP = 112;
const ROW_GAP = 64;
const COLUMN_COUNT = 3;
const FIELD_ROW_HEIGHT = 29;
const CARD_HEADER_HEIGHT = 58;

@Component({
  selector: 'qd-relationship-diagram',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './relationship-diagram.component.html',
  styleUrl: './relationship-diagram.component.css',
})
export class RelationshipDiagramComponent {
  readonly connections = inject(ConnectionApiService);
  private readonly router = inject(Router);
  readonly runbook = inject(RunbookService);
  readonly pages = inject(WorkspacePagesService);
  private readonly diagramState = inject(RelationshipDiagramStateService);
  private readonly destroyRef = inject(DestroyRef);
  readonly snapshots = signal<TableSnapshot[]>([]);
  readonly loading = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly partialLoadCount = signal(0);
  readonly editorOpen = signal(false);
  readonly editorBusy = signal(false);
  readonly editorError = signal<string | null>(null);
  readonly editorMessage = signal<string | null>(null);
  readonly sourceKey = signal('');
  readonly targetKey = signal('');
  readonly localFieldNames = signal<string[]>([]);
  readonly fieldSets = signal<FieldSet[]>([]);
  readonly selectedFieldSet = signal('');
  readonly constraintName = signal('');
  readonly editingRelationship = signal<DiagramRelationship | null>(null);
  readonly selectedRelationshipId = signal<string | null>(null);
  readonly tablePositions = signal<Record<string, DiagramPoint>>({});
  readonly fieldAnchors = signal<Record<string, FieldAnchor>>({});
  readonly metadataLoadedFor = signal<string | null>(null);
  readonly draggingTableKey = signal<string | null>(null);
  readonly contextMenu = signal<RelationshipContextMenu | null>(null);
  readonly relationships = computed(() => this.collectRelationships());
  readonly contextMenuRelationships = computed(() => {
    const ids = new Set(this.contextMenu()?.relationshipIds ?? []);
    return this.relationships().filter(({ id }) => ids.has(id));
  });
  readonly diagramWidth = computed(() => Math.max(1, ...this.snapshots().map((snapshot, index) =>
    this.nodePosition(index).x + CARD_WIDTH + 140)));
  readonly diagramHeight = computed(() => {
    const bottomEdges = this.snapshots().map((snapshot, index) => this.nodeY(index) + this.cardHeight(snapshot));
    return Math.ceil(Math.max(0, ...bottomEdges) + CANVAS_BOTTOM_PADDING);
  });
  readonly sourceSnapshot = computed(() => this.snapshots().find((snapshot) => this.tableKey(snapshot.schema, snapshot.name) === this.sourceKey()) ?? null);
  readonly targetSnapshot = computed(() => this.snapshots().find((snapshot) => this.tableKey(snapshot.schema, snapshot.name) === this.targetKey()) ?? null);
  readonly selectedFieldSetOption = computed(() => this.fieldSets().find(({ fieldNames }) =>
    fieldNames.join('\u0000') === this.selectedFieldSet()) ?? null);
  private snapshotRequestId = 0;
  private fieldSetRequestId = 0;
  private loadedConnectionId: string | null = null;
  private restoredViewConnectionId: string | null = null;
  private dragState: { key: string; pointerId: number; startX: number; startY: number; originX: number; originY: number } | null = null;
  private readonly calculatedColumnCount = signal(COLUMN_COUNT);
  private observedViewport: HTMLDivElement | null = null;
  private readonly viewportResizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
    this.updateColumnCount();
    requestAnimationFrame(() => this.measureFieldAnchors());
  });

  private readonly diagramCanvas = viewChild<ElementRef<HTMLDivElement>>('diagramCanvas');
  private readonly diagramViewport = viewChild<ElementRef<HTMLDivElement>>('diagramViewport');
  private readonly relationshipSvg = viewChild<ElementRef<SVGSVGElement>>('relationshipSvg');

  /** Restores cached diagram state, reloads metadata on connection changes, and keeps paths aligned after render. */
  constructor() {
    this.destroyRef.onDestroy(() => this.viewportResizeObserver?.disconnect());
    afterRenderEffect(() => {
      const connectionId = this.connections.activeConnectionId();
      const viewport = this.diagramViewport();
      const element = viewport?.nativeElement ?? null;
      if (element !== this.observedViewport) {
        this.viewportResizeObserver?.disconnect();
        this.observedViewport = element;
        if (element) this.viewportResizeObserver?.observe(element);
      }
      if (connectionId && this.metadataLoadedFor() === connectionId
        && this.restoredViewConnectionId !== connectionId && viewport) {
        const view = this.diagramState.viewFor(connectionId);
        viewport.nativeElement.scrollLeft = view.scrollLeft;
        viewport.nativeElement.scrollTop = view.scrollTop;
        this.restoredViewConnectionId = connectionId;
      }
      this.updateColumnCount(viewport?.nativeElement);
      this.snapshots();
      this.tablePositions();
      requestAnimationFrame(() => this.measureFieldAnchors());
    });
    effect(() => {
      const connection = this.connections.activeConnection();
      if (!connection) {
        if (this.connections.sessionRestoreComplete()) void this.router.navigateByUrl('/');
        this.loadedConnectionId = null;
        this.snapshotRequestId++;
        this.snapshots.set([]);
        this.tablePositions.set({});
        this.metadataLoadedFor.set(null);
        this.restoredViewConnectionId = null;
        this.selectedRelationshipId.set(null);
        this.closeContextMenu();
        this.loading.set(false);
        this.loadError.set(null);
        this.partialLoadCount.set(0);
        return;
      }
      const connectionId = connection.connectionId;
      const resourceMap = this.connections.resourcesByConnection();
      const resourcesReady = resourceMap.has(connectionId);
      const resources = resourceMap.get(connectionId) ?? [];
      if (this.loadedConnectionId !== connection.connectionId) {
        const saved = this.diagramState.viewFor(connectionId);
        this.loadedConnectionId = connectionId;
        this.pages.registerOpenedRelationshipDiagram(connectionId);
        this.snapshots.set(saved.snapshots ?? []);
        this.tablePositions.set(saved.tablePositions);
        this.metadataLoadedFor.set(saved.snapshots === null ? null : connectionId);
        this.restoredViewConnectionId = null;
        this.selectedRelationshipId.set(null);
        this.closeContextMenu();
        this.partialLoadCount.set(saved.partialLoadCount);
        this.loadError.set(null);
      }
      if (this.metadataLoadedFor() !== connectionId && resourcesReady && !this.loading()) {
        void this.loadSnapshots(connection, resources);
      } else if (this.metadataLoadedFor() !== connectionId && !resourcesReady) {
        const resourceError = this.connections.resourceErrorsByConnection().get(connectionId);
        if (resourceError) this.loadError.set(`Could not load the database table list. ${resourceError}`);
      }
    });
  }

  /** Calculates a table card's horizontal coordinate in the current diagram layout. */
  nodeX(index: number): number {
    return this.nodePosition(index).x;
  }

  /** Calculates a table card's vertical coordinate in the current diagram layout. */
  nodeY(index: number): number {
    return this.nodePosition(index).y;
  }

  /** Uses a saved drag position or the calculated initial grid position. */
  nodePosition(index: number): DiagramPoint {
    const snapshot = this.snapshots()[index];
    if (!snapshot) return { x: 20, y: 20 };
    const saved = this.tablePositions()[this.tableKey(snapshot.schema, snapshot.name)];
    if (saved) return saved;
    const columnCount = this.calculatedColumnCount();
    const row = Math.floor(index / columnCount);
    let y = 20;
    for (let precedingRow = 0; precedingRow < row; precedingRow++) {
      const rowSnapshots = this.snapshots().slice(precedingRow * columnCount, (precedingRow + 1) * columnCount);
      y += Math.max(...rowSnapshots.map((item) => this.cardHeight(item)), 150) + ROW_GAP;
    }
    const currentRow = this.snapshots().slice(row * columnCount, (row + 1) * columnCount);
    return { x: 20 + (index % columnCount) * (CARD_WIDTH + COLUMN_GAP), y };
  }

  /** Computes card height from its title and visible field rows. */
  cardHeight(snapshot: TableSnapshot): number {
    return CARD_HEADER_HEIGHT + 8 + Math.max(1, snapshot.fields.length) * FIELD_ROW_HEIGHT + 40;
  }

  /** Returns the stable schema-qualified identity of a table card. */
  nodeKey(snapshot: TableSnapshot): string {
    return this.tableKey(snapshot.schema, snapshot.name);
  }

  /** Builds a bezier path anchored to the participating field rows. */
  relationshipPath(relationship: DiagramRelationship): string | null {
    const sourceIndex = this.snapshots().findIndex((item) => item.schema === relationship.sourceSchema
      && item.name === relationship.sourceTable);
    const targetIndex = this.snapshots().findIndex((item) => item.schema === relationship.referencedSchema
      && item.name === relationship.referencedTable);
    if (sourceIndex < 0 || targetIndex < 0) return null;
    const source = this.snapshots()[sourceIndex]!;
    const target = this.snapshots()[targetIndex]!;
    const sourcePosition = this.nodePosition(sourceIndex);
    const targetPosition = this.nodePosition(targetIndex);
    const vertical = Math.abs((targetPosition.x - sourcePosition.x)) < 100;
    const sourceIsLeft = targetPosition.x >= sourcePosition.x;
    const sourceSide = vertical ? (targetPosition.y >= sourcePosition.y ? 'right' : 'left') : (sourceIsLeft ? 'right' : 'left');
    const targetSide = vertical ? sourceSide : (sourceIsLeft ? 'left' : 'right');
    const sourcePoint = this.fieldRowsPoint(source, relationship.fieldNames, sourceSide);
    const targetPoint = this.fieldRowsPoint(target, relationship.referencedFieldNames, targetSide);
    if (!sourcePoint || !targetPoint) return null;
    if (sourceIndex === targetIndex) {
      const direction = sourceSide === 'right' ? 1 : -1;
      const loop = Math.max(72, Math.abs(targetPoint.y - sourcePoint.y) / 2);
      return `M ${sourcePoint.x} ${sourcePoint.y} C ${sourcePoint.x + loop * direction} ${sourcePoint.y}, ${targetPoint.x + loop * direction} ${targetPoint.y}, ${targetPoint.x} ${targetPoint.y}`;
    }
    if (vertical) {
      const direction = sourceSide === 'right' ? 1 : -1;
      const bend = Math.max(52, Math.abs(targetPoint.y - sourcePoint.y) * 0.24);
      return `M ${sourcePoint.x} ${sourcePoint.y} C ${sourcePoint.x + bend * direction} ${sourcePoint.y}, ${targetPoint.x + bend * direction} ${targetPoint.y}, ${targetPoint.x} ${targetPoint.y}`;
    }
    const bend = Math.max(52, Math.abs(targetPoint.x - sourcePoint.x) * 0.42);
    const direction = targetPoint.x >= sourcePoint.x ? 1 : -1;
    return `M ${sourcePoint.x} ${sourcePoint.y} C ${sourcePoint.x + bend * direction} ${sourcePoint.y}, ${targetPoint.x - bend * direction} ${targetPoint.y}, ${targetPoint.x} ${targetPoint.y}`;
  }

  /** Finds the center point of a set of field rows on one side of a table card. */
  private fieldRowsPoint(snapshot: TableSnapshot, fieldNames: string[], side: 'left' | 'right'): DiagramPoint | null {
    const anchors = fieldNames.map((name) => this.fieldAnchors()[this.fieldAnchorKey(snapshot, name)]).filter((anchor): anchor is FieldAnchor => !!anchor);
    if (!anchors.length) return null;
    return {
      x: anchors.reduce((sum, anchor) => sum + anchor[side], 0) / anchors.length,
      y: anchors.reduce((sum, anchor) => sum + anchor.y, 0) / anchors.length,
    };
  }

  /** Measures rendered field rows so relationship paths align after layout updates. */
  private measureFieldAnchors(): void {
    const canvas = this.diagramCanvas()?.nativeElement;
    const svg = this.relationshipSvg()?.nativeElement;
    const screenMatrix = svg?.getScreenCTM();
    if (!canvas || !svg || !screenMatrix) return;
    const toSvgPoint = (x: number, y: number): DOMPoint => {
      const point = svg.createSVGPoint();
      point.x = x;
      point.y = y;
      return point.matrixTransform(screenMatrix.inverse());
    };
    const anchors: Record<string, FieldAnchor> = {};
    for (const row of canvas.querySelectorAll<HTMLElement>('[data-table-key][data-field-name]')) {
      const tableKey = row.dataset['tableKey'];
      const fieldName = row.dataset['fieldName'];
      if (!tableKey || !fieldName) continue;
      const rect = row.getBoundingClientRect();
      const centerY = rect.top + rect.height / 2;
      const leftPoint = toSvgPoint(rect.left, centerY);
      const rightPoint = toSvgPoint(rect.right, centerY);
      const centerPoint = toSvgPoint(rect.left + rect.width / 2, centerY);
      anchors[JSON.stringify([tableKey, fieldName])] = {
        left: leftPoint.x,
        right: rightPoint.x,
        y: centerPoint.y,
      };
    }
    this.fieldAnchors.set(anchors);
  }

  /** Chooses a responsive table-column count from the available canvas width. */
  private updateColumnCount(viewport = this.diagramViewport()?.nativeElement): void {
    if (!viewport) return;
    const width = viewport.clientWidth || viewport.getBoundingClientRect().width;
    const nextCount = Math.max(1, Math.floor(width / (CARD_WIDTH + COLUMN_GAP )));
    if (nextCount !== this.calculatedColumnCount()) this.calculatedColumnCount.set(nextCount);
  }

  @HostListener('window:resize')
  /** Recalculates the responsive diagram layout after a viewport resize. */
  onWindowResize(): void {
    this.updateColumnCount();
    requestAnimationFrame(() => this.measureFieldAnchors());
  }

  /** Saves the current scroll offset under the active connection. */
  saveViewport(event: Event): void {
    const connectionId = this.connections.activeConnectionId();
    const viewport = event.currentTarget as HTMLDivElement;
    if (connectionId) this.diagramState.saveViewport(connectionId, viewport.scrollLeft, viewport.scrollTop);
  }

  /** Creates a stable anchor lookup key from a table and field name. */
  private fieldAnchorKey(snapshot: TableSnapshot, fieldName: string): string {
    return JSON.stringify([this.tableKey(snapshot.schema, snapshot.name), fieldName]);
  }

  /** Begins dragging a table card and captures the pointer for continuous movement. */
  startTableDrag(event: PointerEvent, snapshot: TableSnapshot): void {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    const index = this.snapshots().indexOf(snapshot);
    const position = this.nodePosition(index);
    this.dragState = {
      key: this.tableKey(snapshot.schema, snapshot.name),
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: position.x,
      originY: position.y,
    };
    this.draggingTableKey.set(this.dragState.key);
    event.preventDefault();
  }

  @HostListener('window:pointermove', ['$event'])
  /** Moves the active table card and persists its new canvas position. */
  moveTable(event: PointerEvent): void {
    const drag = this.dragState;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    const x = Math.max(8, drag.originX + deltaX);
    const y = Math.max(8, drag.originY + deltaY);
    const next = { ...this.tablePositions(), [drag.key]: { x, y } };
    this.tablePositions.set(next);
    const connectionId = this.connections.activeConnectionId();
    if (connectionId) this.diagramState.saveTablePositions(connectionId, next);
  }

  @HostListener('window:pointerup', ['$event'])
  /** Releases pointer capture and completes the current table drag. */
  endTableDrag(event: PointerEvent): void {
    if (!this.dragState || event.pointerId !== this.dragState.pointerId) return;
    this.dragState = null;
    this.draggingTableKey.set(null);
  }

  /** Focuses one relationship and dims unrelated tables and paths. */
  onRelationshipClick(event: Event, relationship: DiagramRelationship): void {
    event.stopPropagation();
    this.selectedRelationshipId.set(relationship.id);
    this.closeContextMenu();
  }

  /** Focuses relationships that include the selected table field. */
  onFieldClick(event: MouseEvent, snapshot: TableSnapshot, fieldName: string): void {
    event.stopPropagation();
    const matches = this.relationshipsForField(snapshot, fieldName);
    this.selectedRelationshipId.set(matches.length === 1 ? matches[0]!.id : null);
    this.closeContextMenu();
  }

  /** Opens the relationship action menu at the pointer location. */
  openRelationshipContext(event: MouseEvent, relationship: DiagramRelationship): void {
    event.preventDefault();
    event.stopPropagation();
    this.selectedRelationshipId.set(relationship.id);
    this.setContextMenu(event, [relationship.id]);
  }

  /** Opens actions for relationships connected to the selected field. */
  openFieldContext(event: MouseEvent, snapshot: TableSnapshot, fieldName: string): void {
    event.preventDefault();
    event.stopPropagation();
    const matches = this.relationshipsForField(snapshot, fieldName);
    if (!matches.length) return;
    this.selectedRelationshipId.set(matches.length === 1 ? matches[0]!.id : null);
    this.setContextMenu(event, matches.map(({ id }) => id));
  }

  /** Finds every relationship touching a table field. */
  relationshipsForField(snapshot: TableSnapshot, fieldName: string): DiagramRelationship[] {
    return this.relationships().filter((relationship) =>
      (relationship.sourceSchema === snapshot.schema && relationship.sourceTable === snapshot.name && relationship.fieldNames.includes(fieldName))
      || (relationship.referencedSchema === snapshot.schema && relationship.referencedTable === snapshot.name && relationship.referencedFieldNames.includes(fieldName)));
  }

  /** Clears relationship focus and restores normal opacity for all diagram elements. */
  clearRelationshipFocus(): void {
    this.selectedRelationshipId.set(null);
    this.closeContextMenu();
  }

  /** Closes the currently visible relationship action menu. */
  closeContextMenu(): void {
    this.contextMenu.set(null);
  }

  /** Opens the editor for the relationship selected from the context menu. */
  contextEdit(relationship: DiagramRelationship): void {
    this.closeContextMenu();
    void this.editRelationship(relationship);
  }

  /** Stages removal for the selected relationship. */
  contextRemove(relationship: DiagramRelationship): void {
    this.closeContextMenu();
    void this.removeRelationship(relationship);
  }

  /** Prevents the browser menu and positions the app's context actions. */
  private setContextMenu(event: MouseEvent, relationshipIds: string[]): void {
    const menuHeight = Math.min(relationshipIds.length * 88 + 20, 360);
    this.contextMenu.set({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 308)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
      relationshipIds,
    });
  }

  /** Opens the selected table schema in the workspace tab bar. */
  openTable(snapshot: TableSnapshot): void {
    const connectionId = this.connections.activeConnectionId();
    if (connectionId) this.pages.openTableSchema(connectionId, snapshot.schema, snapshot.name);
  }

  /** Reloads visible table snapshots and relationship metadata for this connection. */
  async refresh(): Promise<void> {
    const connection = this.connections.activeConnection();
    if (!connection) return;
    try {
      await this.connections.refreshResources(connection.connectionId);
      const resources = this.connections.resourcesByConnection().get(connection.connectionId) ?? [];
      await this.loadSnapshots(connection, resources);
    } catch (error) {
      this.loadError.set(error instanceof Error ? error.message : 'Could not refresh the database diagram.');
    }
  }

  /** Initializes a new foreign-key editor with the current connection's table choices. */
  startNewRelationship(): void {
    this.fieldSetRequestId++;
    this.editorBusy.set(false);
    this.clearRelationshipFocus();
    const firstEditable = this.snapshots().find(({ canAlter }) => canAlter);
    this.editingRelationship.set(null);
    this.sourceKey.set(firstEditable ? this.tableKey(firstEditable.schema, firstEditable.name) : '');
    this.targetKey.set('');
    this.localFieldNames.set([]);
    this.constraintName.set('');
    this.fieldSets.set([]);
    this.selectedFieldSet.set('');
    this.editorError.set(null);
    this.editorMessage.set(null);
    this.editorOpen.set(true);
  }

  /** Loads a relationship's source, target, and local field selections into the editor. */
  async editRelationship(relationship: DiagramRelationship): Promise<void> {
    this.fieldSetRequestId++;
    this.editingRelationship.set(relationship);
    this.sourceKey.set(this.tableKey(relationship.sourceSchema, relationship.sourceTable));
    this.targetKey.set(this.tableKey(relationship.referencedSchema, relationship.referencedTable));
    this.localFieldNames.set([...relationship.fieldNames]);
    this.constraintName.set(relationship.name);
    this.selectedFieldSet.set(relationship.referencedFieldNames.join('\u0000'));
    this.editorError.set(null);
    this.editorMessage.set(null);
    this.editorOpen.set(true);
    await this.loadFieldSets();
  }

  /** Closes the relationship editor and discards its unsaved form state. */
  closeEditor(): void {
    if (this.editorBusy()) return;
    this.editorOpen.set(false);
    this.editingRelationship.set(null);
  }

  /** Updates the selected source table and resets dependent field selections. */
  onSourceChanged(event: Event): void {
    this.fieldSetRequestId++;
    this.editorBusy.set(false);
    this.sourceKey.set((event.currentTarget as HTMLSelectElement).value);
    this.localFieldNames.set([]);
    this.fieldSets.set([]);
    this.selectedFieldSet.set('');
  }

  /** Updates the target table and requests compatible unique-key field sets. */
  onTargetChanged(event: Event): void {
    this.fieldSetRequestId++;
    this.editorBusy.set(false);
    this.targetKey.set((event.currentTarget as HTMLSelectElement).value);
    this.selectedFieldSet.set('');
    void this.loadFieldSets();
  }

  /** Updates a local field selection and refreshes target key compatibility. */
  async onLocalFieldChanged(fieldName: string, event: Event): Promise<void> {
    const checked = (event.currentTarget as HTMLInputElement).checked;
    const selected = this.localFieldNames();
    this.localFieldNames.set(checked ? [...selected, fieldName] : selected.filter((name) => name !== fieldName));
    await this.loadFieldSets();
  }

  /** Stages the edited foreign-key operation in the database runbook. */
  async saveRelationship(): Promise<void> {
    const connection = this.connections.activeConnection();
    const source = this.sourceSnapshot();
    const target = this.targetSnapshot();
    const fieldSet = this.selectedFieldSetOption();
    const name = this.constraintName().trim();
    if (!connection || !source || !target || !fieldSet?.compatible || !name || !this.localFieldNames().length) return;

    const nextOperation = {
      kind: 'addConstraint' as const,
      constraintKind: 'foreignKey' as const,
      name,
      fieldNames: this.localFieldNames(),
      referencedSchema: target.schema,
      referencedTable: target.name,
      referencedFieldNames: fieldSet.fieldNames,
    };
    const current = this.editingRelationship();
    const pendingDrops = current?.pending
      ? this.pendingOriginalDrops(source, current.name)
      : [];
    const replacements = current && !current.pending
      ? [{ kind: 'dropConstraint' as const, name: current.name }, nextOperation]
      : [...pendingDrops, nextOperation];
    const replacementNames = [...new Set([
      ...(current ? [current.name] : []),
      ...pendingDrops.map(({ name: droppedName }) => droppedName),
      name,
    ])];
    this.editorBusy.set(true);
    this.editorError.set(null);
    this.editorMessage.set(null);
    try {
      await this.runbook.stageSchemaOperations(connection, source, replacements, replacementNames);
      this.editorMessage.set('Relationship changes are staged in the Runbook.');
      this.clearRelationshipFocus();
      this.editorOpen.set(false);
      this.editingRelationship.set(null);
    } catch (error) {
      this.editorError.set(error instanceof Error ? error.message : 'Unable to stage this relationship.');
    } finally {
      this.editorBusy.set(false);
    }
  }

  /** Stages a constraint drop and updates the displayed relationship set. */
  async removeRelationship(relationship: DiagramRelationship): Promise<void> {
    if (!relationship.editable) return;
    const connection = this.connections.activeConnection();
    const source = this.snapshots().find(({ schema, name }) =>
      schema === relationship.sourceSchema && name === relationship.sourceTable);
    if (!connection || !source) return;
    const pendingDrops = relationship.pending ? this.pendingOriginalDrops(source, relationship.name) : [];
    const replacements = relationship.pending
      ? pendingDrops
      : [{ kind: 'dropConstraint' as const, name: relationship.name }];
    const names = [relationship.name, ...pendingDrops.map(({ name }) => name)];
    this.editorBusy.set(true);
    this.editorError.set(null);
    this.editorMessage.set(null);
    try {
      await this.runbook.stageSchemaOperations(connection, source, replacements, names);
      this.clearRelationshipFocus();
      this.editorMessage.set(relationship.pending
        ? 'Pending relationship draft removed from the Runbook.'
        : 'Relationship removal is staged in the Runbook.');
    } catch (error) {
      this.editorError.set(error instanceof Error ? error.message : 'Unable to remove this relationship.');
    } finally {
      this.editorBusy.set(false);
    }
  }

  /** Formats one or more field names for diagram labels. */
  fieldsLabel(fields: string[]): string {
    return fields.join(', ');
  }

  /** Lists relationships whose source table is the supplied snapshot. */
  relationshipsFor(snapshot: TableSnapshot): DiagramRelationship[] {
    return this.relationships().filter(({ sourceSchema, sourceTable }) =>
      sourceSchema === snapshot.schema && sourceTable === snapshot.name);
  }

  /** Checks whether a table participates in the focused relationship set. */
  isRelationshipParticipant(snapshot: TableSnapshot): boolean {
    const relationship = this.relationships().find(({ id }) => id === this.selectedRelationshipId());
    return !!relationship && (
      (relationship.sourceSchema === snapshot.schema && relationship.sourceTable === snapshot.name)
      || (relationship.referencedSchema === snapshot.schema && relationship.referencedTable === snapshot.name)
    );
  }

  /** Checks whether a field participates in a currently focused relationship. */
  isRelationshipField(snapshot: TableSnapshot, fieldName: string): boolean {
    const relationship = this.relationships().find(({ id }) => id === this.selectedRelationshipId());
    if (!relationship) return false;
    return (relationship.sourceSchema === snapshot.schema && relationship.sourceTable === snapshot.name && relationship.fieldNames.includes(fieldName))
      || (relationship.referencedSchema === snapshot.schema && relationship.referencedTable === snapshot.name && relationship.referencedFieldNames.includes(fieldName));
  }

  /** Returns the primary, unique, and foreign-key roles shown beside a field. */
  fieldKeyKinds(snapshot: TableSnapshot, fieldName: string): string[] {
    return snapshot.constraints
      .filter(({ kind, fieldNames }) => ['primaryKey', 'unique'].includes(kind) && fieldNames.includes(fieldName))
      .map(({ kind }) => kind === 'primaryKey' ? 'PK' : 'UNIQUE');
  }

  /** Loads table metadata in bounded batches and records partial-load information. */
  private async loadSnapshots(connection: ConnectResponse, resources: ResourceDescriptor[]): Promise<void> {
    const requestId = ++this.snapshotRequestId;
    const tables = resources.filter(({ kind }) => kind === 'table' || kind === 'partitionedTable');
    this.loading.set(true);
    this.loadError.set(null);
    this.partialLoadCount.set(0);
    try {
      const results = await mapConcurrent(tables, 4, async (resource) => {
        try {
          return await this.connections.inspectTable(connection.connectionId, resource.schema, resource.name);
        } catch {
          return null;
        }
      });
      if (requestId !== this.snapshotRequestId || this.connections.activeConnectionId() !== connection.connectionId) return;
      const snapshots = results.filter((snapshot): snapshot is TableSnapshot => snapshot !== null)
        .sort((left, right) => left.schema.localeCompare(right.schema) || left.name.localeCompare(right.name));
      const failedCount = results.length - snapshots.length;
      const hasCachedSnapshot = this.diagramState.viewFor(connection.connectionId).snapshots !== null;
      if (!(failedCount && !snapshots.length && hasCachedSnapshot)) {
        this.snapshots.set(snapshots);
        this.partialLoadCount.set(failedCount);
        if (snapshots.length || failedCount === 0) {
          this.diagramState.saveSnapshots(connection.connectionId, snapshots, failedCount);
        }
      }
      this.metadataLoadedFor.set(connection.connectionId);
      if (failedCount && !snapshots.length) {
        this.loadError.set('No table metadata could be loaded. Check database visibility and permissions, then refresh.');
      }
    } catch (error) {
      if (requestId === this.snapshotRequestId && this.connections.activeConnectionId() === connection.connectionId) {
        this.loadError.set(error instanceof Error ? error.message : 'Could not load the database diagram.');
      }
    } finally {
      if (requestId === this.snapshotRequestId && this.connections.activeConnectionId() === connection.connectionId) {
        this.metadataLoadedFor.set(connection.connectionId);
        this.loading.set(false);
      }
    }
  }

  /** Refreshes compatible target key sets for the relationship currently being edited. */
  private async loadFieldSets(): Promise<void> {
    const requestId = ++this.fieldSetRequestId;
    const connection = this.connections.activeConnection();
    const source = this.sourceSnapshot();
    const target = this.targetSnapshot();
    const localFieldNames = this.localFieldNames();
    this.fieldSets.set([]);
    this.editorError.set(null);
    if (!connection || !source || !target || !localFieldNames.length) {
      this.editorBusy.set(false);
      return;
    }
    this.editorBusy.set(true);
    this.editorError.set(null);
    try {
      const result = await this.connections.foreignKeyFieldChoices(
        connection.connectionId,
        source.schema,
        source.name,
        target.schema,
        target.name,
        localFieldNames,
      );
      if (requestId !== this.fieldSetRequestId
        || this.sourceSnapshot()?.fingerprint !== source.fingerprint
        || this.targetSnapshot()?.fingerprint !== target.fingerprint
        || this.localFieldNames().join('\u0000') !== localFieldNames.join('\u0000')) return;
      this.fieldSets.set(result.fieldSets);
      const selected = result.fieldSets.find(({ fieldNames }) => fieldNames.join('\u0000') === this.selectedFieldSet())
        ?? result.fieldSets.find(({ compatible }) => compatible)
        ?? result.fieldSets[0];
      this.selectedFieldSet.set(selected?.fieldNames.join('\u0000') ?? '');
      if (!result.fieldSets.length) this.editorError.set('The selected table has no primary or unique key to reference.');
    } catch (error) {
      if (requestId === this.fieldSetRequestId) {
        this.editorError.set(error instanceof Error ? error.message : 'Unable to load compatible target keys.');
      }
    } finally {
      if (requestId === this.fieldSetRequestId) this.editorBusy.set(false);
    }
  }

  /** Combines persisted constraints with staged runbook additions and removals. */
  private collectRelationships(): DiagramRelationship[] {
    const snapshots = this.snapshots();
    const current = this.runbook.runbook();
    const relationships = snapshots.flatMap((snapshot) => snapshot.constraints
      .filter((constraint) => constraint.kind === 'foreignKey')
      .map((constraint) => this.toRelationship(snapshot, constraint, false)));
    if (!current) return relationships;
    for (const change of current.tableChanges ?? (current.operations.length
      ? [{ schema: current.schema, table: current.table, baseline: current.baseline, operations: current.operations }]
      : [])) {
      const baselineKey = this.tableKey(change.schema, change.table);
      for (const operation of change.operations) {
        if (operation.kind === 'dropConstraint') {
          const index = relationships.findIndex((relation) => this.tableKey(relation.sourceSchema, relation.sourceTable) === baselineKey
            && relation.name === operation.name);
          if (index >= 0) relationships.splice(index, 1);
        } else if (operation.kind === 'addConstraint' && operation.constraintKind === 'foreignKey') {
          relationships.push({
            id: this.relationshipKey(change.schema, change.table, operation.name),
            sourceSchema: change.schema,
            sourceTable: change.table,
            name: operation.name,
            fieldNames: operation.fieldNames,
            referencedSchema: operation.referencedSchema,
            referencedTable: operation.referencedTable,
            referencedFieldNames: operation.referencedFieldNames,
            editable: change.baseline?.canAlter ?? false,
            pending: true,
          });
        }
      }
    }
    return relationships.sort((left, right) => left.sourceSchema.localeCompare(right.sourceSchema)
      || left.sourceTable.localeCompare(right.sourceTable) || left.name.localeCompare(right.name));
  }

  /** Converts a foreign-key constraint descriptor into diagram edge data. */
  private toRelationship(snapshot: TableSnapshot, constraint: TableConstraintDescriptor, pending: boolean): DiagramRelationship {
    return {
      id: this.relationshipKey(snapshot.schema, snapshot.name, constraint.name),
      sourceSchema: snapshot.schema,
      sourceTable: snapshot.name,
      name: constraint.name,
      fieldNames: constraint.fieldNames,
      referencedSchema: constraint.referencedSchema ?? '',
      referencedTable: constraint.referencedTable ?? '',
      referencedFieldNames: constraint.referencedFieldNames,
      editable: constraint.editable,
      pending,
    };
  }

  /** Finds original constraints that must be dropped when a staged key replaces them. */
  private pendingOriginalDrops(source: TableSnapshot, pendingName: string): Extract<SchemaOperation, { kind: 'dropConstraint' }>[] {
    const current = this.runbook.runbook();
    if (!current) return [];
    const change = current.tableChanges?.find(({ schema, table }) => schema === source.schema && table === source.name)
      ?? (current.schema === source.schema && current.table === source.name
        ? { operations: current.operations }
        : null);
    if (!change) return [];
    const actualForeignKeys = new Set(source.constraints.filter(({ kind }) => kind === 'foreignKey').map(({ name }) => name));
    const candidates = change.operations.filter((operation): operation is Extract<SchemaOperation, { kind: 'dropConstraint' }> =>
      operation.kind === 'dropConstraint' && actualForeignKeys.has(operation.name));
    const sameName = candidates.filter(({ name }) => name === pendingName);
    if (sameName.length === 1) return sameName;
    return candidates.length === 1 ? candidates : [];
  }

  /** Builds a stable key for a table node and its measured field anchors. */
  private tableKey(schema: string, table: string): string {
    return JSON.stringify([schema, table]);
  }

  /** Builds a stable key for one named table constraint edge. */
  private relationshipKey(schema: string, table: string, name: string): string {
    return JSON.stringify([schema, table, name]);
  }
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await map(items[index]!);
    }
  }));
  return results;
}
