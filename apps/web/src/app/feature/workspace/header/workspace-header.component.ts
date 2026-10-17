import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ConnectionApiService } from '../connections/connection-api.service';
import { ConnectionVaultService } from '../connections/connection-vault.service';
import { RunbookService } from '../runbook/runbook.service';

@Component({
  selector: 'qd-workspace-header',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './workspace-header.component.html',
  styleUrl: './workspace-header.component.css',
})
export class WorkspaceHeaderComponent {
  readonly runbook = inject(RunbookService);
  readonly connection = inject(ConnectionApiService);
  private readonly vault = inject(ConnectionVaultService);
  readonly connectionName = computed(() => {
    const activeConnection = this.connection.activeConnection();
    if (!activeConnection) return null;

    const explicitName = this.connection.connectionNamesById().get(activeConnection.connectionId)?.trim();
    if (explicitName) return explicitName;

    const matchingProfiles = this.vault.profiles().filter(({ configuration }) =>
      configuration.adapter === activeConnection.target.adapter
      && configuration.host.toLowerCase() === activeConnection.target.host.toLowerCase()
      && configuration.port === activeConnection.target.port
      && configuration.database === activeConnection.target.database
      && configuration.username === activeConnection.target.username,
    );
    if (matchingProfiles.length === 1 && matchingProfiles[0].name.trim()) return matchingProfiles[0].name;
    return activeConnection.target.database;
  });
}
