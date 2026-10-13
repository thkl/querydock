import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { SqlEditorComponent } from '../sql-editor/sql-editor.component';

@Component({
  selector: 'qd-query-workspace',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SqlEditorComponent],
  templateUrl: './query-workspace.component.html',
  styleUrl: './query-workspace.component.css',
})
export class QueryWorkspaceComponent {
  readonly query = signal(`select
  id,
  name,
  email,
  plan,
  status
from public.customers
order by id
limit 50;`);
}
