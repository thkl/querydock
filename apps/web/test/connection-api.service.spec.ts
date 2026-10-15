import '@angular/compiler';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectResponse } from '@querydock/contracts';
import { ConnectionApiService } from '../src/app/feature/workspace/connections/connection-api.service';

function connection(connectionId: string, database: string): ConnectResponse {
  return {
    connectionId,
    target: { adapter: 'postgresql', host: 'db.internal', port: 5432, database, username: 'reader' },
    serverVersion: '16.2',
    capabilities: {
      discoverResources: true,
      inspectTables: true,
      browseData: false,
      mutateData: false,
      editSchema: true,
      executeSql: false,
    },
    schemaCapabilities: { createTableIfNotExists: true },
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: body === null ? undefined : { 'Content-Type': 'application/json' },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('ConnectionApiService.disconnect', () => {
  it('clears the server session and client resources, then selects another open connection', async () => {
    const connections = [connection('connection-a', 'alpha'), connection('connection-b', 'beta')];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/connections') return response(connections);
      if (url.endsWith('/resources')) return response([{ schema: 'public', name: 'orders', kind: 'table', isUpdatable: true }]);
      if (init?.method === 'DELETE') return response(null, 204);
      return response({ message: 'Unexpected request.' }, 500);
    });
    vi.stubGlobal('fetch', fetchMock);
    const service = new ConnectionApiService();
    await vi.waitFor(() => expect(service.resourcesByConnection().size).toBe(2));
    service.activeConnectionId.set('connection-a');

    const disconnected = await service.disconnect('connection-a');

    expect(disconnected).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('/api/connections/connection-a', expect.objectContaining({ method: 'DELETE' }));
    expect(service.connections().map(({ connectionId }) => connectionId)).toEqual(['connection-b']);
    expect(service.activeConnectionId()).toBe('connection-b');
    expect(service.resourcesByConnection().has('connection-a')).toBe(false);
    expect(service.resourceErrorsByConnection().has('connection-a')).toBe(false);
    expect(service.disconnectError()).toBeNull();
  });

  it('preserves the selected connection and cached state when the server rejects disconnect', async () => {
    const active = connection('connection-a', 'alpha');
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/connections') return response([active]);
      if (url.endsWith('/resources')) return response([]);
      if (init?.method === 'DELETE') return response({ message: 'Database session expired. Reconnect to continue.' }, 401);
      return response({ message: 'Unexpected request.' }, 500);
    });
    vi.stubGlobal('fetch', fetchMock);
    const service = new ConnectionApiService();
    await vi.waitFor(() => expect(service.connections()).toHaveLength(1));
    service.activeConnectionId.set(active.connectionId);

    const disconnected = await service.disconnect(active.connectionId);

    expect(disconnected).toBe(false);
    expect(service.connections()).toEqual([active]);
    expect(service.activeConnectionId()).toBe(active.connectionId);
    expect(service.disconnectError()).toBe('Database session expired. Reconnect to continue.');
    expect(service.disconnectingId()).toBeNull();
  });
});
