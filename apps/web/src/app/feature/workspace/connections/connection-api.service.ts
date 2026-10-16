import { computed, Injectable, signal } from '@angular/core';
import type {
  MigrationApplyRequest,
  MigrationApplyResponse,
  MigrationPreviewRequest,
  MigrationPreviewResponse,
  SchemaFieldDraftRequest,
  SchemaFieldDraftResponse,
  ConnectResponse,
  EditableFieldTypeDescriptor,
  ForeignKeyFieldChoices,
  PostgresConnectRequest,
  ResourceDescriptor,
  TableSnapshot,
  TableDataQueryRequest,
  TableDataQueryResponse,
} from '@querydock/contracts';
import { tableDataQueryResponseSchema } from '@querydock/contracts';

export class ApiRequestError extends Error {
  /** Retains the HTTP status while exposing the server's safe user-facing message. */
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

@Injectable({ providedIn: 'root' })
export class ConnectionApiService {
  readonly connections = signal<ConnectResponse[]>([]);
  readonly sessionRestoreComplete = signal(false);
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
    return [...groups].map(([schema, resources]) => ({
      schema,
      resources,
      canCreateTable: resources.some(({ canCreateTable }) => canCreateTable),
    }));
  });
  readonly connecting = signal(false);
  readonly disconnectingId = signal<string | null>(null);
  readonly connectError = signal<string | null>(null);
  readonly disconnectError = signal<string | null>(null);
  readonly connectDialogOpen = signal(false);

  constructor() {
    void this.restoreSessionConnections();
  }

  /** Opens the connection dialog and clears its previous request error. */
  openConnectDialog(): void {
    this.connectError.set(null);
    this.connectDialogOpen.set(true);
  }

  /** Closes the dialog unless a connection request is still running. */
  closeConnectDialog(): void {
    if (!this.connecting()) this.connectDialogOpen.set(false);
  }

  /** Selects a connection only when it belongs to the restored session. */
  selectConnection(connectionId: string): void {
    if (this.connections().some((connection) => connection.connectionId === connectionId)) {
      this.activeConnectionId.set(connectionId);
    }
  }

  /** Creates a server session connection, activates it, and loads its visible resources. */
  async connect(configuration: PostgresConnectRequest, closeOnSuccess = true): Promise<boolean> {
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
      if (closeOnSuccess) this.connectDialogOpen.set(false);
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

  /** Disconnects from the server and removes all client state for that connection. */
  async disconnect(connectionId: string): Promise<boolean> {
    this.disconnectError.set(null);
    this.disconnectingId.set(connectionId);
    try {
      await request<void>(`/api/connections/${encodeURIComponent(connectionId)}`, { method: 'DELETE' });
      this.connections.update((current) => current.filter(({ connectionId: id }) => id !== connectionId));
      this.resourcesByConnection.update((current) => {
        const next = new Map(current);
        next.delete(connectionId);
        return next;
      });
      this.resourceErrorsByConnection.update((current) => {
        const next = new Map(current);
        next.delete(connectionId);
        return next;
      });
      if (this.activeConnectionId() === connectionId) {
        this.activeConnectionId.set(this.connections()[0]?.connectionId ?? null);
      }
      return true;
    } catch (error) {
      this.disconnectError.set(errorMessage(error));
      return false;
    } finally {
      this.disconnectingId.set(null);
    }
  }

  /** Loads one table's schema snapshot for the active workspace feature. */
  async inspectTable(connectionId: string, schema: string, table: string): Promise<TableSnapshot> {
    const params = new URLSearchParams({ schema, table });
    return request<TableSnapshot>(
      `/api/connections/${encodeURIComponent(connectionId)}/tables?${params.toString()}`,
    );
  }

  /** Requests a page of table rows and validates the server response against the contract. */
  queryTableData(
    connectionId: string,
    schema: string,
    table: string,
    query: TableDataQueryRequest,
  ): Promise<TableDataQueryResponse> {
    const path = [connectionId, 'tables', schema, table, 'data', 'query'].map(encodeURIComponent).join('/');
    return request<unknown>(`/api/connections/${path}`, {
      method: 'POST',
      body: JSON.stringify(query),
    }).then((payload) => {
      const parsed = tableDataQueryResponseSchema.safeParse(payload);
      if (!parsed.success) throw new Error('The server returned an invalid table data response.');
      return parsed.data;
    });
  }

  /** Retrieves field type choices supplied by the connected database adapter. */
  async editableFieldTypes(connectionId: string): Promise<EditableFieldTypeDescriptor[]> {
    return request<EditableFieldTypeDescriptor[]>(
      `/api/connections/${encodeURIComponent(connectionId)}/schema/field-types`,
    );
  }

  /** Requests target key options compatible with the chosen local foreign-key fields. */
  foreignKeyFieldChoices(
    connectionId: string,
    schema: string,
    table: string,
    targetSchema: string,
    targetTable: string,
    localFieldNames: string[],
  ): Promise<ForeignKeyFieldChoices> {
    const path = [connectionId, 'tables', schema, table, 'foreign-key-targets', targetSchema, targetTable, 'fields']
      .map(encodeURIComponent).join('/');
    return request<ForeignKeyFieldChoices>(`/api/connections/${path}`, {
      method: 'POST',
      body: JSON.stringify({ localFieldNames }),
    });
  }

  /** Requests a server-generated migration preview for the staged operations. */
  previewMigration(connectionId: string, plan: MigrationPreviewRequest): Promise<MigrationPreviewResponse> {
    return request<unknown>(`/api/connections/${encodeURIComponent(connectionId)}/migrations/preview`, {
      method: 'POST',
      body: JSON.stringify(plan),
    }).then(parseMigrationPreview);
  }

  /** Previews one field editor draft and validates the returned operation list. */
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

  /** Applies the reviewed SQL and validates the server's confirmation snapshots. */
  applyMigration(connectionId: string, plan: MigrationApplyRequest): Promise<MigrationApplyResponse> {
    return request<unknown>(`/api/connections/${encodeURIComponent(connectionId)}/migrations/apply`, {
      method: 'POST',
      body: JSON.stringify(plan),
    }).then((payload) => parseMigrationApply(payload, plan));
  }

  /** Restores the server session after reload and refreshes resources for every connection. */
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
    } finally {
      this.sessionRestoreComplete.set(true);
    }
  }

  /** Replaces the cached resources for a connection and clears its previous load error. */
  private async loadResources(connectionId: string): Promise<ResourceDescriptor[]> {
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
    return resources;
  }

  /** Refreshes a connection's resource cache after a schema change. */
  refreshResources(connectionId: string): Promise<ResourceDescriptor[]> {
    return this.loadResources(connectionId);
  }

  /** Stores a resource-load failure without discarding the last known connection. */
  private setResourceError(connectionId: string, message: string): void {
    this.resourceErrorsByConnection.update((current) => {
      const next = new Map(current);
      next.set(connectionId, message);
      return next;
    });
  }
}

/** Converts thrown values into stable messages suitable for workspace notices. */
function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'Unable to connect. Check that the QueryDock server is running and try again.';
}

/** Sends same-origin API requests and translates network/HTTP failures to ApiRequestError. */
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

/** Checks migration preview payload shape before passing it into workspace state. */
function parseMigrationPreview(payload: unknown): MigrationPreviewResponse {
  if (isRecord(payload)
    && (typeof payload['baselineFingerprint'] === 'string' || payload['baselineFingerprint'] === null)
    && Array.isArray(payload['statements']) && payload['statements'].every((statement) => typeof statement === 'string')
    && Array.isArray(payload['warnings']) && payload['warnings'].every((warning) => typeof warning === 'string')) {
    return payload as unknown as MigrationPreviewResponse;
  }
  throw new Error('The server returned an invalid migration preview.');
}

/** Validates applied SQL and snapshots, allowing an empty snapshot only for a confirmed table drop. */
function parseMigrationApply(payload: unknown, plan: MigrationApplyRequest): MigrationApplyResponse {
  const snapshots = isRecord(payload) ? payload['snapshots'] : undefined;
  const isTableDrop = plan.operations.length === 1 && plan.operations[0]?.kind === 'dropTable';
  if (isRecord(payload)
    && Array.isArray(payload['appliedStatements']) && payload['appliedStatements'].every((statement) => typeof statement === 'string')
    && Array.isArray(snapshots) && (snapshots.length > 0 || isTableDrop) && snapshots.every((snapshot) => isRecord(snapshot)
      && typeof snapshot['schema'] === 'string'
      && typeof snapshot['name'] === 'string'
      && typeof snapshot['kind'] === 'string'
      && typeof snapshot['canAlter'] === 'boolean'
      && typeof snapshot['fingerprint'] === 'string'
      && Array.isArray(snapshot['fields'])
      && Array.isArray(snapshot['constraints']))) {
    return payload as unknown as MigrationApplyResponse;
  }
  throw new Error('The server did not return a valid confirmation for the migration.');
}

/** Narrows unknown JSON payloads to object records for response validation. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
