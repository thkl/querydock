import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { combineLatest } from 'rxjs';
import type {
  AddNullableFieldOperation,
  NullableFieldType,
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

const fieldTypeLabels: Record<NullableFieldType, string> = {
  text: 'text', integer: 'integer', bigint: 'bigint', numeric: 'numeric', boolean: 'boolean',
  uuid: 'uuid', date: 'date', timestamptz: 'timestamp with time zone', jsonb: 'jsonb',
};
const fieldTypeNames: Record<NullableFieldType, string> = {
  text: 'text', integer: 'int4', bigint: 'int8', numeric: 'numeric', boolean: 'bool',
  uuid: 'uuid', date: 'date', timestamptz: 'timestamptz', jsonb: 'jsonb',
};

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
      name: field.name,
      dataType: field.dataType,
      typeDetails: field.characterMaximumLength !== null
        ? `(${field.characterMaximumLength})`
        : field.dataType === 'numeric' && field.numericPrecision !== null
          ? `(${field.numericPrecision}${field.numericScale !== null ? `, ${field.numericScale}` : ''})`
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

    const existingNames = new Set(fields.map(({ name }) => name));
    for (const operation of pending.operations) {
      if (existingNames.has(operation.name)) continue;
      fields.push({
        name: operation.name,
        dataType: fieldTypeLabels[operation.type],
        typeDetails: '',
        typeIdentity: `pg_catalog.${fieldTypeNames[operation.type]}`,
        nullable: 'YES',
        defaultValue: '—',
        isUncommitted: true,
        isGridInput: false,
        editedFields: [],
        status: 'UNCOMMITTED',
      });
      existingNames.add(operation.name);
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
  readonly fieldGridProvider = computed(() => this.snapshot()?.canAlter
    ? this.editableFieldGridProvider
    : this.readonlyFieldGridProvider);
  readonly constraintGridProvider: AgridProvider<SchemaConstraintRow>;
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly stagingField = signal(false);
  readonly stageError = signal<string | null>(null);
  readonly fieldTypes: { value: NullableFieldType; label: string }[] = [
    { value: 'text', label: 'Text' },
    { value: 'integer', label: 'Integer' },
    { value: 'bigint', label: 'Big integer' },
    { value: 'numeric', label: 'Numeric' },
    { value: 'boolean', label: 'Boolean' },
    { value: 'uuid', label: 'UUID' },
    { value: 'date', label: 'Date' },
    { value: 'timestamptz', label: 'Timestamp with time zone' },
    { value: 'jsonb', label: 'JSON' },
  ];
  readonly fieldTypeOptions = this.fieldTypes.map(({ value, label }) => ({ value, label }));

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
      dataType: 'text',
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
    if (event.field !== 'name' && event.field !== 'dataType') return;
    const row = this.fieldDatasource.rows()[event.position.rowIndex];
    if (!row?.isGridInput) return;
    const editedFields = [...new Set([...row.editedFields, event.field])];
    this.fieldDatasource.patchRow(event.position.rowIndex, {
      editedFields,
      status: editedFields.includes('name') && editedFields.includes('dataType')
        ? 'READY TO STAGE'
        : 'FILL NAME + TYPE',
    });
  }

  onFieldRecordEdit(event: RowUpdateEvent<SchemaFieldRow>): void {
    const row = event.row
    if (!row.isGridInput || !row.dataType || !row.name)
      {
          console.error("Missing mandatory fields",row.isGridInput ,row.dataType,row.name);
        return;
      }
    console.log("Staging Grid Field")
    void this.stageGridField(row.name, row.dataType);
  }

  private async stageGridField(rawName: string, rawType: string): Promise<void> {
    const connection = this.connections.activeConnection();
    const snapshot = this.snapshot();
    const name = rawName.trim();
    this.stageError.set(null);
    if (this.stagingField() || !connection || !snapshot?.canAlter) return;
    if (!/^[\p{L}_][\p{L}\p{N}_$]*$/u.test(name)) {
      this.stageError.set('Use a PostgreSQL identifier: start with a letter or underscore, then use letters, numbers, underscores, or $.');
      return;
    }
    if (!this.fieldTypes.some(({ value }) => value === rawType)) {
      this.stageError.set('Choose a supported PostgreSQL field type from the grid.');
      return;
    }

    const operation: AddNullableFieldOperation = {
      kind: 'addNullableField',
      name,
      type: rawType as NullableFieldType,
    };
    this.stagingField.set(true);
    try {
      await this.runbook.stageAddNullableField(connection, snapshot, operation);
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
        cellReadonly: (params: CellReadonlyParams<SchemaFieldRow>) => !params.row.isGridInput,
      },
      {
        field: 'dataType', header: 'Type', width: 210, editable: true,
        values: this.fieldTypeOptions,
        cellReadonly: (params: CellReadonlyParams<SchemaFieldRow>) => !params.row.isGridInput,
      },
      { field: 'typeDetails', header: 'Size', width: 100, editable: false, locked: true },
      { field: 'typeIdentity', header: 'Type schema', width: 160, editable: false, locked: true },
      { field: 'nullable', header: 'Nullable', width: 110, cellRendererComponent: SchemaBadgeCellComponent, editable: false, locked: true },
      { field: 'defaultValue', header: 'Default / generation', width: 260, editable: false, locked: true },
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
