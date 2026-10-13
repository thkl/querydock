import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AGRID_EDITOR_CONTEXT } from '@thkl/agrid';

@Component({
  selector: 'qd-status-cell-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './status-cell-editor.component.html',
  styleUrl: './status-cell-editor.component.css',
})
export class StatusCellEditorComponent {
  readonly ctx = inject(AGRID_EDITOR_CONTEXT);

  commitSelection(event: Event): void {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement)) return;

    this.ctx.setDraft(select.value);
    this.ctx.commit();
  }
}
