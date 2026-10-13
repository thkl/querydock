import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { WorkspaceDraftsService } from '../workspace-drafts.service';

@Component({
  selector: 'qd-workspace-sidebar',
  standalone: true,
  imports: [RouterLink, RouterLinkActive],
  templateUrl: './workspace-sidebar.component.html',
  styleUrl: './workspace-sidebar.component.css',
})
export class WorkspaceSidebarComponent {
  readonly drafts = inject(WorkspaceDraftsService);
}
