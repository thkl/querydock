import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { combineLatest } from 'rxjs';
import type {
  EditableConstraintKind,
  ForeignKeyFieldChoices,
  SchemaFieldDraftRequest,
  SchemaOperation,
  TableConstraintDescriptor,
  TableSnapshot,
} from '@querydock/contracts';
import {
  AgridComponent,
  AgridControl,
  AgridDataSource,
  AgridProvider,
  RowUpdateEvent,
  type CellReadonlyParams,
  type ColDef,
  type GridEditEvent,
  type NewRecord,
  type RecordEditEvent,
} from '@thkl/agrid';
import { ConnectionApiService } from '../connections/connection-api.service';
import { RunbookService } from '../runbook/runbook.service';
import { WorkspacePagesService } from '../workspace-pages.service';
import { SchemaBadgeCellComponent } from './schema-badge-cell.component';
import { ForeignKeyEditorState, type ForeignKeyEditorRow } from './foreign-key-editor-state';
import { ForeignKeyReferenceCellComponent } from './foreign-key-reference-cell.component';
import { CheckConstraintEditorState } from './check-constraint-editor-state';
import { CheckConstraintHelpCellComponent } from './check-constraint-help-cell.component';
import { CheckConstraintHelperComponent } from './check-constraint-helper.component';
import { DefaultPresetEditorComponent } from './default-preset-editor.component';
import { PrimaryKeyEditorState } from './primary-key-editor-state';
import { PrimaryKeyFieldsCellComponent } from './primary-key-fields-cell.component';
import { suggestConstraintName } from './constraint-name-suggestion';
import {
  TableSchemaShadowStateService,
  tableSchemaShadowKey,
  type TemporaryForeignKeyEditor,
} from './table-schema-shadow-state.service';

interface SchemaFieldRow {
  sourceName: string | null;
  operationName: string | null;
  canEdit: boolean;
  canEditIdentity: boolean;
  name: string;
  dataType: string;
  typeDetails: string;
  typeIdentity: string;
  nullable: boolean;
  defaultValue: string;
  defaultPreset: string;
  defaultPresetOptions: { value: string; label: string }[];
  identityGeneration: 'none' | 'always' | 'byDefault';
  isUncommitted: boolean;
  isGridInput: boolean;
  editedFields: string[];
  status: string;
}

interface SchemaConstraintRow {
  sourceName: string | null;
  operationName: string | null;
  isUncommitted: boolean;
  isGridInput: boolean;
  checkHelp?: string;
  primaryKeyHelp?: string;
  kind: string;
  name: string;
  fields: string;
  definition: string;
  references: string;
  canDrop: boolean;
  drop: boolean;
  status: string;
}

type ForeignKeyTargetFieldSet = ForeignKeyFieldChoices['fieldSets'][number];

@Component({
  selector: 'qd-table-schema',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AgridComponent, RouterLink, CheckConstraintHelperComponent],
  providers: [ForeignKeyEditorState, CheckConstraintEditorState, PrimaryKeyEditorState],
  templateUrl: './table-schema.component.html',
  styleUrl: './table-schema.component.css',
})
export class TableSchemaComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private requestVersion = 0;

  readonly connections = inject(ConnectionApiService);
  readonly foreignKeyEditor = inject(ForeignKeyEditorState);
  readonly checkConstraintEditor = inject(CheckConstraintEditorState);
  readonly primaryKeyEditor = inject(PrimaryKeyEditorState);
  readonly runbook = inject(RunbookService);
  private readonly workspacePages = inject(WorkspacePagesService);
  private readonly shadowState = inject(TableSchemaShadowStateService);
  private activeSchemaDraftKey: string | null = null;
  readonly routeState = toSignal(
    combineLatest([this.route.paramMap, this.route.queryParamMap]),
    { initialValue: [this.route.snapshot.paramMap, this.route.snapshot.queryParamMap] as const },
  );
  readonly snapshot = signal<TableSnapshot | null>(null);
  readonly displayFields = computed<SchemaFieldRow[]>(() => {
    const table = this.snapshot();
    if (!table) return [];
    const fields: SchemaFieldRow[] = table.fields.map((field) => ({
      sourceName: field.name,
      operationName: null,
      canEdit: field.editable,
      canEditIdentity: field.identityEditable,
      name: field.name,
      dataType: field.editableType ?? field.dataType,
      typeDetails: field.characterMaximumLength !== null
        ? String(field.characterMaximumLength)
        : ['varchar', 'nvarchar', 'varbinary'].includes(field.editableType ?? '') && field.dataType.toLowerCase().endsWith('(max)')
          ? 'max'
          : ['numeric', 'float'].includes(field.editableType ?? '') && field.numericPrecision !== null
            ? `${field.numericPrecision}${field.editableType === 'numeric' && field.numericScale !== null ? `, ${field.numericScale}` : ''}`
            : ['datetime2', 'datetimeoffset', 'time'].includes(field.editableType ?? '') && field.numericScale !== null
              ? String(field.numericScale)
              : '',
      typeIdentity: `${field.typeSchema}.${field.typeName}`,
      nullable: field.nullable,
      defaultValue: field.generated
          ? `GENERATED${field.generationExpression ? ` · ${field.generationExpression}` : ''}`
          : field.defaultExpression ?? '—',
      defaultPreset: this.matchingDefaultPreset(field.editableType, field.defaultExpression),
      defaultPresetOptions: this.defaultPresetsFor(field.editableType ?? ''),
      identityGeneration: field.identityGeneration ?? 'none',
      isUncommitted: false,
      isGridInput: false,
      editedFields: [],
      status: '',
    }));

    const pending = this.runbook.runbook();
    const connection = this.connections.activeConnection();
    if (!pending || !connection || !sameTarget(pending.target, connection.target)) {
      return this.appendFieldDraft(fields);
    }

    for (const operation of this.runbook.operationsForResource(pending, table.schema, table.name)) {
      if (operation.kind === 'addNullableField') {
        if (fields.some(({ operationName }) => operationName === operation.name)
          || fields.some(({ sourceName }) => sourceName === operation.name)) continue;
        fields.push({
          sourceName: null,
          operationName: operation.name,
          canEdit: !operation.identityGeneration,
          canEditIdentity: this.identityGenerationAllowed(operation.type),
          name: operation.name,
          dataType: operation.type,
          typeDetails: fieldTypeDetails(operation),
          typeIdentity: this.typeIdentity(table, operation.type),
          nullable: operation.identityGeneration ? false : true,
          defaultValue: operation.defaultExpression ?? '—',
          defaultPreset: this.matchingDefaultPreset(operation.type, operation.defaultExpression ?? null),
          defaultPresetOptions: this.defaultPresetsFor(operation.type),
          identityGeneration: operation.identityGeneration ?? 'none',
          isUncommitted: true,
          isGridInput: false,
          editedFields: [],
          status: 'UNCOMMITTED',
        });
      } else if (operation.kind === 'alterField') {
        const field = fields.find(({ sourceName }) => sourceName === operation.name);
        if (!field) continue;
        field.operationName = operation.name;
        if (operation.identityGeneration !== undefined) field.canEdit = operation.identityGeneration === null;
        field.canEditIdentity = this.identityGenerationAllowed(operation.type);
        field.name = operation.newName;
        field.dataType = operation.type;
        field.typeDetails = fieldTypeDetails(operation);
        field.typeIdentity = this.typeIdentity(table, operation.type);
        field.defaultValue = operation.defaultExpression ?? '—';
        field.identityGeneration = operation.identityGeneration === undefined
          ? field.identityGeneration
          : operation.identityGeneration ?? 'none';
        field.nullable = operation.nullable ?? field.nullable;
        field.isUncommitted = true;
        field.status = 'UNCOMMITTED';
      }
    }
    return this.appendFieldDraft(fields);
  });
  readonly pendingTableOperation = computed(() => {
    const pending = this.runbook.runbook();
    const table = this.snapshot();
    const connection = this.connections.activeConnection();
    if (!pending || !table || !connection || !sameTarget(pending.target, connection.target)) return null;
    return this.runbook.operationsForResource(pending, table.schema, table.name)
      .find((operation) => operation.kind === 'renameTable' || operation.kind === 'dropTable') ?? null;
  });
  readonly uncommittedSchemaChangeCount = computed(() =>
    this.displayFields().filter((field) => field.isUncommitted).length
      + this.displayConstraints().filter((constraint) => constraint.isUncommitted).length
      + (this.pendingTableOperation() ? 1 : 0),
  );
  readonly displayConstraints = computed<SchemaConstraintRow[]>(() =>
    this.toDisplayConstraints(),
  );
  readonly visibleConstraintCount = computed(() => this.displayConstraints().filter(({ drop }) => !drop).length);
  readonly primaryKeySelectedFields = computed(() => {
    try { return parseFieldNames(this.primaryKeyEditor.row()?.fields ?? ''); } catch { return []; }
  });
  readonly primaryKeySuggestedName = computed(() =>
    suggestConstraintName('pk', this.primaryKeySelectedFields()[0] ?? ''),
  );
  readonly primaryKeyNameSuggestion = signal('');
  private readonly syncPrimaryKeyNameSuggestion = effect(() =>
    this.primaryKeyNameSuggestion.set(this.primaryKeySuggestedName()),
  );
  readonly fieldDatasource = new AgridDataSource<SchemaFieldRow>();
  readonly constraintDatasource = new AgridDataSource<SchemaConstraintRow>();
  readonly editableFieldGridProvider: AgridProvider<SchemaFieldRow>;
  readonly readonlyFieldGridProvider: AgridProvider<SchemaFieldRow>;
  readonly fieldGridProvider = computed(() => this.canEditFields() && !this.stagingField()
    ? this.editableFieldGridProvider
    : this.readonlyFieldGridProvider);
  readonly editableConstraintGridProvider: AgridProvider<SchemaConstraintRow>;
  readonly readonlyConstraintGridProvider: AgridProvider<SchemaConstraintRow>;
  readonly constraintGridProvider = computed(() => this.canEditConstraints()
    && Boolean(this.snapshot()?.editableConstraintKinds.length) && !this.stagingField()
    ? this.editableConstraintGridProvider
    : this.readonlyConstraintGridProvider);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly stagingField = signal(false);
  readonly stageError = signal<string | null>(null);
  readonly tableRenameError = signal<string | null>(null);
  private readonly queuedFieldDrafts = new Map<string, SchemaFieldRow>();
  private processingFieldDrafts = false;
  readonly renamingTable = signal(false);
  readonly tableNameDraft = signal('');
  private readonly tableRenameInput = viewChild<ElementRef<HTMLInputElement>>('tableRenameInput');
  private readonly focusTableRenameInput = effect(() => {
    const input = this.tableRenameInput();
    if (this.renamingTable() && input) {
      input.nativeElement.focus();
      input.nativeElement.select();
    }
  });
  readonly fieldTypeOptions = computed(() => (this.snapshot()?.editableFieldTypes ?? [])
    .map(({ value, label }) => ({ value, label })));
  readonly foreignKeyTargets = computed(() => this.connections.activeResources()
    .filter(({ kind }) => kind === 'table' || kind === 'partitionedTable'));
  readonly foreignKeyLocalFields = signal<string[]>([]);
  readonly foreignKeyTargetSchema = signal('');
  readonly foreignKeyTargetTable = signal('');
  readonly foreignKeyTargetSets = signal<ForeignKeyTargetFieldSet[]>([]);
  readonly foreignKeySelectedSet = signal('');
  readonly selectedForeignKeyTargetSet = computed(() => this.foreignKeyTargetSets()
    .find(({ fieldNames }) => fieldNames.join('\u0000') === this.foreignKeySelectedSet()) ?? null);
  readonly foreignKeyTargetProblem = computed(() => {
    const selected = this.selectedForeignKeyTargetSet();
    return selected && !selected.compatible ? selected.reason : this.foreignKeyEditorError();
  });
  readonly foreignKeyEditorName = signal('');
  readonly foreignKeyEditorLoading = signal(false);
  readonly foreignKeyEditorError = signal<string | null>(null);
  private initializedForeignKeyRow: ForeignKeyEditorRow | null = null;

  /** Loads the requested table, initializes editable grids, and restores runbook state. */
  constructor() {
    const columns = this.makeFieldColumns();
    this.editableFieldGridProvider = new AgridProvider<SchemaFieldRow>({
      columns,
      datasource: this.fieldDatasource,
      control: new AgridControl(),
      readonly: false,
      allowAddRows: true,
      enableRowMarking: false,
      enableColumnMarking: false,
      showToolbar: false,
      hideGridStatusBar: true,
      removeEmptyNewRowOnEscape:true,
      clearCellSelectionOnBackgroundClick: true,
      emptyText: 'No visible fields were returned.',
      getRowClass: ({ row }) => row.isUncommitted
        ? 'schema-row-uncommitted'
        : row.isGridInput ? 'schema-row-input' : '',
    });
    this.readonlyFieldGridProvider = new AgridProvider<SchemaFieldRow>({
      columns,
      datasource: this.fieldDatasource,
      control: new AgridControl(),
      readonly: true,
      allowAddRows: false,
      enableRowMarking: false,
      enableColumnMarking: false,
      showToolbar: false,
      hideGridStatusBar: true,
      removeEmptyNewRowOnEscape:true,
      clearCellSelectionOnBackgroundClick: true,
      emptyText: 'No visible fields were returned.',
      getRowClass: ({ row }) => row.isUncommitted
        ? 'schema-row-uncommitted'
        : row.isGridInput ? 'schema-row-input' : '',
    });
    const constraintColumns = this.makeConstraintColumns();
    this.editableConstraintGridProvider = new AgridProvider<SchemaConstraintRow>({
      columns: constraintColumns,
      datasource: this.constraintDatasource,
      control: new AgridControl(),
      readonly: false,
      allowAddRows: true,
      showToolbar: false,
      enableRowMarking: false,
      enableColumnMarking: false,
      hideGridStatusBar: true,
      removeEmptyNewRowOnEscape:true,
      clearCellSelectionOnBackgroundClick: true,
      emptyText: 'No constraints are visible for this resource.',
      getRowClass: ({ row }) => row.isUncommitted ? 'schema-row-uncommitted' : '',
    });
    this.readonlyConstraintGridProvider = new AgridProvider<SchemaConstraintRow>({
      columns: constraintColumns,
      datasource: this.constraintDatasource,
      control: new AgridControl(),
      readonly: true,
      showToolbar: false,
      enableRowMarking: false,
      enableColumnMarking: false,
      hideGridStatusBar: true,
      removeEmptyNewRowOnEscape:true,
      clearCellSelectionOnBackgroundClick: true,
      emptyText: 'No constraints are visible for this resource.',
      getRowClass: ({ row }) => row.isUncommitted ? 'schema-row-uncommitted' : '',
    });
    effect(() => this.fieldDatasource.setData(this.displayFields()));
    effect(() => {
      const columns = this.makeFieldColumns();
      this.editableFieldGridProvider.columns.set(columns);
      this.readonlyFieldGridProvider.columns.set(columns);
    });
    effect(() => this.constraintDatasource.setData(this.displayConstraints()));
    effect(() => this.editableConstraintGridProvider.columns.set(this.makeConstraintColumns()));
    effect(() => {
      const row = this.foreignKeyEditor.row();
      if (row && row !== this.initializedForeignKeyRow) {
        this.initializedForeignKeyRow = row;
        this.initializeForeignKeyEditor(row, this.currentTemporaryShadow()?.foreignKeyEditor ?? null);
      } else if (!row) {
        this.initializedForeignKeyRow = null;
      }
    });
    effect(() => {
      const [params, query] = this.routeState();
      const connection = this.connections.activeConnection();
      const table = params.get('tableName');
      const schema = query.get('schema') ?? 'public';
      const nextDraftKey = connection && table
        ? tableSchemaShadowKey(connection.connectionId, schema, table)
        : null;
      const version = ++this.requestVersion;

      if (this.activeSchemaDraftKey && this.activeSchemaDraftKey !== nextDraftKey) {
        this.persistTemporaryDraft(this.activeSchemaDraftKey);
        this.foreignKeyEditor.close();
        this.checkConstraintEditor.close();
        this.primaryKeyEditor.close();
        this.resetForeignKeyEditor();
      }
      this.activeSchemaDraftKey = nextDraftKey;

      this.snapshot.set(null);
      this.error.set(null);
      if (!connection || !table) {
        this.loading.set(false);
        return;
      }

      this.workspacePages.registerOpenedTableSchema(connection.connectionId, schema, table);
      this.loading.set(true);
      void this.connections.inspectTable(connection.connectionId, schema, table)
        .then((snapshot) => {
          if (version === this.requestVersion) {
            this.snapshot.set(snapshot);
            const savedEditor = this.currentTemporaryShadow()?.foreignKeyEditor;
            if (savedEditor) this.foreignKeyEditor.open(savedEditor.row);
            this.fieldDatasource.setData(this.displayFields());
            this.constraintDatasource.setData(this.displayConstraints());
            if (this.activeSchemaDraftKey) this.persistTemporaryDraft(this.activeSchemaDraftKey);
          }
        })
        .catch((error: unknown) => {
          if (version === this.requestVersion) {
            this.error.set(error instanceof Error ? error.message : 'Unable to load table structure.');
          }
        })
        .finally(() => {
          if (version === this.requestVersion) this.loading.set(false);
        });
    });
    this.destroyRef.onDestroy(() => {
      if (this.activeSchemaDraftKey) this.persistTemporaryDraft(this.activeSchemaDraftKey);
    });
  }

  /** Initializes a new field row with adapter-provided defaults before editing. */
  prepareFieldDraft(event: NewRecord<SchemaFieldRow>): void {
    const dataType = this.snapshot()?.editableFieldTypes[0]?.value ?? '';
    event.datasource.updateRow(event.index, {
      ...event.data,
      sourceName: null,
      operationName: null,
      canEdit: true,
      name: '',
      dataType,
      canEditIdentity: this.identityGenerationAllowed(dataType),
      typeDetails: '',
      nullable: true,
      defaultValue: '—',
      defaultPreset: '',
      defaultPresetOptions: this.defaultPresetsFor(dataType),
      identityGeneration: 'none',
      isUncommitted: false,
      isGridInput: true,
      editedFields: [],
      status: 'FILL NAME + TYPE',
    });
    this.persistActiveShadow();
    this.stageError.set(null);
  }

  /** Opens the inline table rename editor using the current table name. */
  beginTableRename(): void {
    const table = this.snapshot();
    if (!table || !this.canRenameTable()) return;
    this.tableNameDraft.set(table.name);
    this.tableRenameError.set(null);
    this.renamingTable.set(true);
    this.stageError.set(null);
  }

  /** Cancels the inline rename editor without changing the staged schema. */
  cancelTableRename(): void {
    if (this.stagingField()) return;
    this.renamingTable.set(false);
    this.tableRenameError.set(null);
  }

  /** Stages a table rename as a separate runbook lifecycle operation. */
  async stageTableRename(): Promise<void> {
    const table = this.snapshot();
    const connection = this.connections.activeConnection();
    const newName = this.tableNameDraft().trim();
    if (!table || !connection || !newName || newName === table.name) return;
    this.stagingField.set(true);
    this.tableRenameError.set(null);
    this.stageError.set(null);
    try {
      await this.runbook.stageTableOperation(connection, table, { kind: 'renameTable', newName });
      this.renamingTable.set(false);
    } catch (error) {
      this.tableRenameError.set(error instanceof Error ? error.message : 'Unable to stage this table rename.');
    } finally {
      this.stagingField.set(false);
    }
  }

  /** Stages a table drop after a user-facing warning confirmation. */
  async stageTableDrop(): Promise<void> {
    const table = this.snapshot();
    const connection = this.connections.activeConnection();
    if (!table || !connection || !this.canDropTable()) return;
    this.stagingField.set(true);
    this.stageError.set(null);
    try {
      await this.runbook.stageTableOperation(connection, table, { kind: 'dropTable' });
    } catch (error) {
      this.stageError.set(error instanceof Error ? error.message : 'Unable to stage this table drop.');
    } finally {
      this.stagingField.set(false);
    }
  }

  /** Discards a pending rename/drop operation and reloads its source snapshot. */
  async cancelTableOperation(): Promise<void> {
    try {
      await this.runbook.discardPending();
      this.stageError.set(null);
    } catch (error) {
      this.stageError.set(error instanceof Error ? error.message : 'Unable to cancel this table action.');
    }
  }

  /** Opens the table's read-only data browser in a workspace page. */
  openDataView(): void {
    const connection = this.connections.activeConnection();
    const table = this.snapshot();
    if (connection && table && (table.canBrowseData ?? connection.capabilities.browseData)) {
      this.workspacePages.openTableData(connection.connectionId, table.schema, table.name);
    }
  }

  /** Reports field-edit permission while keeping older adapter snapshots compatible with canAlter. */
  canEditFields(): boolean {
    const table = this.snapshot();
    return table?.canEditFields ?? table?.canAlter ?? false;
  }

  /** Reports constraint-edit permission while keeping older adapter snapshots compatible with canAlter. */
  canEditConstraints(): boolean {
    const table = this.snapshot();
    return table?.canEditConstraints ?? table?.canAlter ?? false;
  }

  /** Reports table rename permission, falling back to the legacy broad capability. */
  canRenameTable(): boolean {
    const table = this.snapshot();
    return table?.canRenameTable ?? table?.canAlter ?? false;
  }

  /** Reports table drop permission, falling back to the legacy broad capability. */
  canDropTable(): boolean {
    const table = this.snapshot();
    return table?.canDropTable ?? table?.canAlter ?? false;
  }

  /** Reports whether this adapter permits a table lifecycle operation. */
  canStageTableOperations(): boolean {
    return this.canRenameTable() || this.canDropTable();
  }

  /** Reports any schema capability surfaced by the current adapter. */
  canStageSchemaOperations(): boolean {
    return this.canEditFields() || this.canEditConstraints() || this.canStageTableOperations();
  }

  /** Prepares a constraint row with stable draft metadata for grid editing. */
  prepareConstraintDraft(event: NewRecord<SchemaConstraintRow>): void {
    const firstKind = this.snapshot()?.editableConstraintKinds[0]?.value ?? 'unique';
    event.datasource.updateRow(event.index, {
      ...event.data,
      sourceName: null,
      operationName: null,
      isUncommitted: false,
      isGridInput: true,
      kind: firstKind,
      name: '',
      fields: '',
      definition: '',
      references: '',
      canDrop: false,
      drop: false,
      status: 'FILL NAME + FIELDS / EXPRESSION',
    });
    this.persistActiveShadow();
    this.stageError.set(null);
  }

  /** Applies one field-cell edit to the local row while retaining staged changes. */
  onFieldCellEdit(event: GridEditEvent<SchemaFieldRow>): void {
    if (!['name', 'dataType', 'typeDetails', 'defaultValue', 'defaultPreset', 'nullable', 'identityGeneration'].includes(event.field)) return;
    const row = this.fieldDatasource.rows()[event.position.rowIndex];
    if (!row || (event.field === 'identityGeneration'
      ? !row.canEditIdentity
      : !row.isGridInput && !row.isUncommitted && !row.canEdit)) return;
    this.stageError.set(null);
    const presetValue = event.field === 'defaultPreset' ? String(event.newValue ?? '') : null;
    const defaultValue = event.field === 'defaultPreset' ? (presetValue || '—') : row.defaultValue;
    const editedField = event.field === 'defaultPreset' ? 'defaultValue' : event.field;
    const editedFields = [...new Set([...row.editedFields, editedField])];
    this.fieldDatasource.patchRow(event.position.rowIndex, {
      ...(event.field === 'defaultPreset'
        ? { defaultValue, defaultPreset: presetValue ?? '' }
        : event.field === 'defaultValue' ? { defaultPreset: '' }
          : event.field === 'dataType' ? { defaultPresetOptions: this.defaultPresetsFor(String(event.newValue ?? '')) }
            : {}),
      editedFields,
      canEditIdentity: event.field === 'dataType' && (row.isGridInput || row.canEdit)
        ? this.identityGenerationAllowed(row.dataType)
        : row.canEditIdentity,
      status: editedFields.includes('identityGeneration') || editedFields.includes('defaultValue')
        || (editedFields.includes('name') && editedFields.includes('dataType'))
        ? 'READY TO STAGE'
        : 'FILL NAME + TYPE',
    });
    this.persistActiveShadow();
  }

  /** Converts a completed field row edit into an adapter previewed runbook draft. */
  onFieldRecordEdit(event: RecordEditEvent<SchemaFieldRow>): void {
    const row = event.data;
    if (!row.isGridInput && !row.isUncommitted && !row.editedFields.length) return;
    const key = row.sourceName ?? row.operationName ?? (row.isGridInput ? 'new-field' : row.name);
    this.queuedFieldDrafts.set(key, row);
    this.persistActiveShadow();
    if (!this.processingFieldDrafts) void this.flushFieldDrafts();
  }

  /** Clears a removed unfinished field row from the table shadow. */
  onFieldRowRemoved(event: RecordEditEvent<SchemaFieldRow>): void {
    if (event.data.isGridInput) this.persistTemporaryDraft(this.activeSchemaDraftKey, true, false);
  }

  /** Applies one constraint-cell edit and synchronizes the foreign-key sidebar. */
  onConstraintCellEdit(event: GridEditEvent<SchemaConstraintRow>): void {
    if (!['kind', 'name', 'fields'].includes(event.field)) return;
    const row = this.constraintDatasource.rows()[event.position.rowIndex];
    if (!row) return;
    if (event.field === 'kind' && !['primaryKey', 'Primary key'].includes(String(event.newValue))) {
      this.closePrimaryKeyEditorFor(row);
    }
    this.stageError.set(null);
    if (row.isGridInput || (row.sourceName === null && row.isUncommitted)) {
      const kind = event.field === 'kind' ? String(event.newValue) : row.kind;
      const updated = {
        ...row,
        kind,
        name: event.field === 'name' ? String(event.newValue ?? '') : row.name,
        fields: event.field === 'fields' ? String(event.newValue ?? '') : row.fields,
        status: (event.field === 'name' ? String(event.newValue ?? '') : row.name).trim()
          && (event.field === 'fields' ? String(event.newValue ?? '') : row.fields).trim()
          && (kind !== 'foreignKey' || row.references.trim()) ? 'READY TO STAGE' : 'FILL REQUIRED FIELDS',
      };
      this.constraintDatasource.patchRow(event.position.rowIndex, updated);
      const checkRow = this.checkConstraintEditor.row();
      if (checkRow && this.sameConstraintEditorRow(checkRow, row)) this.checkConstraintEditor.open(updated);
      const primaryKeyRow = this.primaryKeyEditor.row();
      if (primaryKeyRow && this.sameConstraintEditorRow(primaryKeyRow, row)) this.primaryKeyEditor.open(updated);
      this.persistActiveShadow();
    }
  }

  /** Stages a completed constraint row or reports why it is not ready. */
  onConstraintRecordEdit(event: RecordEditEvent<SchemaConstraintRow>): void {
    const row = event.data;
    if (this.checkConstraintEditor.row() && this.sameConstraintEditorRow(this.checkConstraintEditor.row()!, row)) {
      this.checkConstraintEditor.open(row);
    }
    if (this.primaryKeyEditor.row() && this.sameConstraintEditorRow(this.primaryKeyEditor.row()!, row)) {
      this.primaryKeyEditor.open(row);
    }
    this.persistActiveShadow();
    if (row.isGridInput) {
      if (row.name.trim() && row.fields.trim() && (row.kind !== 'foreignKey' || row.references.trim())) {
        void this.stageConstraint(row);
      }
      return;
    }
    if (row.isUncommitted || row.drop !== this.isConstraintDropped(row.sourceName)) {
      void this.stageConstraint(row);
    }
  }

  /** Turns removal of an existing grid row into a staged constraint-drop operation. */
  onConstraintRowRemoved(event: RecordEditEvent<SchemaConstraintRow>): void {
    const row = event.data;
    this.closeForeignKeyEditorFor(row);
    this.closeCheckConstraintEditorFor(row);
    this.closePrimaryKeyEditorFor(row);
    if (row.isGridInput) {
      this.persistTemporaryDraft(this.activeSchemaDraftKey, false, true);
      return;
    }

    if (row.sourceName !== null && !row.canDrop) {
      this.stageError.set('This constraint cannot be removed with the current database adapter.');
      this.constraintDatasource.setData(this.displayConstraints());
      return;
    }

    const connection = this.connections.activeConnection();
    const snapshot = this.snapshot();
    if (!connection || !snapshot || !this.canEditConstraints()) {
      this.constraintDatasource.setData(this.displayConstraints());
      return;
    }

    this.stageError.set(null);
    const remove = row.sourceName !== null
      ? this.stageConstraint({ ...row, drop: !row.drop })
      : row.isUncommitted
        ? this.runbook.stageSchemaOperation(connection, snapshot, null, row.operationName ?? row.name)
        : Promise.resolve();
    void remove
      .catch((error: unknown) => {
        this.stageError.set(error instanceof Error ? error.message : 'Unable to remove this constraint.');
      })
      .finally(() => this.constraintDatasource.setData(this.displayConstraints()));
  }

  /** Closes the reference sidebar when its constraint is removed or changed away. */
  private closeForeignKeyEditorFor(row: SchemaConstraintRow): void {
    const editing = this.foreignKeyEditor.row();
    if (!editing) return;
    const matches = row.sourceName !== null
      ? editing.sourceName === row.sourceName
      : editing.sourceName === null
        && (editing.operationName ?? editing.name) === (row.operationName ?? row.name);
    if (matches) this.foreignKeyEditor.close();
  }

  /** Closes the CHECK helper when its constraint row is removed. */
  private closeCheckConstraintEditorFor(row: SchemaConstraintRow): void {
    const editing = this.checkConstraintEditor.row();
    if (!editing) return;
    const matches = row.sourceName !== null
      ? editing.sourceName === row.sourceName
      : editing.sourceName === null
        && (editing.operationName ?? editing.name) === (row.operationName ?? row.name);
    if (matches) this.checkConstraintEditor.close();
  }

  /** Closes the primary-key picker when its constraint row is removed or changed. */
  private closePrimaryKeyEditorFor(row: SchemaConstraintRow): void {
    const editing = this.primaryKeyEditor.row();
    if (!editing) return;
    const matches = editing.isGridInput
      ? row.isGridInput
      : row.sourceName !== null
        ? editing.sourceName === row.sourceName
        : editing.sourceName === null
          && (editing.operationName ?? editing.name) === (row.operationName ?? row.name);
    if (matches) this.primaryKeyEditor.close();
  }

  /** Adds or removes a field while retaining its selected composite-key order. */
  togglePrimaryKeyField(fieldName: string, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    const selected = this.primaryKeySelectedFields();
    const next = checked
      ? selected.includes(fieldName) ? selected : [...selected, fieldName]
      : selected.filter((name) => name !== fieldName);
    this.updatePrimaryKeyFields(next);
  }

  /** Changes the order of fields in a composite primary key. */
  movePrimaryKeyField(fieldName: string, offset: -1 | 1): void {
    const selected = this.primaryKeySelectedFields();
    const index = selected.indexOf(fieldName);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= selected.length) return;
    const next = [...selected];
    [next[index], next[target]] = [next[target], next[index]];
    this.updatePrimaryKeyFields(next);
  }

  /** Suggests a primary-key name from its first ordered field while the name is blank. */
  applyPrimaryKeyNameSuggestion(): void {
    const editorRow = this.primaryKeyEditor.row();
    const name = this.primaryKeyNameSuggestion().trim();
    if (!editorRow || editorRow.name.trim() || !name) return;
    this.applyConstraintNameSuggestion('primaryKey', name);
  }

  /** Writes a CHECK name suggestion selected by the expression helper into the grid row. */
  applyCheckConstraintNameSuggestion(name: string): void {
    const editorRow = this.checkConstraintEditor.row();
    if (!editorRow || editorRow.name.trim() || !name) return;
    this.applyConstraintNameSuggestion('check', name);
  }

  /** Stages the selected primary key through the server preview endpoint. */
  async stagePrimaryKey(): Promise<void> {
    const editorRow = this.primaryKeyEditor.row();
    if (!editorRow || !this.primaryKeySelectedFields().length) return;
    const row = this.findPrimaryKeyDatasourceRow(editorRow);
    if (row) await this.stageConstraint(row);
  }

  /** Writes picker selections into the grid row and immediately preserves the draft. */
  private updatePrimaryKeyFields(fieldNames: string[]): void {
    const editorRow = this.primaryKeyEditor.row();
    if (!editorRow) return;
    const index = this.findPrimaryKeyDatasourceIndex(editorRow);
    if (index < 0) return;
    const row = this.constraintDatasource.rows()[index];
    const updated = {
      ...row,
      fields: formatFieldNames(fieldNames),
      status: row.name.trim() && fieldNames.length ? 'READY TO STAGE' : 'FILL REQUIRED FIELDS',
    };
    this.constraintDatasource.updateRow(index, updated);
    this.primaryKeyEditor.open(updated);
    this.persistActiveShadow();
    this.stageError.set(null);
  }

  /** Gets the selected primary-key row from the current constraint datasource. */
  private findPrimaryKeyDatasourceRow(editorRow: { sourceName: string | null; operationName: string | null; name: string; isGridInput: boolean }): SchemaConstraintRow | null {
    return this.constraintDatasource.rows()[this.findPrimaryKeyDatasourceIndex(editorRow)] ?? null;
  }

  /** Resolves the primary-key editor row by stable operation identity. */
  private findPrimaryKeyDatasourceIndex(editorRow: { sourceName: string | null; operationName: string | null; name: string; isGridInput: boolean }): number {
    return this.constraintDatasource.rows().findIndex((row) => editorRow.isGridInput
      ? row.isGridInput && ['primaryKey', 'Primary key'].includes(row.kind)
      : row.sourceName === editorRow.sourceName
        && (row.operationName ?? row.name) === (editorRow.operationName ?? editorRow.name));
  }

  /** Writes a suggested name to the matching helper row and preserves the updated draft. */
  private applyConstraintNameSuggestion(kind: 'check' | 'primaryKey', name: string): void {
    const editorRow = kind === 'check' ? this.checkConstraintEditor.row() : this.primaryKeyEditor.row();
    if (!editorRow || editorRow.name.trim()) return;
    const index = this.constraintDatasource.rows().findIndex((row) => editorRow.isGridInput
      ? row.isGridInput && row.kind === kind
      : row.sourceName === editorRow.sourceName
        && (row.operationName ?? row.name) === (editorRow.operationName ?? editorRow.name));
    if (index < 0) return;
    const row = this.constraintDatasource.rows()[index];
    const updated = {
      ...row,
      name,
      status: row.fields.trim() ? 'READY TO STAGE' : 'FILL REQUIRED FIELDS',
    };
    this.constraintDatasource.updateRow(index, updated);
    if (kind === 'check') this.checkConstraintEditor.open(updated);
    else this.primaryKeyEditor.open(updated);
    this.persistActiveShadow();
    this.stageError.set(null);
  }

  /** Checks whether a helper still refers to the grid row being edited. */
  private sameConstraintEditorRow(
    editorRow: { sourceName: string | null; operationName: string | null; name: string; isGridInput: boolean },
    row: SchemaConstraintRow,
  ): boolean {
    return editorRow.isGridInput
      ? row.isGridInput
      : editorRow.sourceName === row.sourceName
        && (editorRow.operationName ?? editorRow.name) === (row.operationName ?? row.name);
  }

  /** Validates and previews a primary, unique, check, or foreign-key constraint draft. */
  private async stageConstraint(row: SchemaConstraintRow): Promise<void> {
    const connection = this.connections.activeConnection();
    const snapshot = this.snapshot();
    if (this.stagingField() || !connection || !snapshot || !this.canEditConstraints()) return;
    let operation: Extract<SchemaOperation, { kind: 'addConstraint' | 'dropConstraint' }> | null = null;
    const replacementName = row.sourceName ?? row.operationName ?? row.name.trim();
    const isDraftAdd = row.isGridInput || (row.sourceName === null && row.isUncommitted);

    if (isDraftAdd) {
      if (!row.name.trim() || !row.fields.trim() || (row.kind === 'foreignKey' && !row.references.trim())) {
        this.stageError.set(row.kind === 'check'
          ? 'Enter a constraint name and a CHECK expression, such as quantity > 0.'
          : row.kind === 'foreignKey'
            ? 'Enter the constraint name, local fields, and a target such as public.users(id).'
            : 'Enter a constraint name and at least one field. Separate multiple fields with commas.');
        return;
      }
      if (!snapshot.editableConstraintKinds.some(({ value }) => value === row.kind)) {
        this.stageError.set('Choose a constraint type supported by the connected database.');
        return;
      }
      if (row.kind === 'check') {
        operation = {
          kind: 'addConstraint',
          constraintKind: 'check',
          name: row.name.trim(),
          expression: row.fields.trim(),
        };
      } else {
        let fieldNames: string[];
        try {
          fieldNames = parseFieldNames(row.fields);
        } catch (error) {
          this.stageError.set(error instanceof Error ? error.message : 'Check the constraint field names.');
          return;
        }
        if (!fieldNames.length) {
          this.stageError.set('Enter at least one field for this constraint.');
          return;
        }
        if (row.kind === 'foreignKey') {
          try {
            operation = { kind: 'addConstraint', constraintKind: 'foreignKey', name: row.name.trim(), fieldNames,
              ...parseForeignKeyReference(row.references) };
          } catch (error) {
            this.stageError.set(error instanceof Error ? error.message : 'Enter a target such as public.users(id).');
            return;
          }
        } else {
          operation = {
            kind: 'addConstraint',
            constraintKind: row.kind as Exclude<EditableConstraintKind, 'check' | 'foreignKey'>,
            name: row.name.trim(),
            fieldNames,
          };
        }
      }
    } else if (row.sourceName !== null && row.drop) {
      operation = { kind: 'dropConstraint', name: row.sourceName };
    }

    this.stageError.set(null);
    this.stagingField.set(true);
    try {
      await this.runbook.stageSchemaOperation(connection, snapshot, operation, replacementName);
      if (row.isGridInput) {
        this.constraintDatasource.setData(this.displayConstraints());
        this.persistTemporaryDraft(this.activeSchemaDraftKey, false, true);
      } else {
        this.constraintDatasource.setData(this.displayConstraints());
        this.persistActiveShadow();
      }
      this.checkConstraintEditor.close();
      this.primaryKeyEditor.close();
    } catch (error) {
      this.stageError.set(error instanceof Error ? error.message : 'Unable to stage this constraint.');
      if (row.isGridInput) {
        this.setConstraintDraftStatus(row, 'INVALID');
        this.persistActiveShadow();
      }
    } finally {
      this.stagingField.set(false);
    }
  }

  /** Updates the transient status cell for a constraint draft. */
  private setConstraintDraftStatus(row: SchemaConstraintRow, status: string): void {
    const rowIndex = this.constraintDatasource.rows().findIndex((candidate) =>
      candidate.isGridInput && candidate.name === row.name && candidate.fields === row.fields);
    if (rowIndex >= 0) this.constraintDatasource.patchRow(rowIndex, { status });
  }

  /** Persists pending row edits before a schema refresh or navigation. */
  private async flushFieldDrafts(): Promise<void> {
    if (this.processingFieldDrafts) return;
    this.processingFieldDrafts = true;
    try {
      while (this.queuedFieldDrafts.size) {
        const [key, row] = this.queuedFieldDrafts.entries().next().value as [string, SchemaFieldRow];
        this.queuedFieldDrafts.delete(key);
        await this.stageGridField(row);
      }
    } finally {
      this.processingFieldDrafts = false;
      if (this.queuedFieldDrafts.size) void this.flushFieldDrafts();
    }
  }

  /** Sends the edited field through the server draft-preview endpoint. */
  private async stageGridField(row: SchemaFieldRow): Promise<void> {
    const connection = this.connections.activeConnection();
    const snapshot = this.snapshot();
    this.stageError.set(null);
    if (!connection || !snapshot || !this.canEditFields()) return;
    this.stagingField.set(true);
    try {
      const draft: SchemaFieldDraftRequest['draft'] = {
        sourceName: row.sourceName,
        name: row.name,
        type: row.dataType,
        typeDetails: row.typeDetails,
        defaultValue: row.defaultValue,
        nullable: row.nullable,
        identityGeneration: row.identityGeneration,
      };
      await this.runbook.stageSchemaFieldDraft(connection, snapshot, draft, row.operationName ?? row.sourceName ?? row.name);
      if (row.isGridInput) {
        this.fieldDatasource.setData(this.displayFields());
        this.persistTemporaryDraft(this.activeSchemaDraftKey, true, false);
      } else {
        this.fieldDatasource.setData(this.displayFields());
        this.persistActiveShadow();
      }
    } catch (error) {
      this.stageError.set(error instanceof Error ? error.message : 'Unable to stage this field.');
    } finally {
      this.stagingField.set(false);
    }
  }

  /** Defines editable field columns and their adapter-aware grid renderers. */
  private makeFieldColumns(): ColDef<SchemaFieldRow>[] {
    return [
      {
        field: 'name', header: 'Name', width: 220, editable: true,
        cellReadonly: (params: CellReadonlyParams<SchemaFieldRow>) => !params.row.isGridInput && !params.row.canEdit,
      },
      {
        field: 'dataType', header: 'Type', width: 210, editable: true,
        values: this.fieldTypeOptions(),
        cellReadonly: (params: CellReadonlyParams<SchemaFieldRow>) => !params.row.isGridInput && !params.row.canEdit,
      },
      { field: 'typeDetails', header: 'Size / precision', width: 130, editable: true,
        cellReadonly: (params: CellReadonlyParams<SchemaFieldRow>) => !params.row.isGridInput && !params.row.canEdit },
      { field: 'typeIdentity', header: 'Type schema', width: 160, editable: false, locked: true },
      {
        field: 'nullable', header: 'Nullable', width: 105, type: 'boolean', editable: true,
        cellReadonly: (params: CellReadonlyParams<SchemaFieldRow>) => params.row.sourceName === null || !params.row.canEdit,
      },
      {
        field: 'identityGeneration', header: 'Identity', width: 190, editable: true,
        values: this.snapshot()?.editableIdentityGenerations ?? [],
        cellReadonly: ({ row }: CellReadonlyParams<SchemaFieldRow>) => !row.canEditIdentity,
        cellRendererComponent: SchemaBadgeCellComponent,
      },
      { field: 'defaultValue', header: 'Default', width: 260, editable: true,
        cellReadonly: (params: CellReadonlyParams<SchemaFieldRow>) => !params.row.isGridInput && !params.row.canEdit },
      {
        field: 'defaultPreset', header: 'Default preset', width: 200, editable: true,
        cellEditor: DefaultPresetEditorComponent,
        cellReadonly: ({ row }: CellReadonlyParams<SchemaFieldRow>) => !row.isGridInput && !row.canEdit,
      },
      { field: 'status', header: 'Status', width: 190, cellRendererComponent: SchemaBadgeCellComponent, editable: false, locked: true },
    ];
  }

  /** Defines constraint columns and the helper actions shown in the schema grid. */
  private makeConstraintColumns(): ColDef<SchemaConstraintRow>[] {
    return [
      {
        field: 'kind', header: 'Kind', width: 150, editable: true,
        values: this.snapshot()?.editableConstraintKinds ?? [],
        cellReadonly: ({ row }: CellReadonlyParams<SchemaConstraintRow>) => row.sourceName !== null,
        cellRendererComponent: SchemaBadgeCellComponent,
      },
      { field: 'name', header: 'Name', width: 220, editable: true, cellReadonly: ({ row }: CellReadonlyParams<SchemaConstraintRow>) => row.sourceName !== null },
      { field: 'fields', header: 'Fields / CHECK expression', width: 290, editable: true, cellReadonly: ({ row }: CellReadonlyParams<SchemaConstraintRow>) => row.sourceName !== null },
      { field: 'definition', header: 'Definition', width: 300, editable: false, locked: true },
      {
        field: 'checkHelp', header: 'CHECK helper', width: 145, editable: false,
        cellRendererComponent: CheckConstraintHelpCellComponent,
      },
      {
        field: 'primaryKeyHelp', header: 'Primary key fields', width: 150, editable: false,
        cellRendererComponent: PrimaryKeyFieldsCellComponent,
      },
      {
        field: 'references', header: 'Reference', width: 290, editable: false,
        cellRendererComponent: ForeignKeyReferenceCellComponent,
      },
      { field: 'status', header: 'Status', width: 150, cellRendererComponent: SchemaBadgeCellComponent, editable: false, locked: true },
    ];
  }

  /** Updates the selected referenced table and fetches its compatible key choices. */
  async onForeignKeyTargetChanged(event: Event): Promise<void> {
    const target = (event.target as HTMLSelectElement).value;
    const [schema = '', table = ''] = target.split('\u0000');
    this.foreignKeyTargetSchema.set(schema);
    this.foreignKeyTargetTable.set(table);
    await this.loadForeignKeyTargetSets();
  }

  /** Updates one selected source field and refreshes target compatibility results. */
  async onForeignKeyLocalFieldChanged(field: string, event: Event): Promise<void> {
    const checked = (event.target as HTMLInputElement).checked;
    const fields = this.foreignKeyLocalFields();
    this.foreignKeyLocalFields.set(checked ? [...fields, field] : fields.filter((value) => value !== field));
    await this.loadForeignKeyTargetSets();
  }

  /** Loads adapter-validated referenced key sets for the selected tables and fields. */
  async loadForeignKeyTargetSets(): Promise<void> {
    const row = this.foreignKeyEditor.row();
    const connection = this.connections.activeConnection();
    const snapshot = this.snapshot();
    const localFieldNames = this.foreignKeyLocalFields();
    const targetSchema = this.foreignKeyTargetSchema();
    const targetTable = this.foreignKeyTargetTable();
    this.foreignKeyTargetSets.set([]);
    this.foreignKeyEditorError.set(null);
    if (!row || !connection || !snapshot || !localFieldNames.length || !targetSchema || !targetTable) return;
    this.foreignKeyEditorLoading.set(true);
    try {
      const result = await this.connections.foreignKeyFieldChoices(
        connection.connectionId, snapshot.schema, snapshot.name, targetSchema, targetTable, localFieldNames,
      );
      this.foreignKeyTargetSets.set(result.fieldSets);
      const previous = this.foreignKeySelectedSet();
      const selected = result.fieldSets.find(({ fieldNames, compatible }) =>
        compatible && fieldNames.join('\u0000') === previous)
        ?? result.fieldSets.find(({ compatible }) => compatible)
        ?? result.fieldSets.find(({ fieldNames }) => fieldNames.join('\u0000') === previous)
        ?? result.fieldSets[0];
      this.foreignKeySelectedSet.set(selected?.fieldNames.join('\u0000') ?? '');
      if (!result.fieldSets.length) {
        this.foreignKeyEditorError.set('The target table has no primary or unique key available to reference.');
      }
    } catch (error) {
      this.foreignKeyEditorError.set(error instanceof Error ? error.message : 'Unable to load compatible referenced fields.');
    } finally {
      this.foreignKeyEditorLoading.set(false);
    }
  }

  /** Restores target table and field selections when opening an existing foreign key. */
  private initializeForeignKeyEditor(row: ForeignKeyEditorRow, saved: TemporaryForeignKeyEditor | null = null): void {
    this.foreignKeyEditorError.set(null);
    this.foreignKeyEditorName.set(saved?.name ?? row.name);
    const parsedLocal = saved?.localFields ?? (row.fields === '—' ? [] : safeParseFieldNames(row.fields));
    this.foreignKeyLocalFields.set(parsedLocal);
    const parsedReference = row.references === '—' ? null : safeParseForeignKeyReference(row.references);
    const targetSchema = saved?.targetSchema ?? parsedReference?.referencedSchema ?? '';
    const targetTable = saved?.targetTable ?? parsedReference?.referencedTable ?? '';
    this.foreignKeyTargetSchema.set(targetSchema);
    this.foreignKeyTargetTable.set(targetTable);
    this.foreignKeySelectedSet.set(saved?.selectedTargetSet ?? '');
    if (targetSchema && targetTable) void this.loadForeignKeyTargetSets().then(() => {
      const current = saved?.selectedTargetSet || parsedReference?.referencedFieldNames.join('\u0000');
      if (current && this.foreignKeyTargetSets().some(({ fieldNames }) => fieldNames.join('\u0000') === current)) {
        this.foreignKeySelectedSet.set(current);
      }
    });
  }

  /** Saves the sidebar's selected referenced key as a staged foreign-key operation. */
  async saveForeignKeyReference(): Promise<void> {
    const row = this.foreignKeyEditor.row();
    const connection = this.connections.activeConnection();
    const snapshot = this.snapshot();
    const selected = this.foreignKeySelectedSet();
    const selectedTarget = this.foreignKeyTargetSets().find(({ fieldNames }) => fieldNames.join('\u0000') === selected);
    const referencedFieldNames = selectedTarget?.fieldNames;
    if (!row || !connection || !snapshot || !this.foreignKeyLocalFields().length || !selectedTarget?.compatible || !referencedFieldNames) return;
    const name = this.foreignKeyEditorName().trim();
    const operation = {
      kind: 'addConstraint' as const,
      constraintKind: 'foreignKey' as const,
      name,
      fieldNames: this.foreignKeyLocalFields(),
      referencedSchema: this.foreignKeyTargetSchema(),
      referencedTable: this.foreignKeyTargetTable(),
      referencedFieldNames,
    };
    this.stagingField.set(true);
    this.foreignKeyEditorError.set(null);
    try {
      const replacements = row.sourceName
        ? [{ kind: 'dropConstraint' as const, name: row.sourceName }, operation]
        : [operation];
      await this.runbook.stageSchemaOperations(connection, snapshot, replacements, [row.sourceName ?? name]);
      this.clearTemporaryForeignKeyEditor();
      if (row.sourceName === null && row.operationName === null) this.clearTemporaryConstraintRow();
      this.foreignKeyEditor.close();
      this.resetForeignKeyEditor();
    } catch (error) {
      this.foreignKeyEditorError.set(error instanceof Error ? error.message : 'Unable to stage this foreign key.');
    } finally {
      this.stagingField.set(false);
    }
  }

  /** Copies a helper expression into the selected grid row and runs the normal adapter preview. */
  applyCheckExpression(expression: string): void {
    const editorRow = this.checkConstraintEditor.row();
    if (!editorRow) return;
    const rows = this.constraintDatasource.rows();
    const index = rows.findIndex((candidate) => candidate.isGridInput
      ? editorRow.isGridInput && candidate.kind === editorRow.kind
      : candidate.sourceName === editorRow.sourceName
        && candidate.operationName === editorRow.operationName
        && candidate.name === editorRow.name);
    if (index < 0) {
      this.checkConstraintEditor.close();
      return;
    }
    const row = rows[index];
    const updated: SchemaConstraintRow = {
      ...row,
      fields: expression,
      status: row.name.trim() ? 'READY TO STAGE' : 'ADD CONSTRAINT NAME',
    };
    this.constraintDatasource.updateRow(index, updated);
    void this.stageConstraint(updated);
  }

  /** Canonicalizes a field type for identity-generation capability lookup. */
  private typeIdentity(snapshot: TableSnapshot, type: string): string {
    const descriptor = snapshot.editableFieldTypes.find((item) => item.value === type);
    return descriptor ? `${descriptor.typeSchema}.${descriptor.typeName}` : type;
  }

  /** Checks whether the active adapter supports identity generation for a field type. */
  private identityGenerationAllowed(type: string): boolean {
    return this.snapshot()?.editableFieldTypes.find((item) => item.value === type)?.identityGenerationSupported ?? false;
  }

  /** Selects a known preset when a live or staged default exactly matches one. */
  private matchingDefaultPreset(type: string | null, expression: string | null): string {
    if (!type || !expression) return '';
    return this.snapshot()?.editableFieldTypes
      .find((item) => item.value === type)?.defaultExpressions
      .find((preset) => preset.value === expression)?.value ?? '';
  }

  /** Returns adapter default suggestions for a field type. */
  private defaultPresetsFor(type: string): { value: string; label: string }[] {
    return this.snapshot()?.editableFieldTypes.find((item) => item.value === type)?.defaultExpressions ?? [];
  }

  /** Merges baseline constraints with staged edits into grid display rows. */
  private toDisplayConstraints(): SchemaConstraintRow[] {
    const table = this.snapshot();
    if (!table) return [];
    const rows: SchemaConstraintRow[] = table.constraints.map((constraint) => ({
      sourceName: constraint.name,
      operationName: null,
      isUncommitted: false,
      isGridInput: false,
      kind: this.constraintKindLabel(constraint.kind),
      name: constraint.name,
      fields: formatFieldNames(constraint.fieldNames),
      definition: constraint.definition,
      references: constraint.referencedSchema && constraint.referencedTable
        ? `${constraint.referencedSchema}.${constraint.referencedTable}(${formatFieldNames(constraint.referencedFieldNames)})`
        : '—',
      canDrop: constraint.editable,
      drop: false,
      status: '',
    }));

    const pending = this.runbook.runbook();
    const connection = this.connections.activeConnection();
    if (pending && connection && sameTarget(pending.target, connection.target)) for (const operation of this.runbook.operationsForResource(pending, table.schema, table.name)) {
      if (operation.kind === 'addConstraint') {
        rows.push({
          sourceName: null,
          operationName: operation.name,
          isUncommitted: true,
          isGridInput: false,
          kind: operation.constraintKind,
          name: operation.name,
          fields: operation.constraintKind === 'check' ? operation.expression : formatFieldNames(operation.fieldNames),
          definition: operation.constraintKind === 'check'
            ? `CHECK (${operation.expression})`
            : operation.constraintKind === 'foreignKey'
              ? `FOREIGN KEY (${formatFieldNames(operation.fieldNames)})`
              : `${operation.constraintKind === 'primaryKey' ? 'PRIMARY KEY' : 'UNIQUE'} (${formatFieldNames(operation.fieldNames)})`,
          references: operation.constraintKind === 'foreignKey'
            ? `${operation.referencedSchema}.${operation.referencedTable} (${formatFieldNames(operation.referencedFieldNames)})`
            : '—',
          canDrop: true,
          drop: false,
          status: 'UNCOMMITTED',
        });
      } else if (operation.kind === 'dropConstraint') {
        const row = rows.find(({ sourceName }) => sourceName === operation.name);
        if (row) {
          row.drop = true;
          row.isUncommitted = true;
          row.status = 'DROP PENDING';
        }
      }
    }
    const draft = this.currentTemporaryShadow();
    if (draft?.constraintDraftRow) rows.push(draft.constraintDraftRow as SchemaConstraintRow);
    return rows;
  }

  /** Reads the shadow associated with the currently open table. */
  private currentTemporaryShadow() {
    return this.activeSchemaDraftKey ? this.shadowState.get(this.activeSchemaDraftKey) : null;
  }

  /** Restores the unfinished field input row after the server-backed rows are projected. */
  private appendFieldDraft(fields: SchemaFieldRow[]): SchemaFieldRow[] {
    const row = this.currentTemporaryShadow()?.fieldDraftRow as SchemaFieldRow | null | undefined;
    return row ? [...fields, row] : fields;
  }

  /** Captures current grid rows and their live/draft/staged lifecycle in the application signal. */
  private persistActiveShadow(): void {
    if (this.activeSchemaDraftKey) this.persistTemporaryDraft(this.activeSchemaDraftKey);
  }

  /** Copies both schema grids and helper selections before navigation or component teardown. */
  private persistTemporaryDraft(
    key: string | null,
    clearFieldDraft = false,
    clearConstraintDraft = false,
  ): void {
    if (!key) return;
    const previous = this.shadowState.get(key);
    const fields = this.fieldDatasource.rows();
    const constraints = this.constraintDatasource.rows();
    const row = constraints.find((candidate) => candidate.isGridInput);
    const fieldRow = fields.find((candidate) => candidate.isGridInput);
    const editorRow = this.foreignKeyEditor.row();
    const constraintDraftRow = clearConstraintDraft ? null : row ?? previous?.constraintDraftRow ?? null;
    const fieldDraftRow = clearFieldDraft ? null : fieldRow ?? previous?.fieldDraftRow ?? null;
    const foreignKeyEditor = editorRow ? {
      row: { ...editorRow },
      name: this.foreignKeyEditorName(),
      localFields: [...this.foreignKeyLocalFields()],
      targetSchema: this.foreignKeyTargetSchema(),
      targetTable: this.foreignKeyTargetTable(),
      selectedTargetSet: this.foreignKeySelectedSet(),
    } : previous?.foreignKeyEditor ?? null;
    this.shadowState.save(key, {
      fields: fields.map((value) => ({ status: this.shadowStatus(value), row: value })),
      constraints: constraints.map((value) => ({ status: this.shadowStatus(value), row: value })),
      fieldDraftRow,
      constraintDraftRow,
      foreignKeyEditor,
    });
  }

  /** Maps row flags to the shadow lifecycle labels exposed to application state. */
  private shadowStatus(row: { isGridInput: boolean; isUncommitted: boolean }): 'live' | 'draft' | 'staged' {
    return row.isGridInput ? 'draft' : row.isUncommitted ? 'staged' : 'live';
  }

  /** Removes only the unfinished constraint row while retaining all other shadow data. */
  private clearTemporaryConstraintRow(): void {
    const key = this.activeSchemaDraftKey;
    if (!key) return;
    this.persistTemporaryDraft(key, false, true);
  }

  /** Removes the saved helper state without discarding a separate unfinished grid row. */
  private clearTemporaryForeignKeyEditor(): void {
    const key = this.activeSchemaDraftKey;
    if (!key) return;
    const current = this.shadowState.get(key);
    if (current) this.shadowState.save(key, { ...current, foreignKeyEditor: null });
  }

  /** Resets editor controls after leaving a table so they cannot bleed into another schema. */
  private resetForeignKeyEditor(): void {
    this.foreignKeyLocalFields.set([]);
    this.foreignKeyTargetSchema.set('');
    this.foreignKeyTargetTable.set('');
    this.foreignKeyTargetSets.set([]);
    this.foreignKeySelectedSet.set('');
    this.foreignKeyEditorName.set('');
    this.foreignKeyEditorError.set(null);
  }

  /** Checks whether a baseline constraint has a pending drop operation. */
  private isConstraintDropped(name: string | null): boolean {
    if (!name) return false;
    const pending = this.runbook.runbook();
    const connection = this.connections.activeConnection();
    const table = this.snapshot();
    if (!pending || !connection || !table || !sameTarget(pending.target, connection.target)) return false;
    return this.runbook.operationsForResource(pending, table.schema, table.name).some((operation) =>
      operation.kind === 'dropConstraint' && operation.name === name);
  }

  /** Formats adapter constraint kinds for the schema grid. */
  private constraintKindLabel(kind: TableConstraintDescriptor['kind']): string {
    return this.snapshot()?.editableConstraintKinds.find(({ value }) => value === kind)?.label ?? kind;
  }
}

function sameTarget(left: { adapter: string; host: string; port: number; database: string; username: string },
  right: { adapter: string; host: string; port: number; database: string; username: string }): boolean {
  return left.adapter === right.adapter && left.host === right.host && left.port === right.port
    && left.database === right.database && left.username === right.username;
}

function fieldTypeDetails(operation: Extract<SchemaOperation, { kind: 'addNullableField' | 'alterField' }>): string {
  return operation.typeDetails ?? '';
}

function parseFieldNames(value: string): string[] {
  const names: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"') {
      if (quoted && value[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      if (current.trim()) names.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  if (quoted) throw new Error('Close the quoted field name before staging this constraint.');
  if (current.trim()) names.push(current.trim());
  return names;
}

function safeParseFieldNames(value: string): string[] {
  try { return parseFieldNames(value); } catch { return []; }
}

function parseForeignKeyReference(value: string): {
  referencedSchema: string;
  referencedTable: string;
  referencedFieldNames: string[];
} {
  const open = value.lastIndexOf('(');
  if (open < 1 || !value.trimEnd().endsWith(')')) {
    throw new Error('Use a schema-qualified target such as public.users(id).');
  }
  const target = value.slice(0, open).trim();
  let quoted = false;
  let separator = -1;
  for (let index = 0; index < target.length; index += 1) {
    if (target[index] === '"') {
      if (quoted && target[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (target[index] === '.' && !quoted) {
      if (separator >= 0) throw new Error('Use one schema and one table in the foreign key target.');
      separator = index;
    }
  }
  if (quoted || separator < 1 || separator === target.length - 1) {
    throw new Error('Use a schema-qualified target such as public.users(id).');
  }
  const schemaParts = parseFieldNames(target.slice(0, separator));
  const tableParts = parseFieldNames(target.slice(separator + 1));
  const referencedFieldNames = parseFieldNames(value.slice(open + 1, -1));
  if (schemaParts.length !== 1 || tableParts.length !== 1 || !referencedFieldNames.length) {
    throw new Error('Enter a schema, table, and at least one referenced field.');
  }
  return { referencedSchema: schemaParts[0], referencedTable: tableParts[0], referencedFieldNames };
}

function safeParseForeignKeyReference(value: string): ReturnType<typeof parseForeignKeyReference> | null {
  try { return parseForeignKeyReference(value); } catch { return null; }
}

function formatFieldNames(names: string[]): string {
  return names.map((name) => /[",\s]/.test(name) ? `"${name.replaceAll('"', '""')}"` : name).join(', ');
}
