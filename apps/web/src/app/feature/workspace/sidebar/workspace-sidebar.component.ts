import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { ConnectionApiService } from '../connections/connection-api.service';
import { WorkspacePagesService } from '../workspace-pages.service';

@Component({
  selector: 'qd-workspace-sidebar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive],
  templateUrl: './workspace-sidebar.component.html',
  styleUrl: './workspace-sidebar.component.css',
})
export class WorkspaceSidebarComponent {
  readonly connections = inject(ConnectionApiService);
  readonly pages = inject(WorkspacePagesService);

  openResourceSchema(schema: string, table: string): void {
    const connectionId = this.connections.activeConnectionId();
    if (connectionId) this.pages.openTableSchema(connectionId, schema, table);
  }
}
