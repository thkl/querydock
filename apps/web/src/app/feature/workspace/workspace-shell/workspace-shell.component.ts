import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { WorkspaceHeaderComponent } from '../header/workspace-header.component';
import { WorkspaceSidebarComponent } from '../sidebar/workspace-sidebar.component';
import { WorkspaceTabsComponent } from '../workspace-tabs/workspace-tabs.component';

@Component({
  selector: 'qd-workspace-shell',
  standalone: true,
  imports: [RouterOutlet, WorkspaceHeaderComponent, WorkspaceSidebarComponent, WorkspaceTabsComponent],
  templateUrl: './workspace-shell.component.html',
  styleUrl: './workspace-shell.component.css',
})
export class WorkspaceShellComponent {}
