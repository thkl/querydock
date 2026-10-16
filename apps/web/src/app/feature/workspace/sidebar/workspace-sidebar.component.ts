import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { ConnectionApiService } from '../connections/connection-api.service';
import { ConnectionVaultService } from '../connections/connection-vault.service';
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
  readonly vault = inject(ConnectionVaultService);
  readonly pages = inject(WorkspacePagesService);
  readonly disconnectConfirmationId = signal<string | null>(null);

  /** Formats a connection tree label using its saved name or database target. */
  connectionLabel(connectionId: string): string {
    const connection = this.connections.connections().find(({ connectionId: id }) => id === connectionId);
    if (!connection) return 'Disconnected';
    const saved = this.vault.profiles().find(({ configuration }) =>
      configuration.adapter === connection.target.adapter
      && configuration.host === connection.target.host
      && configuration.port === connection.target.port
      && configuration.database === connection.target.database
      && configuration.username === connection.target.username);
    if (saved?.name.trim()) return saved.name.trim();
    const { target } = connection;
    return `${target.database} · ${target.host}:${target.port} · ${target.username}`;
  }

  /** Confirms and closes the selected connection and its workspace tabs. */
  async disconnect(connectionId: string): Promise<void> {
    if (this.disconnectConfirmationId() !== connectionId) {
      this.disconnectConfirmationId.set(connectionId);
      return;
    }
    const disconnected = await this.connections.disconnect(connectionId);
    this.disconnectConfirmationId.set(null);
    if (disconnected) this.pages.closeConnectionPages(connectionId);
  }

  /** Opens the selected resource's schema page in the workspace tab bar. */
  openResourceSchema(schema: string, table: string): void {
    const connectionId = this.connections.activeConnectionId();
    if (connectionId) this.pages.openTableSchema(connectionId, schema, table);
  }

  /** Opens the selected resource in the read-only data browser. */
  openDataView(schema: string, table: string): void {
    const connection = this.connections.activeConnection();
    if (connection && table && connection.capabilities.browseData) {
      this.pages.openTableData(connection.connectionId, schema, table);
    }

  }
}
