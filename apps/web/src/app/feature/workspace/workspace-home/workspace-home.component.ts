import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ConnectionApiService } from '../connections/connection-api.service';

@Component({
  selector: 'qd-workspace-home',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './workspace-home.component.html',
  styleUrl: './workspace-home.component.css',
})
export class WorkspaceHomeComponent {
  readonly connections = inject(ConnectionApiService);
}
