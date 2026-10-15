import {
  Injectable,
  HttpException,
  HttpStatus,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { ConnectResponse, PostgresConnectRequest } from '@querydock/contracts';

const SESSION_COOKIE = 'qd_session';
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_CONNECTIONS_PER_SESSION = 12;

interface SessionConnection {
  configuration: PostgresConnectRequest;
  summary: ConnectResponse;
}

interface BrowserSession {
  expiresAt: number;
  connections: Map<string, SessionConnection>;
}

@Injectable()
export class ConnectionSessionsService implements OnModuleInit, OnModuleDestroy {
  private readonly sessions = new Map<string, BrowserSession>();
  private cleanupTimer?: NodeJS.Timeout;

  onModuleInit(): void {
    this.cleanupTimer = setInterval(() => this.removeExpiredSessions(), 60_000);
    this.cleanupTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.sessions.clear();
  }

  addConnection(
    request: Request,
    response: Response,
    configuration: PostgresConnectRequest,
    summary: Omit<ConnectResponse, 'connectionId'>,
  ): ConnectResponse {
    this.removeExpiredSessions();
    const { sessionId, session } = this.getOrCreateSession(request);
    if (session.connections.size >= MAX_CONNECTIONS_PER_SESSION) {
      throw new HttpException('This browser session has reached its connection limit.', HttpStatus.TOO_MANY_REQUESTS);
    }

    const connection: ConnectResponse = { ...summary, connectionId: randomUUID() };
    session.connections.set(connection.connectionId, { configuration, summary: connection });
    this.touchSession(session);
    this.writeSessionCookie(request, response, sessionId);
    return connection;
  }

  listConnections(request: Request, response: Response): ConnectResponse[] {
    const sessionId = this.sessionIdFromRequest(request);
    if (!sessionId) return [];
    const session = this.sessions.get(sessionId);
    if (!session || session.expiresAt <= Date.now()) {
      this.sessions.delete(sessionId);
      this.clearSessionCookie(request, response);
      return [];
    }

    this.touchSession(session);
    this.writeSessionCookie(request, response, sessionId);
    return [...session.connections.values()].map(({ summary }) => summary);
  }

  requireConnection(
    request: Request,
    response: Response,
    connectionId: string,
  ): PostgresConnectRequest {
    const sessionId = this.sessionIdFromRequest(request);
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session || session.expiresAt <= Date.now()) {
      if (sessionId) this.sessions.delete(sessionId);
      this.clearSessionCookie(request, response);
      throw new UnauthorizedException('Database session expired. Reconnect to continue.');
    }

    const connection = session.connections.get(connectionId);
    if (!connection) throw new NotFoundException('Connection not found in this browser session.');

    this.touchSession(session);
    this.writeSessionCookie(request, response, sessionId!);
    return connection.configuration;
  }

  removeConnection(request: Request, response: Response, connectionId: string): void {
    const sessionId = this.sessionIdFromRequest(request);
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session || session.expiresAt <= Date.now()) {
      if (sessionId) this.sessions.delete(sessionId);
      this.clearSessionCookie(request, response);
      throw new UnauthorizedException('Database session expired. Reconnect to continue.');
    }
    if (!session.connections.delete(connectionId)) {
      throw new NotFoundException('Connection not found in this browser session.');
    }
    if (session.connections.size === 0) {
      this.sessions.delete(sessionId!);
      this.clearSessionCookie(request, response);
      return;
    }
    this.touchSession(session);
    this.writeSessionCookie(request, response, sessionId!);
  }

  private getOrCreateSession(request: Request): { sessionId: string; session: BrowserSession } {
    const existingId = this.sessionIdFromRequest(request);
    const existing = existingId ? this.sessions.get(existingId) : undefined;
    if (existing && existing.expiresAt > Date.now()) {
      return { sessionId: existingId!, session: existing };
    }

    if (existingId) this.sessions.delete(existingId);
    const sessionId = randomBytes(32).toString('base64url');
    const session: BrowserSession = { expiresAt: Date.now() + SESSION_TTL_MS, connections: new Map() };
    this.sessions.set(sessionId, session);
    return { sessionId, session };
  }

  private sessionIdFromRequest(request: Request): string | undefined {
    const cookieHeader = request.headers.cookie;
    if (!cookieHeader) return undefined;
    for (const cookie of cookieHeader.split(';')) {
      const [name, ...valueParts] = cookie.trim().split('=');
      if (name !== SESSION_COOKIE) continue;
      try {
        const value = decodeURIComponent(valueParts.join('='));
        return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  private touchSession(session: BrowserSession): void {
    session.expiresAt = Date.now() + SESSION_TTL_MS;
  }

  private writeSessionCookie(request: Request, response: Response, sessionId: string): void {
    const secure = this.useSecureCookie(request) ? '; Secure' : '';
    response.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=${sessionId}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure}`,
    );
  }

  private clearSessionCookie(request: Request, response: Response): void {
    const secure = this.useSecureCookie(request) ? '; Secure' : '';
    response.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0${secure}`,
    );
  }

  private useSecureCookie(request: Request): boolean {
    const configured = process.env['QUERYDOCK_COOKIE_SECURE']?.trim().toLowerCase();
    if (configured === 'true') return true;
    if (configured === 'false') return false;
    return request.secure || process.env['NODE_ENV'] === 'production';
  }

  private removeExpiredSessions(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(sessionId);
    }
  }
}
