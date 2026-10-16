import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import type { CreateTableField, EditableFieldTypeDescriptor } from '@querydock/contracts';
import { ConnectionApiService } from '../connections/connection-api.service';
import { RunbookService } from '../runbook/runbook.service';
import { WorkspacePagesService, type CreateTableDraftField } from '../workspace-pages.service';

type CreateFieldRow = CreateTableDraftField;

type CreateFieldValue = Exclude<keyof CreateFieldRow, 'id'>;

@Component({
  selector: 'qd-table-create',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './table-create.component.html',
  styleUrl: './table-create.component.css',
})
export class TableCreateComponent {
  private readonly route = inject(ActivatedRoute);
  readonly router = inject(Router);
  private nextFieldId = 1;
  readonly connections = inject(ConnectionApiService);
  readonly runbook = inject(RunbookService);
  readonly pages = inject(WorkspacePagesService);
  readonly schema = signal(this.route.snapshot.queryParamMap.get('schema') ?? 'public');
  readonly workspacePage = signal(this.pages.registerOpenedCreateTable(
    this.schema(),
    this.route.snapshot.queryParamMap.get('draft') ?? undefined,
  ));
  private readonly initialDraft = this.pages.createTableDraft(this.workspacePage().id);
  readonly tableName = signal(this.initialDraft?.tableName ?? '');
  readonly createIfNotExists = signal(this.initialDraft?.ifNotExists ?? false);
  readonly typeOptions = signal<EditableFieldTypeDescriptor[]>([]);
  readonly fields = signal<CreateFieldRow[]>(this.initialDraft?.fields ?? [this.newField()]);
  readonly error = signal<string | null>(null);
  readonly submitting = signal(false);

  /** Restores draft navigation, keeps tab state synchronized, and loads adapter field types. */
  constructor() {
    this.nextFieldId = Math.max(0, ...this.fields().map(({ id }) => id)) + 1;
    effect(() => this.pages.saveCreateTableDraft(this.workspacePage().id, {
      tableName: this.tableName(),
      fields: this.fields(),
      ifNotExists: this.createIfNotExists(),
    }));
    if (!this.route.snapshot.queryParamMap.get('draft')) {
      void this.router.navigateByUrl(this.workspacePage().route, { replaceUrl: true });
    }
    this.route.queryParamMap.subscribe((params) => {
      const schema = params.get('schema') ?? 'public';
      const draftId = params.get('draft');
      if (!draftId) return;
      const page = this.pages.registerOpenedCreateTable(schema, draftId);
      if (page.id === this.workspacePage().id) return;
      const draft = this.pages.createTableDraft(page.id);
      this.schema.set(schema);
      this.workspacePage.set(page);
      this.tableName.set(draft?.tableName ?? '');
      this.createIfNotExists.set(draft?.ifNotExists ?? false);
      this.fields.set(draft?.fields ?? [this.newField()]);
      this.nextFieldId = Math.max(0, ...this.fields().map(({ id }) => id)) + 1;
    });
    effect(() => {
      const connectionId = this.connections.activeConnectionId();
      if (!connectionId) {
        this.typeOptions.set([]);
        return;
      }
      void this.connections.editableFieldTypes(connectionId).then((types) => {
        if (this.connections.activeConnectionId() === connectionId) this.typeOptions.set(types);
      }).catch((error: unknown) => {
        if (this.connections.activeConnectionId() === connectionId) {
          this.error.set(error instanceof Error ? error.message : 'Unable to load field types.');
        }
      });
    });
  }

  /** Adds a blank field row to the new-table draft. */
  addField(): void {
    this.fields.update((fields) => [...fields, this.newField()]);
  }

  /** Removes a field row while keeping at least one editable row in the draft. */
  removeField(id: number): void {
    this.fields.update((fields) => fields.length > 1 ? fields.filter((field) => field.id !== id) : fields);
  }

  /** Checks whether the connected adapter supports identity generation for a type. */
  supportsIdentity(type: string): boolean {
    return this.typeOptions().find((item) => item.value === type)?.identityGenerationSupported ?? false;
  }

  /** Updates one field property and clears identity values unsupported by its new type. */
  updateField(id: number, property: CreateFieldValue, value: string | boolean): void {
    this.fields.update((fields) => fields.map((field) => {
      if (field.id !== id) return field;
      if (property === 'nullable' && typeof value === 'boolean') return { ...field, nullable: value };
      if (property === 'identityGeneration' && typeof value === 'string') {
        const identityGeneration = value as CreateFieldRow['identityGeneration'];
        return { ...field, identityGeneration, nullable: identityGeneration === 'none' ? field.nullable : false };
      }
      if (property === 'type' && typeof value === 'string') {
        const identityGeneration = this.supportsIdentity(value) ? field.identityGeneration : 'none';
        return { ...field, type: value, identityGeneration };
      }
      if (typeof value !== 'string') return field;
      return { ...field, [property]: value };
    }));
  }

  /** Converts the draft into a server-previewed runbook operation. */
  async stage(): Promise<void> {
    this.error.set(null);
    const connection = this.connections.activeConnection();
    if (!connection) {
      this.error.set('Connect to a database before creating a table.');
      return;
    }
    this.submitting.set(true);
    const fields: CreateTableField[] = this.fields().map(({ id: _id, ...field }) => ({
      ...field,
      typeDetails: field.typeDetails || undefined,
      defaultExpression: field.defaultExpression.trim() || null,
      identityGeneration: field.identityGeneration === 'none' ? null : field.identityGeneration,
    }));
    try {
      await this.runbook.stageCreateTable(
        connection,
        this.schema(),
        this.tableName(),
        fields,
        this.createIfNotExists(),
        this.workspacePage().id,
      );
      await this.router.navigateByUrl('/runbook');
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Unable to stage this table.');
    } finally {
      this.submitting.set(false);
    }
  }

  /** Allocates a new field row with safe empty defaults. */
  private newField(): CreateFieldRow {
    return {
      id: this.nextFieldId++,
      name: '',
      type: this.typeOptions()[0]?.value ?? 'text',
      typeDetails: '',
      nullable: true,
      defaultExpression: '',
      identityGeneration: 'none',
    };
  }

}
