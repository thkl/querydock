import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { AGRID_RENDERER_CONTEXT } from '@thkl/agrid';
import { CheckConstraintEditorState, type CheckConstraintEditorRow } from './check-constraint-editor-state';
import { ForeignKeyEditorState } from './foreign-key-editor-state';
import { PrimaryKeyEditorState } from './primary-key-editor-state';

@Component({
  selector: 'qd-check-constraint-help-cell',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './check-constraint-help-cell.component.html',
  styleUrl: './check-constraint-help-cell.component.css',
})
export class CheckConstraintHelpCellComponent {
  private readonly context = inject(AGRID_RENDERER_CONTEXT);
  private readonly editor = inject(CheckConstraintEditorState);
  private readonly foreignKeyEditor = inject(ForeignKeyEditorState);
  private readonly primaryKeyEditor = inject(PrimaryKeyEditorState);
  readonly row = computed(() => this.context.row() as unknown as CheckConstraintEditorRow);
  readonly canOpen = computed(() => ['check', 'Check'].includes(this.row().kind)
    && (this.row().isGridInput || this.row().isUncommitted));

  /** Opens the helper for the current editable CHECK row. */
  open(event: MouseEvent): void {
    event.stopPropagation();
    if (this.canOpen()) {
      this.foreignKeyEditor.close();
      this.primaryKeyEditor.close();
      this.editor.open(this.row());
    }
  }
}
