import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { AGRID_RENDERER_CONTEXT } from '@thkl/agrid';
import { CheckConstraintEditorState } from './check-constraint-editor-state';
import { ForeignKeyEditorState } from './foreign-key-editor-state';
import { PrimaryKeyEditorState, type PrimaryKeyEditorRow } from './primary-key-editor-state';

@Component({
  selector: 'qd-primary-key-fields-cell',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (canOpen()) {
      <button class="primary-key-picker-trigger" type="button" (click)="open($event)"
        [attr.aria-label]="'Choose fields for primary key ' + (row().name || 'new constraint')">
        <span>Choose fields</span><span aria-hidden="true">↗</span>
      </button>
    } @else {
      <span class="primary-key-picker-empty">—</span>
    }
  `,
  styles: [`
    :host { display: block; min-width: 0; }
    .primary-key-picker-trigger { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; min-height: 28px; padding: 3px 7px; border: 1px solid var(--color-border); border-radius: 5px; background: var(--color-surface); color: var(--color-accent-strong); font: inherit; text-align: left; cursor: pointer; }
    .primary-key-picker-trigger:hover, .primary-key-picker-trigger:focus-visible { border-color: var(--color-accent); outline: none; }
    .primary-key-picker-empty { color: var(--color-muted); }
  `],
})
export class PrimaryKeyFieldsCellComponent {
  private readonly context = inject(AGRID_RENDERER_CONTEXT);
  private readonly editor = inject(PrimaryKeyEditorState);
  private readonly foreignKeyEditor = inject(ForeignKeyEditorState);
  private readonly checkEditor = inject(CheckConstraintEditorState);
  readonly row = computed(() => this.context.row() as unknown as PrimaryKeyEditorRow);
  readonly canOpen = computed(() => ['primaryKey', 'Primary key'].includes(this.row().kind)
    && this.row().sourceName === null && (this.row().isGridInput || this.row().isUncommitted));

  /** Opens the picker for this primary-key row. */
  open(event: MouseEvent): void {
    event.stopPropagation();
    if (!this.canOpen()) return;
    this.foreignKeyEditor.close();
    this.checkEditor.close();
    this.editor.open(this.row());
  }
}
