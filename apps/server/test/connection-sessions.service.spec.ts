import { HttpException, HttpStatus, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectResponse, PostgresConnectRequest } from '@querydock/contracts';
import { ConnectionSessionsService } from '../src/feature/connections/connection-sessions.service.ts';

const configuration: PostgresConnectRequest = {
  adapter: 'postgresql', host: 'localhost', port: 5432, database: 'querydock_test', username: 'tester',
  password: 'secret', sslMode: 'disable',
};

function request(cookie?: string, secure = false): Request {
  return { headers: { ...(cookie ? { cookie } : {}) }, secure } as Request;
}

function response() {
  const headers: Record<string, string> = {};
  return { headers, setHeader: (name: string, value: string) => { headers[name] = value; } } as unknown as Response & { headers: Record<string, string> };
}

function cookieFrom(responseValue: Response & { headers: Record<string, string> }): string {
  return responseValue.headers['Set-Cookie']?.split(';')[0] ?? '';
}

function summary(database: string): Omit<ConnectResponse, 'connectionId'> {
  return {
    serverVersion: '16.2',
    target: { adapter: 'postgresql', host: 'localhost', port: 5432, database, username: 'tester' },
    capabilities: {
      discoverResources: true, inspectTables: true, browseData: true,
      mutateData: true, editSchema: true, executeSql: true,
    },
    schemaCapabilities: { createTableIfNotExists: true },
  };
}

describe('ConnectionSessionsService', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps credentials server-side and restores connection summaries from the HttpOnly session cookie', () => {
    const service = new ConnectionSessionsService();
    const req = request(undefined, true);
    const res = response();
    const connected = service.addConnection(req, res, configuration, summary(configuration.database));
    const cookie = cookieFrom(res);

    expect(cookie).toMatch(/^qd_session=[A-Za-z0-9_-]{43}$/);
    expect(res.headers['Set-Cookie']).toContain('HttpOnly; SameSite=Strict');
    expect(res.headers['Set-Cookie']).toContain('Secure');
    expect(service.listConnections(request(cookie), response())).toEqual([connected]);
    expect(service.requireConnection(request(cookie), response(), connected.connectionId)).toEqual(configuration);
    expect(JSON.stringify(connected)).not.toContain(configuration.password);
    service.onModuleDestroy();
  });

  it('isolates connections by session and returns an empty list without a session', () => {
    const service = new ConnectionSessionsService();
    const firstResponse = response();
    const first = service.addConnection(request(), firstResponse, configuration, summary('querydock_test'));
    const firstCookie = cookieFrom(firstResponse);
    const otherResponse = response();
    const other = service.addConnection(request(), otherResponse, configuration, summary('querydock_other_test'));

    expect(service.listConnections(request(), response())).toEqual([]);
    expect(service.listConnections(request(firstCookie), response())).toEqual([first]);
    expect(service.listConnections(request(cookieFrom(otherResponse)), response())).toEqual([other]);
    service.onModuleDestroy();
  });

  it('removes one connection and clears the session cookie after the final connection closes', () => {
    const service = new ConnectionSessionsService();
    const createdResponse = response();
    const first = service.addConnection(request(), createdResponse, configuration, summary('querydock_test'));
    const cookie = cookieFrom(createdResponse);
    const second = service.addConnection(request(cookie), response(), configuration, summary('querydock_second_test'));

    service.removeConnection(request(cookie), response(), first.connectionId);
    expect(service.listConnections(request(cookie), response())).toEqual([second]);
    const finalResponse = response();
    service.removeConnection(request(cookie), finalResponse, second.connectionId);
    expect(finalResponse.headers['Set-Cookie']).toContain('Max-Age=0');
    expect(service.listConnections(request(cookie), response())).toEqual([]);
    service.onModuleDestroy();
  });

  it('rejects unknown connection IDs and caps each browser session at twelve connections', () => {
    const service = new ConnectionSessionsService();
    const createdResponse = response();
    service.addConnection(request(), createdResponse, configuration, summary('querydock_test'));
    const cookie = cookieFrom(createdResponse);
    expect(() => service.requireConnection(request(cookie), response(), 'missing')).toThrow(NotFoundException);

    let activeCookie = cookie;
    for (let index = 1; index < 12; index += 1) {
      const nextResponse = response();
      service.addConnection(request(activeCookie), nextResponse, configuration, summary(`db-${index}-test`));
      activeCookie = cookieFrom(nextResponse);
    }
    try {
      service.addConnection(request(activeCookie), response(), configuration, summary('overflow_test'));
      throw new Error('Expected the connection limit to be enforced.');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    }
    service.onModuleDestroy();
  });

  it('rejects malformed session cookies and removes an unknown connection with a not-found error', () => {
    const service = new ConnectionSessionsService();
    const malformed = response();
    expect(service.listConnections(request('qd_session=not-a-session'), malformed)).toEqual([]);

    const created = response();
    service.addConnection(request(), created, configuration, summary('querydock_test'));
    const cookie = cookieFrom(created);
    expect(() => service.removeConnection(request(cookie), response(), 'unknown'))
      .toThrow(NotFoundException);
    service.onModuleDestroy();
  });

  it('honors explicit secure-cookie configuration and clears its cleanup timer on shutdown', () => {
    vi.useFakeTimers();
    vi.stubEnv('QUERYDOCK_COOKIE_SECURE', 'false');
    const service = new ConnectionSessionsService();
    service.onModuleInit();
    expect(vi.getTimerCount()).toBe(1);

    const created = response();
    service.addConnection(request(undefined, true), created, configuration, summary('querydock_test'));
    expect(created.headers['Set-Cookie']).not.toContain('; Secure');
    service.onModuleDestroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('expires stale sessions and clears the browser cookie on access', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-14T10:00:00Z'));
    const service = new ConnectionSessionsService();
    const createdResponse = response();
    service.addConnection(request(), createdResponse, configuration, summary('querydock_test'));
    const cookie = cookieFrom(createdResponse);

    vi.advanceTimersByTime(31 * 60 * 1000);
    const expiredResponse = response();
    expect(service.listConnections(request(cookie), expiredResponse)).toEqual([]);
    expect(expiredResponse.headers['Set-Cookie']).toContain('Max-Age=0');
    expect(() => service.requireConnection(request(cookie), response(), 'any')).toThrow(UnauthorizedException);
    service.onModuleDestroy();
  });

  it('rejects removal from an expired session and clears its cookie', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-14T10:00:00Z'));
    const service = new ConnectionSessionsService();
    const created = response();
    const connection = service.addConnection(request(), created, configuration, summary('querydock_test'));
    const cookie = cookieFrom(created);
    vi.advanceTimersByTime(31 * 60 * 1000);
    const expired = response();

    expect(() => service.removeConnection(request(cookie), expired, connection.connectionId))
      .toThrow(UnauthorizedException);
    expect(expired.headers['Set-Cookie']).toContain('Max-Age=0');
    service.onModuleDestroy();
  });
});
