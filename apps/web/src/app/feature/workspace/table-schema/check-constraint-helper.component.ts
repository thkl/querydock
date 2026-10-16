import { ChangeDetectionStrategy, Component, computed, effect, input, output, signal } from '@angular/core';
import type { CheckConstraintEditorRow } from './check-constraint-editor-state';
import { suggestConstraintName } from './constraint-name-suggestion';

export interface CheckConstraintHelperField {
  name: string;
  dataType: string;
}

@Component({
  selector: 'qd-check-constraint-helper',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './check-constraint-helper.component.html',
  styleUrl: './check-constraint-helper.component.css',
})
export class CheckConstraintHelperComponent {
  readonly row = input.required<CheckConstraintEditorRow>();
  readonly fields = input<readonly CheckConstraintHelperField[]>([]);
  readonly expressionSelected = output<string>();
  readonly nameSuggestionSelected = output<string>();
  readonly closed = output<void>();
  readonly selectedField = signal('');
  readonly selectedFieldMetadata = computed(() => this.fields().find(({ name }) => name === this.selectedField()) ?? null);
  readonly quotedField = computed(() => quoteIdentifier(this.selectedField()));
  readonly selectedFieldIsNumeric = computed(() => Boolean(this.selectedFieldMetadata()
    && /^(smallint|integer|bigint|numeric|decimal|real|double precision|float4|float8|int2|int4|int8)$/i
      .test(this.selectedFieldMetadata()!.dataType)));
  readonly selectedFieldIsText = computed(() => Boolean(this.selectedFieldMetadata()
    && /^(text|character varying|varchar|character|char|bpchar)$/i.test(this.selectedFieldMetadata()!.dataType)));
  readonly selectedFieldIsBoolean = computed(() => /^(boolean|bool)$/i.test(this.selectedFieldMetadata()?.dataType ?? ''));
  readonly suggestedConstraintName = computed(() => suggestConstraintName('chk', this.selectedField()));
  readonly suggestedNameDraft = signal('');

  constructor() {
    effect(() => {
      const available = this.fields();
      const selected = this.selectedField();
      if (!available.some(({ name }) => name === selected)) this.selectedField.set(available[0]?.name ?? '');
    });
    effect(() => this.suggestedNameDraft.set(this.suggestedConstraintName()));
  }

  /** Emits a field-qualified SQL expression based on the selected example. */
  useExample(suffix: string): void {
    if (!this.selectedField()) return;
    this.expressionSelected.emit(`${this.quotedField()} ${suffix}`);
  }

  /** Inserts an example appropriate for the selected numeric field. */
  usePositiveExample(): void { this.useExample('> 0'); }
  /** Inserts a numeric IN-list example. */
  useNumberListExample(): void { this.useExample('IN (1, 2)'); }
  /** Inserts a text IN-list example. */
  useTextListExample(): void { this.useExample("IN ('draft', 'sent')"); }
  /** Inserts a Boolean comparison example. */
  useTrueExample(): void { this.useExample('= TRUE'); }

  /** Emits a suggested constraint name for the selected field. */
  useSuggestedName(): void {
    const name = this.suggestedNameDraft().trim();
    if (name) this.nameSuggestionSelected.emit(name);
  }
}

function quoteIdentifier(identifier: string): string {
  return identifier ? `"${identifier.replaceAll('"', '""')}"` : '"field"';
}
