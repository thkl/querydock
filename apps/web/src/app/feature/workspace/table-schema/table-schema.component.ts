import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { combineLatest } from 'rxjs';
import type {
  EditableConstraintKind,
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
  kind: string;
  name: string;
  fields: string;
  definition: string;
  references: string;
  canDrop: boolean;
  drop: boolean;
  status: string;
}

@Component({
  selector: 'qd-table-schema',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AgridComponent, RouterLink],
  providers: [ForeignKeyEditorState],
  templateUrl: './table-schema.component.html',
  styleUrl: './table-schema.component.css',
})
export class TableSchemaComponent {
  private readonly route = inject(ActivatedRoute);
  private requestVersion = 0;

  readonly connections = inject(ConnectionApiService);
  readonly foreignKeyEditor = inject(ForeignKeyEditorState);
  readonly runbook = inject(RunbookService);
  private readonly workspacePages = inject(WorkspacePagesService);
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
        : field.dataType === 'numeric' && field.numericPrecision !== null
          ? `${field.numericPrecision}${field.numericScale !== null ? `, ${field.numericScale}` : ''}`
          : '',
      typeIdentity: `${field.typeSchema}.${field.typeName}`,
      nullable: field.nullable,
      defaultValue: field.generated
          ? `GENERATED${field.generationExpression ? ` · ${field.generationExpression}` : ''}`
          : field.defaultExpression ?? '—',
      identityGeneration: field.identityGeneration ?? 'none',
      isUncommitted: false,
      isGridInput: false,
      editedFields: [],
      status: '',
    }));

    const pending = this.runbook.runbook();
    const connection = this.connections.activeConnection();
    if (!pending || !connection || !sameTarget(pending.target, connection.target)
      || pending.schema !== table.schema || pending.table !== table.name) return fields;

    for (const operation of pending.operations) {
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
    return fields;
  });
  readonly pendingTableOperation = computed(() => {
    const pending = this.runbook.runbook();
    const table = this.snapshot();
    const connection = this.connections.activeConnection();
    if (!pending || !table || !connection || !sameTarget(pending.target, connection.target)
      || pending.schema !== table.schema || pending.table !== table.name) return null;
    return pending.operations.find((operation) => operation.kind === 'renameTable' || operation.kind === 'dropTable') ?? null;
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
  readonly fieldDatasource = new AgridDataSource<SchemaFieldRow>();
  readonly constraintDatasource = new AgridDataSource<SchemaConstraintRow>();
  readonly editableFieldGridProvider: AgridProvider<SchemaFieldRow>;
  readonly readonlyFieldGridProvider: AgridProvider<SchemaFieldRow>;
  readonly fieldGridProvider = computed(() => this.snapshot()?.canAlter && !this.stagingField()
    ? this.editableFieldGridProvider
    : this.readonlyFieldGridProvider);
  readonly editableConstraintGridProvider: AgridProvider<SchemaConstraintRow>;
  readonly readonlyConstraintGridProvider: AgridProvider<SchemaConstraintRow>;
  readonly constraintGridProvider = computed(() => this.snapshot()?.canAlter
    && Boolean(this.snapshot()?.editableConstraintKinds.length) && !this.stagingField()
    ? this.editableConstraintGridProvider
    : this.readonlyConstraintGridProvider);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly stagingField = signal(false);
  readonly stageError = signal<string | null>(null);
  readonly renamingTable = signal(false);
  readonly tableNameDraft = signal('');
  readonly fieldTypeOptions = computed(() => (this.snapshot()?.editableFieldTypes ?? [])
    .map(({ value, label }) => ({ value, label })));
  readonly foreignKeyTargets = computed(() => this.connections.activeResources()
    .filter(({ kind }) => kind === 'table' || kind === 'partitionedTable'));
  readonly foreignKeyLocalFields = signal<string[]>([]);
  readonly foreignKeyTargetSchema = signal('');
  readonly foreignKeyTargetTable = signal('');
  readonly foreignKeyTargetSets = signal<{ fieldNames: string[]; label: string }[]>([]);
  readonly foreignKeySelectedSet = signal('');
  readonly foreignKeyEditorName = signal('');
  readonly foreignKeyEditorLoading = signal(false);
  readonly foreignKeyEditorError = signal<string | null>(null);
  private initializedForeignKeyRow: ForeignKeyEditorRow | null = null;

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
        this.initializeForeignKeyEditor(row);
      } else if (!row) {
        this.initializedForeignKeyRow = null;
      }
    });
    effect(() => {
      const [params, query] = this.routeState();
      const connection = this.connections.activeConnection();
      const table = params.get('tableName');
      const schema = query.get('schema') ?? 'public';
      const version = ++this.requestVersion;

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
          if (version === this.requestVersion) this.snapshot.set(snapshot);
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
  }

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
      identityGeneration: 'none',
      isUncommitted: false,
      isGridInput: true,
      editedFields: [],
      status: 'FILL NAME + TYPE',
    });
    this.stageError.set(null);
  }

  beginTableRename(): void {
    const table = this.snapshot();
    if (!table?.canAlter) return;
    this.tableNameDraft.set(table.name);
    this.renamingTable.set(true);
    this.stageError.set(null);
  }

  async stageTableRename(): Promise<void> {
    const table = this.snapshot();
    const connection = this.connections.activeConnection();
    const newName = this.tableNameDraft().trim();
    if (!table || !connection || !newName) return;
    this.stagingField.set(true);
    this.stageError.set(null);
    try {
      await this.runbook.stageTableOperation(connection, table, { kind: 'renameTable', newName });
      this.renamingTable.set(false);
    } catch (error) {
      this.stageError.set(error instanceof Error ? error.message : 'Unable to stage this table rename.');
    } finally {
      this.stagingField.set(false);
    }
  }

  async stageTableDrop(): Promise<void> {
    const table = this.snapshot();
    const connection = this.connections.activeConnection();
    if (!table?.canAlter || !connection) return;
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

  async cancelTableOperation(): Promise<void> {
    try {
      await this.runbook.discardPending();
      this.stageError.set(null);
    } catch (error) {
      this.stageError.set(error instanceof Error ? error.message : 'Unable to cancel this table action.');
    }
  }

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
    this.stageError.set(null);
  }

  onFieldCellEdit(event: GridEditEvent<SchemaFieldRow>): void {
    if (!['name', 'dataType', 'typeDetails', 'defaultValue', 'nullable', 'identityGeneration'].includes(event.field)) return;
    const row = this.fieldDatasource.rows()[event.position.rowIndex];
    if (!row || (event.field === 'identityGeneration'
      ? !row.canEditIdentity
      : !row.isGridInput && !row.isUncommitted && !row.canEdit)) return;
    this.stageError.set(null);
    const editedFields = [...new Set([...row.editedFields, event.field])];
    this.fieldDatasource.patchRow(event.position.rowIndex, {
      editedFields,
      canEditIdentity: event.field === 'dataType' && (row.isGridInput || row.canEdit)
        ? this.identityGenerationAllowed(row.dataType)
        : row.canEditIdentity,
      status: editedFields.includes('identityGeneration')
        || (editedFields.includes('name') && editedFields.includes('dataType'))
        ? 'READY TO STAGE'
        : 'FILL NAME + TYPE',
    });
  }

  onFieldRecordEdit(event: RecordEditEvent<SchemaFieldRow>): void {
    const row = event.data;
    if (!row.isGridInput && !row.isUncommitted && !row.editedFields.length) return;
    void this.stageGridField(row);
  }

  onConstraintCellEdit(event: GridEditEvent<SchemaConstraintRow>): void {
    if (!['kind', 'name', 'fields'].includes(event.field)) return;
    const row = this.constraintDatasource.rows()[event.position.rowIndex];
    if (!row) return;
    this.stageError.set(null);
    if (row.isGridInput || (row.sourceName === null && row.isUncommitted)) {
      this.constraintDatasource.patchRow(event.position.rowIndex, {
        status: row.name.trim() && row.fields.trim()
          && (row.kind !== 'foreignKey' || row.references.trim()) ? 'READY TO STAGE' : 'FILL REQUIRED FIELDS',
      });
    }
  }

  onConstraintRecordEdit(event: RecordEditEvent<SchemaConstraintRow>): void {
    const row = event.data;
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

  onConstraintRowRemoved(event: RecordEditEvent<SchemaConstraintRow>): void {
    const row = event.data;
    this.closeForeignKeyEditorFor(row);
    if (row.isGridInput) return;

    if (row.sourceName !== null && !row.canDrop) {
      this.stageError.set('This constraint cannot be removed with the current database adapter.');
      this.constraintDatasource.setData(this.displayConstraints());
      return;
    }

    const connection = this.connections.activeConnection();
    const snapshot = this.snapshot();
    if (!connection || !snapshot?.canAlter) {
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

  private closeForeignKeyEditorFor(row: SchemaConstraintRow): void {
    const editing = this.foreignKeyEditor.row();
    if (!editing) return;
    const matches = row.sourceName !== null
      ? editing.sourceName === row.sourceName
      : editing.sourceName === null
        && (editing.operationName ?? editing.name) === (row.operationName ?? row.name);
    if (matches) this.foreignKeyEditor.close();
  }

  private async stageConstraint(row: SchemaConstraintRow): Promise<void> {
    const connection = this.connections.activeConnection();
    const snapshot = this.snapshot();
    if (this.stagingField() || !connection || !snapshot?.canAlter) return;
    let operation: Extract<SchemaOperation, { kind: 'addConstraint' | 'dropConstraint' }> | null = null;
    const replacementName = row.sourceName ?? row.operationName ?? row.name.trim();

    if (row.isGridInput) {
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
    } catch (error) {
      this.stageError.set(error instanceof Error ? error.message : 'Unable to stage this constraint.');
      if (row.isGridInput) this.setConstraintDraftStatus(row, 'INVALID');
    } finally {
      this.stagingField.set(false);
    }
  }

  private setConstraintDraftStatus(row: SchemaConstraintRow, status: string): void {
    const rowIndex = this.constraintDatasource.rows().findIndex((candidate) =>
      candidate.isGridInput && candidate.name === row.name && candidate.fields === row.fields);
    if (rowIndex >= 0) this.constraintDatasource.patchRow(rowIndex, { status });
  }

  private async stageGridField(row: SchemaFieldRow): Promise<void> {
    const connection = this.connections.activeConnection();
    const snapshot = this.snapshot();
    this.stageError.set(null);
    if (this.stagingField() || !connection || !snapshot?.canAlter) return;
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
    } catch (error) {
      this.stageError.set(error instanceof Error ? error.message : 'Unable to stage this field.');
    } finally {
      this.stagingField.set(false);
    }
  }

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
      { field: 'status', header: 'Status', width: 190, cellRendererComponent: SchemaBadgeCellComponent, editable: false, locked: true },
    ];
  }

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
        field: 'references', header: 'Reference', width: 290, editable: false,
        cellRendererComponent: ForeignKeyReferenceCellComponent,
      },
      { field: 'status', header: 'Status', width: 150, cellRendererComponent: SchemaBadgeCellComponent, editable: false, locked: true },
    ];
  }

  async onForeignKeyTargetChanged(event: Event): Promise<void> {
    const target = (event.target as HTMLSelectElement).value;
    const [schema = '', table = ''] = target.split('\u0000');
    this.foreignKeyTargetSchema.set(schema);
    this.foreignKeyTargetTable.set(table);
    await this.loadForeignKeyTargetSets();
  }

  async onForeignKeyLocalFieldChanged(field: string, event: Event): Promise<void> {
    const checked = (event.target as HTMLInputElement).checked;
    const fields = this.foreignKeyLocalFields();
    this.foreignKeyLocalFields.set(checked ? [...fields, field] : fields.filter((value) => value !== field));
    await this.loadForeignKeyTargetSets();
  }

  async loadForeignKeyTargetSets(): Promise<void> {
    const row = this.foreignKeyEditor.row();
    const connection = this.connections.activeConnection();
    const snapshot = this.snapshot();
    const localFieldNames = this.foreignKeyLocalFields();
    const targetSchema = this.foreignKeyTargetSchema();
    const targetTable = this.foreignKeyTargetTable();
    this.foreignKeyTargetSets.set([]);
    this.foreignKeySelectedSet.set('');
    this.foreignKeyEditorError.set(null);
    if (!row || !connection || !snapshot || !localFieldNames.length || !targetSchema || !targetTable) return;
    this.foreignKeyEditorLoading.set(true);
    try {
      const result = await this.connections.foreignKeyFieldChoices(
        connection.connectionId, snapshot.schema, snapshot.name, targetSchema, targetTable, localFieldNames,
      );
      this.foreignKeyTargetSets.set(result.fieldSets);
      this.foreignKeySelectedSet.set(result.fieldSets[0]?.fieldNames.join('\u0000') ?? '');
      if (!result.fieldSets.length) this.foreignKeyEditorError.set('This table has no primary or unique key with fields compatible with the selected local fields.');
    } catch (error) {
      this.foreignKeyEditorError.set(error instanceof Error ? error.message : 'Unable to load compatible referenced fields.');
    } finally {
      this.foreignKeyEditorLoading.set(false);
    }
  }

  private initializeForeignKeyEditor(row: ForeignKeyEditorRow): void {
    this.foreignKeyEditorError.set(null);
    this.foreignKeyEditorName.set(row.name);
    const parsedLocal = row.fields === '—' ? [] : safeParseFieldNames(row.fields);
    this.foreignKeyLocalFields.set(parsedLocal);
    const parsedReference = row.references === '—' ? null : safeParseForeignKeyReference(row.references);
    const targetSchema = parsedReference?.referencedSchema ?? '';
    const targetTable = parsedReference?.referencedTable ?? '';
    this.foreignKeyTargetSchema.set(targetSchema);
    this.foreignKeyTargetTable.set(targetTable);
    if (targetSchema && targetTable) void this.loadForeignKeyTargetSets().then(() => {
      const current = parsedReference?.referencedFieldNames.join('\u0000');
      if (current && this.foreignKeyTargetSets().some(({ fieldNames }) => fieldNames.join('\u0000') === current)) {
        this.foreignKeySelectedSet.set(current);
      }
    });
  }

  async saveForeignKeyReference(): Promise<void> {
    const row = this.foreignKeyEditor.row();
    const connection = this.connections.activeConnection();
    const snapshot = this.snapshot();
    const selected = this.foreignKeySelectedSet();
    const referencedFieldNames = this.foreignKeyTargetSets().find(({ fieldNames }) => fieldNames.join('\u0000') === selected)?.fieldNames;
    if (!row || !connection || !snapshot || !this.foreignKeyLocalFields().length || !referencedFieldNames) return;
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
      this.foreignKeyEditor.close();
    } catch (error) {
      this.foreignKeyEditorError.set(error instanceof Error ? error.message : 'Unable to stage this foreign key.');
    } finally {
      this.stagingField.set(false);
    }
  }

  private typeIdentity(snapshot: TableSnapshot, type: string): string {
    const descriptor = snapshot.editableFieldTypes.find((item) => item.value === type);
    return descriptor ? `${descriptor.typeSchema}.${descriptor.typeName}` : type;
  }

  private identityGenerationAllowed(type: string): boolean {
    return this.snapshot()?.editableFieldTypes.find((item) => item.value === type)?.identityGenerationSupported ?? false;
  }

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
    if (!pending || !connection || !sameTarget(pending.target, connection.target)
      || pending.schema !== table.schema || pending.table !== table.name) return rows;

    for (const operation of pending.operations) {
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
    return rows;
  }

  private isConstraintDropped(name: string | null): boolean {
    if (!name) return false;
    const pending = this.runbook.runbook();
    const connection = this.connections.activeConnection();
    const table = this.snapshot();
    if (!pending || !connection || !table || !sameTarget(pending.target, connection.target)
      || pending.schema !== table.schema || pending.table !== table.name) return false;
    return pending.operations.some((operation) =>
      operation.kind === 'dropConstraint' && operation.name === name);
  }

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
