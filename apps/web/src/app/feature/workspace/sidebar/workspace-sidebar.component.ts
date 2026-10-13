import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { WorkspaceDraftsService } from '../workspace-drafts.service';
import { ConnectionApiService } from '../connections/connection-api.service';

@Component({
  selector: 'qd-workspace-sidebar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive],
  templateUrl: './workspace-sidebar.component.html',
  styleUrl: './workspace-sidebar.component.css',
})
export class WorkspaceSidebarComponent {
  readonly drafts = inject(WorkspaceDraftsService);
  readonly connections = inject(ConnectionApiService);
}
