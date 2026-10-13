import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { WorkspaceDraftsService } from '../workspace-drafts.service';

@Component({
  selector: 'qd-workspace-tabs',
  standalone: true,
  imports: [RouterLink, RouterLinkActive],
  templateUrl: './workspace-tabs.component.html',
  styleUrl: './workspace-tabs.component.css',
})
export class WorkspaceTabsComponent {
  readonly drafts = inject(WorkspaceDraftsService);
}
