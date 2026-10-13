import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { WorkspaceDraftsService } from '../workspace-drafts.service';

@Component({
  selector: 'qd-runbook',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './runbook.component.html',
  styleUrl: './runbook.component.css',
})
export class RunbookComponent {
  readonly drafts = inject(WorkspaceDraftsService);
}
