import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { AGRID_RENDERER_CONTEXT } from '@thkl/agrid';
import { ForeignKeyEditorState, type ForeignKeyEditorRow } from './foreign-key-editor-state';
import { CheckConstraintEditorState } from './check-constraint-editor-state';
import { PrimaryKeyEditorState } from './primary-key-editor-state';

@Component({
  selector: 'qd-foreign-key-reference-cell',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (isForeignKey()) {
      <button class="reference-editor-trigger" type="button" (click)="open($event)"
        [attr.aria-label]="row().name ? 'Edit foreign key ' + row().name : 'Choose foreign key reference'">
        <span>{{ value() || 'Choose table and fields' }}</span><span aria-hidden="true">↗</span>
      </button>
    } @else {
      <span class="reference-text">{{ value() || '—' }}</span>
    }
  `,
  styles: [`
    :host { display: block; min-width: 0; }
    .reference-editor-trigger { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; min-height: 28px; padding: 3px 7px; border: 1px solid var(--color-border); border-radius: 5px; background: var(--color-surface); color: var(--color-accent-strong); font: inherit; text-align: left; cursor: pointer; }
    .reference-editor-trigger:hover, .reference-editor-trigger:focus-visible { border-color: var(--color-accent); outline: none; }
    .reference-editor-trigger span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .reference-text { color: var(--color-muted); }
  `],
})
export class ForeignKeyReferenceCellComponent {
  private readonly context = inject(AGRID_RENDERER_CONTEXT);
  private readonly editor = inject(ForeignKeyEditorState);
  private readonly checkEditor = inject(CheckConstraintEditorState);
  private readonly primaryKeyEditor = inject(PrimaryKeyEditorState);
  readonly value = computed(() => String(this.context.value() ?? ''));
  readonly row = computed(() => this.context.row() as unknown as ForeignKeyEditorRow);
  readonly isForeignKey = computed(() => ['foreignKey', 'Foreign key'].includes(this.row().kind));

  /** Opens the referenced-constraint sidebar for the current grid row. */
  open(event: MouseEvent): void {
    event.stopPropagation();
    this.checkEditor.close();
    this.primaryKeyEditor.close();
    this.editor.open(this.row());
  }
}
