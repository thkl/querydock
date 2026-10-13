import { computed, Injectable, signal } from '@angular/core';
import type {
  ConnectResponse,
  PostgresConnectRequest,
  ResourceDescriptor,
  TableSnapshot,
} from '@querydock/contracts';

@Injectable({ providedIn: 'root' })
export class ConnectionApiService {
  readonly connections = signal<ConnectResponse[]>([]);
  readonly activeConnectionId = signal<string | null>(null);
  readonly resourcesByConnection = signal<ReadonlyMap<string, ResourceDescriptor[]>>(new Map());
  readonly resourceErrorsByConnection = signal<ReadonlyMap<string, string>>(new Map());
  readonly activeConnection = computed(
    () => this.connections().find(({ connectionId }) => connectionId === this.activeConnectionId()) ?? null,
  );
  readonly activeResources = computed(
    () => this.resourcesByConnection().get(this.activeConnectionId() ?? '') ?? [],
  );
  readonly resourceGroups = computed(() => {
    const groups = new Map<string, ResourceDescriptor[]>();
    for (const resource of this.activeResources()) {
      const group = groups.get(resource.schema) ?? [];
      group.push(resource);
      groups.set(resource.schema, group);
    }
    return [...groups].map(([schema, resources]) => ({ schema, resources }));
  });
  readonly connecting = signal(false);
  readonly connectError = signal<string | null>(null);
  readonly connectDialogOpen = signal(false);

  constructor() {
    void this.restoreSessionConnections();
  }

  openConnectDialog(): void {
    this.connectError.set(null);
    this.connectDialogOpen.set(true);
  }

  closeConnectDialog(): void {
    if (!this.connecting()) this.connectDialogOpen.set(false);
  }

  selectConnection(connectionId: string): void {
    if (this.connections().some((connection) => connection.connectionId === connectionId)) {
      this.activeConnectionId.set(connectionId);
    }
  }

  async connect(configuration: PostgresConnectRequest): Promise<boolean> {
    this.connectError.set(null);
    this.connecting.set(true);
    try {
      const connection = await request<ConnectResponse>('/api/connections', {
        method: 'POST',
        body: JSON.stringify(configuration),
      });
      this.connections.update((current) => [
        ...current.filter(({ connectionId }) => connectionId !== connection.connectionId),
        connection,
      ]);
      this.activeConnectionId.set(connection.connectionId);
      this.connectDialogOpen.set(false);
      await this.loadResources(connection.connectionId).catch((error: unknown) => {
        this.setResourceError(connection.connectionId, errorMessage(error));
      });
      return true;
    } catch (error) {
      this.connectError.set(errorMessage(error));
      return false;
    } finally {
      this.connecting.set(false);
    }
  }

  async inspectTable(connectionId: string, schema: string, table: string): Promise<TableSnapshot> {
    const params = new URLSearchParams({ schema, table });
    return request<TableSnapshot>(
      `/api/connections/${encodeURIComponent(connectionId)}/tables?${params.toString()}`,
    );
  }

  private async restoreSessionConnections(): Promise<void> {
    try {
      const connections = await request<ConnectResponse[]>('/api/connections');
      this.connections.set(connections);
      const activeId = connections[0]?.connectionId ?? null;
      this.activeConnectionId.set(activeId);
      await Promise.all(connections.map((connection) =>
        this.loadResources(connection.connectionId).catch((error: unknown) => {
          this.setResourceError(connection.connectionId, errorMessage(error));
        }),
      ));
    } catch {
      // An unavailable API simply leaves the workspace disconnected.
    }
  }

  private async loadResources(connectionId: string): Promise<void> {
    const resources = await request<ResourceDescriptor[]>(
      `/api/connections/${encodeURIComponent(connectionId)}/resources`,
    );
    this.resourcesByConnection.update((current) => {
      const next = new Map(current);
      next.set(connectionId, resources);
      return next;
    });
    this.resourceErrorsByConnection.update((current) => {
      const next = new Map(current);
      next.delete(connectionId);
      return next;
    });
  }

  private setResourceError(connectionId: string, message: string): void {
    this.resourceErrorsByConnection.update((current) => {
      const next = new Map(current);
      next.set(connectionId, message);
      return next;
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'Unable to connect. Check that the QueryDock server is running and try again.';
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof payload === 'object' && payload !== null && 'message' in payload
      ? payload.message
      : undefined;
    throw new Error(typeof message === 'string' ? message : `Request failed (${response.status}).`);
  }
  return payload as T;
}
