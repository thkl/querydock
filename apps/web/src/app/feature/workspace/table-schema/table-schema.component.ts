import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { combineLatest } from 'rxjs';
import type {
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
  nullable: string;
  defaultValue: string;
  isUncommitted: boolean;
  isGridInput: boolean;
  editedFields: string[];
  status: string;
}

interface SchemaConstraintRow {
  kind: string;
  name: string;
  fields: string;
  definition: string;
  references: string;
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
      nullable: field.nullable ? 'YES' : 'NO',
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
          nullable: 'YES',
          defaultValue: operation.defaultExpression ?? '—',
          isUncommitted: true,
          isGridInput: false,
          editedFields: [],
          status: 'UNCOMMITTED',
        });
      } else {
        const field = fields.find(({ sourceName }) => sourceName === operation.name);
        if (!field) continue;
        field.operationName = operation.name;
        field.canEdit = true;
        field.name = operation.newName;
        field.dataType = operation.type;
        field.typeDetails = fieldTypeDetails(operation);
        field.typeIdentity = this.typeIdentity(table, operation.type);
        field.defaultValue = operation.defaultExpression ?? '—';
        field.isUncommitted = true;
        field.status = 'UNCOMMITTED';
      }
    }
    return fields;
  });
  readonly uncommittedFieldCount = computed(() => this.displayFields().filter((field) => field.isUncommitted).length);
  readonly displayConstraints = computed<SchemaConstraintRow[]>(() =>
    (this.snapshot()?.constraints ?? []).map((constraint) => this.toConstraintRow(constraint)),
  );
  readonly fieldDatasource = new AgridDataSource<SchemaFieldRow>();
  readonly constraintDatasource = new AgridDataSource<SchemaConstraintRow>();
  readonly editableFieldGridProvider: AgridProvider<SchemaFieldRow>;
  readonly readonlyFieldGridProvider: AgridProvider<SchemaFieldRow>;
  readonly fieldGridProvider = computed(() => this.snapshot()?.canAlter && !this.stagingField()
    ? this.editableFieldGridProvider
    : this.readonlyFieldGridProvider);
  readonly constraintGridProvider: AgridProvider<SchemaConstraintRow>;
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
      emptyText: 'No visible fields were returned.',
      getRowClass: ({ row }) => row.isUncommitted
        ? 'schema-row-uncommitted'
        : row.isGridInput ? 'schema-row-input' : '',
    });
    this.constraintGridProvider = new AgridProvider<SchemaConstraintRow>({
      columns: this.makeConstraintColumns(),
      datasource: this.constraintDatasource,
      control: new AgridControl(),
      readonly: true,
      showToolbar: false,
      hideGridStatusBar: true,
      emptyText: 'No constraints are visible for this resource.',
    });
    effect(() => this.fieldDatasource.setData(this.displayFields()));
    effect(() => this.editableFieldGridProvider.columns.set(this.makeFieldColumns()));
    effect(() => this.constraintDatasource.setData(this.displayConstraints()));
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
      nullable: 'YES',
      defaultValue: '—',
      isUncommitted: false,
      isGridInput: true,
      editedFields: [],
      status: 'FILL NAME + TYPE',
    });
    this.stageError.set(null);
  }

  onFieldCellEdit(event: GridEditEvent<SchemaFieldRow>): void {
    if (!['name', 'dataType', 'typeDetails', 'defaultValue'].includes(event.field)) return;
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
      { field: 'nullable', header: 'Nullable', width: 110, cellRendererComponent: SchemaBadgeCellComponent, editable: false, locked: true },
      { field: 'defaultValue', header: 'Default / generation', width: 260, editable: true,
        cellReadonly: (params: CellReadonlyParams<SchemaFieldRow>) => !params.row.isGridInput && !params.row.canEdit },
      { field: 'status', header: 'Status', width: 190, cellRendererComponent: SchemaBadgeCellComponent, editable: false, locked: true },
    ];
  }

  private makeConstraintColumns(): ColDef<SchemaConstraintRow>[] {
    return [
      { field: 'kind', header: 'Kind', width: 140, cellRendererComponent: SchemaBadgeCellComponent, locked: true },
      { field: 'name', header: 'Name', width: 220, locked: true },
      { field: 'fields', header: 'Fields', width: 200, locked: true },
      { field: 'definition', header: 'Definition', width: 380, locked: true },
      { field: 'references', header: 'References', width: 240, locked: true },
    ];
  }

  private typeIdentity(snapshot: TableSnapshot, type: string): string {
    const descriptor = snapshot.editableFieldTypes.find((item) => item.value === type);
    return descriptor ? `${descriptor.typeSchema}.${descriptor.typeName}` : type;
  }

  private toConstraintRow(constraint: TableConstraintDescriptor): SchemaConstraintRow {
    return {
      kind: constraint.kind,
      name: constraint.name,
      fields: constraint.fieldNames.join(', '),
      definition: constraint.definition,
      references: constraint.referencedSchema && constraint.referencedTable
        ? `${constraint.referencedSchema}.${constraint.referencedTable}(${constraint.referencedFieldNames.join(', ')})`
        : '—',
    };
  }
}

function sameTarget(left: { adapter: string; host: string; port: number; database: string; username: string },
  right: { adapter: string; host: string; port: number; database: string; username: string }): boolean {
  return left.adapter === right.adapter && left.host === right.host && left.port === right.port
    && left.database === right.database && left.username === right.username;
}

function fieldTypeDetails(operation: SchemaOperation): string { return operation.typeDetails ?? ''; }
