import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'qd-workspace-header',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './workspace-header.component.html',
  styleUrl: './workspace-header.component.css',
})
export class WorkspaceHeaderComponent {}
