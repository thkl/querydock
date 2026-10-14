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
import { SchemaBadgeCellComponent } from './schema-badge-cell.component';

interface SchemaFieldRow {
  sourceName: string | null;
  operationName: string | null;
  canEdit: boolean;
  name: string;
  dataType: string;
  typeDetails: string;
  typeIdentity: string;
  nullable: boolean;
  defaultValue: string;
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
  templateUrl: './table-schema.component.html',
  styleUrl: './table-schema.component.css',
})
export class TableSchemaComponent {
  private readonly route = inject(ActivatedRoute);
  private requestVersion = 0;

  readonly connections = inject(ConnectionApiService);
  readonly runbook = inject(RunbookService);
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
      name: field.name,
      dataType: field.editableType ?? field.dataType,
      typeDetails: field.characterMaximumLength !== null
        ? String(field.characterMaximumLength)
        : field.dataType === 'numeric' && field.numericPrecision !== null
          ? `${field.numericPrecision}${field.numericScale !== null ? `, ${field.numericScale}` : ''}`
          : '',
      typeIdentity: `${field.typeSchema}.${field.typeName}`,
      nullable: field.nullable,
      defaultValue: field.identityGeneration
        ? `IDENTITY ${field.identityGeneration === 'always' ? 'ALWAYS' : 'BY DEFAULT'}`
        : field.generated
          ? `GENERATED${field.generationExpression ? ` · ${field.generationExpression}` : ''}`
          : field.defaultExpression ?? '—',
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
          canEdit: true,
          name: operation.name,
          dataType: operation.type,
          typeDetails: fieldTypeDetails(operation),
          typeIdentity: this.typeIdentity(table, operation.type),
          nullable: true,
          defaultValue: operation.defaultExpression ?? '—',
          isUncommitted: true,
          isGridInput: false,
          editedFields: [],
          status: 'UNCOMMITTED',
        });
      } else if (operation.kind === 'alterField') {
        const field = fields.find(({ sourceName }) => sourceName === operation.name);
        if (!field) continue;
        field.operationName = operation.name;
        field.canEdit = true;
        field.name = operation.newName;
        field.dataType = operation.type;
        field.typeDetails = fieldTypeDetails(operation);
        field.typeIdentity = this.typeIdentity(table, operation.type);
        field.defaultValue = operation.defaultExpression ?? '—';
        field.nullable = operation.nullable ?? field.nullable;
        field.isUncommitted = true;
        field.status = 'UNCOMMITTED';
      }
    }
    return fields;
  });
  readonly uncommittedSchemaChangeCount = computed(() =>
    this.displayFields().filter((field) => field.isUncommitted).length
      + this.displayConstraints().filter((constraint) => constraint.isUncommitted).length,
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
  readonly fieldTypeOptions = computed(() => (this.snapshot()?.editableFieldTypes ?? [])
    .map(({ value, label }) => ({ value, label })));

  constructor() {
    const columns = this.makeFieldColumns();
    this.editableFieldGridProvider = new AgridProvider<SchemaFieldRow>({
      columns,
      datasource: this.fieldDatasource,
      control: new AgridControl(),
      readonly: false,
      allowAddRows: true,
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
      hideGridStatusBar: true,
      removeEmptyNewRowOnEscape:true,
      clearCellSelectionOnBackgroundClick: true,
      emptyText: 'No constraints are visible for this resource.',
      getRowClass: ({ row }) => row.isUncommitted ? 'schema-row-uncommitted' : '',
    });
    effect(() => this.fieldDatasource.setData(this.displayFields()));
    effect(() => this.editableFieldGridProvider.columns.set(this.makeFieldColumns()));
    effect(() => this.constraintDatasource.setData(this.displayConstraints()));
    effect(() => this.editableConstraintGridProvider.columns.set(this.makeConstraintColumns()));
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
    event.datasource.updateRow(event.index, {
      ...event.data,
      sourceName: null,
      operationName: null,
      canEdit: true,
      name: '',
      dataType: this.snapshot()?.editableFieldTypes[0]?.value ?? '',
      typeDetails: '',
      nullable: true,
      defaultValue: '—',
      isUncommitted: false,
      isGridInput: true,
      editedFields: [],
      status: 'FILL NAME + TYPE',
    });
    this.stageError.set(null);
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
      references: '—',
      canDrop: false,
      drop: false,
      status: 'FILL NAME + FIELDS / EXPRESSION',
    });
    this.stageError.set(null);
  }

  onFieldCellEdit(event: GridEditEvent<SchemaFieldRow>): void {
    if (!['name', 'dataType', 'typeDetails', 'defaultValue', 'nullable'].includes(event.field)) return;
    const row = this.fieldDatasource.rows()[event.position.rowIndex];
    if (!row || (!row.isGridInput && !row.isUncommitted && !row.canEdit)) return;
    this.stageError.set(null);
    const editedFields = [...new Set([...row.editedFields, event.field])];
    this.fieldDatasource.patchRow(event.position.rowIndex, {
      editedFields,
      status: editedFields.includes('name') && editedFields.includes('dataType')
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
    if (!['kind', 'name', 'fields', 'drop'].includes(event.field)) return;
    const row = this.constraintDatasource.rows()[event.position.rowIndex];
    if (!row) return;
    this.stageError.set(null);
    if (row.isGridInput || (row.sourceName === null && row.isUncommitted)) {
      this.constraintDatasource.patchRow(event.position.rowIndex, {
        status: row.name.trim() && row.fields.trim() ? 'READY TO STAGE' : 'FILL NAME + DEFINITION',
      });
    }
  }

  onConstraintRecordEdit(event: RecordEditEvent<SchemaConstraintRow>): void {
    const row = event.data;
    if (row.isGridInput) {
      if (row.name.trim() && row.fields.trim()) void this.stageConstraint(row);
      return;
    }
    if (row.isUncommitted || row.drop !== this.isConstraintDropped(row.sourceName)) {
      void this.stageConstraint(row);
    }
  }

  private async stageConstraint(row: SchemaConstraintRow): Promise<void> {
    const connection = this.connections.activeConnection();
    const snapshot = this.snapshot();
    if (this.stagingField() || !connection || !snapshot?.canAlter) return;
    let operation: Extract<SchemaOperation, { kind: 'addConstraint' | 'dropConstraint' }> | null = null;
    const replacementName = row.sourceName ?? row.operationName ?? row.name.trim();

    if (row.isGridInput) {
      if (!row.name.trim() || !row.fields.trim()) {
        this.stageError.set(row.kind === 'check'
          ? 'Enter a constraint name and a CHECK expression, such as quantity > 0.'
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
        operation = {
          kind: 'addConstraint',
          constraintKind: row.kind as Exclude<EditableConstraintKind, 'check'>,
          name: row.name.trim(),
          fieldNames,
        };
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
      { field: 'defaultValue', header: 'Default / generation', width: 260, editable: true,
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
      { field: 'references', header: 'References', width: 200, editable: false, locked: true },
      {
        field: 'drop', header: 'Remove', width: 90, type: 'boolean', editable: true,
        cellReadonly: ({ row }: CellReadonlyParams<SchemaConstraintRow>) => row.isGridInput || !row.canDrop,
      },
      { field: 'status', header: 'Status', width: 150, cellRendererComponent: SchemaBadgeCellComponent, editable: false, locked: true },
    ];
  }

  private typeIdentity(snapshot: TableSnapshot, type: string): string {
    const descriptor = snapshot.editableFieldTypes.find((item) => item.value === type);
    return descriptor ? `${descriptor.typeSchema}.${descriptor.typeName}` : type;
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
            : `${operation.constraintKind === 'primaryKey' ? 'PRIMARY KEY' : 'UNIQUE'} (${formatFieldNames(operation.fieldNames)})`,
          references: '—',
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

function formatFieldNames(names: string[]): string {
  return names.map((name) => /[",\s]/.test(name) ? `"${name.replaceAll('"', '""')}"` : name).join(', ');
}
