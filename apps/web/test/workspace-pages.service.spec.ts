import '@angular/compiler';
import { Injector } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionApiService } from '../src/app/feature/workspace/connections/connection-api.service';
import { ForeignKeyEditorState } from '../src/app/feature/workspace/table-schema/foreign-key-editor-state';
import { WorkspacePagesService } from '../src/app/feature/workspace/workspace-pages.service';

function createHarness() {
  const events = new Subject<unknown>();
  const router = {
    url: '/',
    events,
    createUrlTree: vi.fn((commands: unknown[], options?: { queryParams?: Record<string, string> }) => ({ commands, options })),
    serializeUrl: vi.fn((tree: { commands: unknown[]; options?: { queryParams?: Record<string, string> } }) => {
      const path = tree.commands.join('/').replace(/^\//, '');
      const query = tree.options?.queryParams;
      return `/${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
    }),
    navigateByUrl: vi.fn(async () => true),
  };
  const connections = {
    activeConnectionId: vi.fn(),
    connections: vi.fn(),
    selectConnection: vi.fn(),
  };
  connections.activeConnectionId.mockReturnValue('connection-a');
  connections.connections.mockReturnValue([
    { connectionId: 'connection-a', target: { adapter: 'postgresql', host: 'db-a', port: 5432, database: 'alpha' } },
    { connectionId: 'connection-b', target: { adapter: 'postgresql', host: 'db-b', port: 5432, database: 'beta' } },
  ]);
  const injector = Injector.create({ providers: [
    { provide: Router, useValue: router },
    { provide: ConnectionApiService, useValue: connections },
    WorkspacePagesService,
  ] });
  const pages = injector.get(WorkspacePagesService);
  return { pages, router, connections, events, injector };
}

describe('WorkspacePagesService', () => {
  it('registers one tab for a table and reuses it on repeated opens', () => {
    const { pages } = createHarness();
    const first = pages.registerOpenedTableSchema('connection-a', 'public', 'orders');
    const reopened = pages.registerOpenedTableSchema('connection-a', 'public', 'orders');

    expect(reopened).toBe(first);
    expect(pages.pages()).toHaveLength(1);
    expect(first).toMatchObject({ label: 'orders', title: 'alpha · public.orders', route: '/tables/orders/schema?schema=public' });
  });

  it('keeps same-named tables from different connections as separate pages', () => {
    const { pages } = createHarness();
    const first = pages.registerOpenedTableSchema('connection-a', 'public', 'orders');
    const second = pages.registerOpenedTableSchema('connection-b', 'public', 'orders');

    expect(first.id).not.toBe(second.id);
    expect(pages.pages()).toHaveLength(2);
    expect(second.title).toBe('beta · public.orders');
  });

  it('creates independent table drafts, persists their data, and updates tab labels', () => {
    const { pages } = createHarness();
    const first = pages.registerOpenedCreateTable('public', 'draft-a');
    const second = pages.registerOpenedCreateTable('public', 'draft-b');
    const draft = { tableName: 'customer_archive', ifNotExists: true, fields: [] };

    pages.saveCreateTableDraft(first.id, draft);

    expect(pages.createTableDraft(first.id)).toEqual(draft);
    expect(pages.createTableDraft(second.id)).toBeNull();
    expect(pages.createTablePages().map(({ label }) => label)).toEqual([
      'New table (customer_archive)', 'New public table',
    ]);
    expect(pages.createTablePages()[0]?.title).toBe('Create public.customer_archive');
  });

  it('updates active tab from router navigation events', () => {
    const { pages, events } = createHarness();
    const page = pages.registerOpenedTableSchema('connection-a', 'public', 'orders');

    events.next(new NavigationEnd(1, '/', page.route));

    expect(pages.activePage()).toEqual(page);
  });

  it('renames a registered table page and produces the new route and title', () => {
    const { pages } = createHarness();
    const original = pages.registerOpenedTableSchema('connection-a', 'public', 'orders');

    const renamed = pages.renameTablePage('connection-a', 'public', 'orders', 'archived_orders');

    expect(renamed).toMatchObject({
      id: JSON.stringify(['connection-a', 'public', 'archived_orders']),
      table: 'archived_orders', label: 'archived_orders', title: 'alpha · public.archived_orders',
      route: '/tables/archived_orders/schema?schema=public',
    });
    expect(pages.pages()).toEqual([renamed]);
    expect(pages.renameTablePage('connection-a', 'public', 'missing', 'new_name')).toBeNull();
    expect(original.table).toBe('orders');
  });

  it('removes a closed draft and returns home when no workspace pages remain', () => {
    const { pages, router, events } = createHarness();
    const draftPage = pages.registerOpenedCreateTable('public', 'draft-a');
    pages.saveCreateTableDraft(draftPage.id, { tableName: 'scratch', ifNotExists: false, fields: [] });
    events.next(new NavigationEnd(1, '/', draftPage.route));
    expect(pages.activeCreateTablePage()).toMatchObject({ id: draftPage.id });
    pages.closeCreateTablePage(draftPage);

    expect(pages.createTablePages()).toEqual([]);
    expect(pages.createTableDraft(draftPage.id)).toBeNull();
    expect(router.navigateByUrl).toHaveBeenCalledWith('/');
  });

  it('selects a table tab by activating its connection and route', () => {
    const { pages, router, connections } = createHarness();
    const page = pages.registerOpenedTableSchema('connection-b', 'sales', 'invoices');

    pages.selectPage(page);

    expect(connections.selectConnection).toHaveBeenCalledWith('connection-b');
    expect(router.navigateByUrl).toHaveBeenCalledWith(page.route);
  });

  it('closes only the disconnected connection pages and discards its unsent table drafts', () => {
    const { pages, router, events } = createHarness();
    const disconnectedPage = pages.registerOpenedTableSchema('connection-a', 'public', 'orders');
    const remainingPage = pages.registerOpenedTableSchema('connection-b', 'public', 'orders');
    const createPage = pages.registerOpenedCreateTable('public', 'draft-a');
    pages.saveCreateTableDraft(createPage.id, { tableName: 'scratch', ifNotExists: false, fields: [] });
    events.next(new NavigationEnd(1, '/', disconnectedPage.route));

    pages.closeConnectionPages('connection-a');

    expect(pages.pages()).toEqual([remainingPage]);
    expect(pages.createTablePages()).toEqual([]);
    expect(pages.createTableDraft(createPage.id)).toBeNull();
    expect(router.navigateByUrl).toHaveBeenCalledWith(remainingPage.route);
  });
});

describe('ForeignKeyEditorState', () => {
  it('opens a selected row and clears the sidebar state when closed', () => {
    const state = new ForeignKeyEditorState();
    const row = {
      sourceName: 'orders_customer_fk', operationName: null, isUncommitted: false,
      kind: 'foreignKey', name: 'orders_customer_fk', fields: 'customer_id', references: 'public.customers(id)',
    };

    state.open(row);
    expect(state.row()).toEqual(row);
    state.close();
    expect(state.row()).toBeNull();
  });
});
