import { computed, Injectable, signal } from '@angular/core';
import type {
  MigrationApplyRequest,
  MigrationApplyResponse,
  MigrationPreviewRequest,
  MigrationPreviewResponse,
  SchemaFieldDraftRequest,
  SchemaFieldDraftResponse,
  ConnectResponse,
  PostgresConnectRequest,
  ResourceDescriptor,
  TableSnapshot,
} from '@querydock/contracts';

export class ApiRequestError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

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

  previewMigration(connectionId: string, plan: MigrationPreviewRequest): Promise<MigrationPreviewResponse> {
    return request<unknown>(`/api/connections/${encodeURIComponent(connectionId)}/migrations/preview`, {
      method: 'POST',
      body: JSON.stringify(plan),
    }).then(parseMigrationPreview);
  }

  previewSchemaFieldDraft(connectionId: string, draft: SchemaFieldDraftRequest): Promise<SchemaFieldDraftResponse> {
    return request<unknown>(`/api/connections/${encodeURIComponent(connectionId)}/migrations/field-draft`, {
      method: 'POST',
      body: JSON.stringify(draft),
    }).then((payload) => {
      const preview = parseMigrationPreview(payload);
      if (!isRecord(payload) || !Array.isArray(payload['operations'])) {
        throw new Error('The server returned an invalid schema field preview.');
      }
      return { ...preview, operations: payload['operations'] } as SchemaFieldDraftResponse;
    });
  }

  applyMigration(connectionId: string, plan: MigrationApplyRequest): Promise<MigrationApplyResponse> {
    return request<unknown>(`/api/connections/${encodeURIComponent(connectionId)}/migrations/apply`, {
      method: 'POST',
      body: JSON.stringify(plan),
    }).then(parseMigrationApply);
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
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      credentials: 'same-origin',
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch (error) {
    throw new ApiRequestError(errorMessage(error), null);
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof payload === 'object' && payload !== null && 'message' in payload
      ? payload.message
      : undefined;
    throw new ApiRequestError(typeof message === 'string' ? message : `Request failed (${response.status}).`, response.status);
  }
  return payload as T;
}

function parseMigrationPreview(payload: unknown): MigrationPreviewResponse {
  if (isRecord(payload)
    && typeof payload['baselineFingerprint'] === 'string'
    && Array.isArray(payload['statements']) && payload['statements'].every((statement) => typeof statement === 'string')
    && Array.isArray(payload['warnings']) && payload['warnings'].every((warning) => typeof warning === 'string')) {
    return payload as unknown as MigrationPreviewResponse;
  }
  throw new Error('The server returned an invalid migration preview.');
}

function parseMigrationApply(payload: unknown): MigrationApplyResponse {
  const snapshot = isRecord(payload) ? payload['snapshot'] : undefined;
  if (isRecord(payload)
    && Array.isArray(payload['appliedStatements']) && payload['appliedStatements'].every((statement) => typeof statement === 'string')
    && isRecord(snapshot)
    && typeof snapshot['schema'] === 'string'
    && typeof snapshot['name'] === 'string'
    && typeof snapshot['kind'] === 'string'
    && typeof snapshot['canAlter'] === 'boolean'
    && typeof snapshot['fingerprint'] === 'string'
    && Array.isArray(snapshot['fields'])
    && Array.isArray(snapshot['constraints'])) {
    return payload as unknown as MigrationApplyResponse;
  }
  throw new Error('The server did not return a valid confirmation for the migration.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
