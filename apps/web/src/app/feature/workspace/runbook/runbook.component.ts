import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SqlEditorComponent } from '../sql-editor/sql-editor.component';
import { WorkspaceDraftsService } from '../workspace-drafts.service';

@Component({
  selector: 'qd-runbook',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, SqlEditorComponent],
  templateUrl: './runbook.component.html',
  styleUrl: './runbook.component.css',
})
export class RunbookComponent {
  readonly drafts = inject(WorkspaceDraftsService);
  readonly previewSql = `-- No SQL is staged in this runbook yet.\n-- Previewed SQL will appear here after changes are staged.`;
}
