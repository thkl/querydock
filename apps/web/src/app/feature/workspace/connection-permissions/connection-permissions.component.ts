import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { DatabasePermissionReport } from '@querydock/contracts';
import { ConnectionApiService } from '../connections/connection-api.service';
import { WorkspacePagesService } from '../workspace-pages.service';

/** Displays effective database, schema, and object privileges for one connected principal. */
@Component({
  selector: 'qd-connection-permissions',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './connection-permissions.component.html',
  styleUrl: './connection-permissions.component.css',
})
export class ConnectionPermissionsComponent {
  readonly connections = inject(ConnectionApiService);
  readonly pages = inject(WorkspacePagesService);
  readonly report = signal<DatabasePermissionReport | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  private requestId = 0;
  private reportForConnection: string | null = null;

  /** Registers the active connection tab and refreshes when its owning connection changes. */
  constructor() {
    effect(() => {
      const connectionId = this.connections.activeConnectionId();
      if (!connectionId) {
        this.requestId += 1;
        this.reportForConnection = null;
        this.report.set(null);
        this.loading.set(false);
        this.error.set(this.connections.sessionRestoreComplete() ? 'Connect to a database to inspect its permissions.' : null);
        return;
      }
      this.pages.preparePermissionReport(connectionId);
      if (this.reportForConnection !== connectionId) {
        this.reportForConnection = connectionId;
        this.report.set(null);
      }
      void this.load(connectionId);
    });
  }

  /** Refreshes the report from the selected database adapter. */
  refresh(): void {
    const connectionId = this.connections.activeConnectionId();
    if (connectionId) void this.load(connectionId);
  }

  /** Reads the effective permissions while ignoring responses for a connection that is no longer selected. */
  private async load(connectionId: string): Promise<void> {
    const requestId = ++this.requestId;
    this.loading.set(true);
    this.error.set(null);
    try {
      const report = await this.connections.permissions(connectionId);
      if (requestId === this.requestId) this.report.set(report);
    } catch (error) {
      if (requestId === this.requestId) {
        this.error.set(error instanceof Error ? error.message : 'Could not load effective database permissions.');
      }
    } finally {
      if (requestId === this.requestId) this.loading.set(false);
    }
  }
}
