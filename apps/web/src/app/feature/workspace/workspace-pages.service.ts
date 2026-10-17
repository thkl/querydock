import { computed, inject, Injectable, signal } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';
import { ConnectionApiService } from './connections/connection-api.service';

export interface TableSchemaPage {
  id: string;
  connectionId: string;
  schema: string;
  table: string;
  label: string;
  title: string;
  route: string;
}

export interface TableDataPage {
  id: string;
  connectionId: string;
  schema: string;
  table: string;
  label: string;
  title: string;
  route: string;
}

export interface CreateTablePage {
  id: string;
  connectionId: string | null;
  schema: string;
  label: string;
  title: string;
  route: string;
}

export interface RelationshipDiagramPage {
  id: string;
  connectionId: string;
  label: string;
  title: string;
  route: string;
}

export interface CreateTableDraftField {
  id: number;
  name: string;
  type: string;
  typeDetails: string;
  nullable: boolean;
  defaultExpression: string;
  identityGeneration: 'none' | 'always' | 'byDefault';
}

export interface CreateTableDraft {
  tableName: string;
  fields: CreateTableDraftField[];
  ifNotExists: boolean;
}

@Injectable({ providedIn: 'root' })
export class WorkspacePagesService {
  private readonly router = inject(Router);
  private readonly connections = inject(ConnectionApiService);
  readonly pages = signal<TableSchemaPage[]>([]);
  readonly dataPages = signal<TableDataPage[]>([]);
  readonly createTablePages = signal<CreateTablePage[]>([]);
  readonly relationshipPages = signal<RelationshipDiagramPage[]>([]);
  readonly createTableDrafts = signal<ReadonlyMap<string, CreateTableDraft>>(new Map());
  private readonly dataRunbookPreferences = signal<ReadonlyMap<string, boolean>>(new Map());
  private readonly currentRoute = signal(this.router.url);
  readonly activePage = computed(() => {
    const route = this.currentRoute();
    const connectionId = this.connections.activeConnectionId();
    return this.pages().find((page) => page.connectionId === connectionId && page.route === route) ?? null;
  });
  readonly activeDataPage = computed(() => {
    const route = this.currentRoute();
    const connectionId = this.connections.activeConnectionId();
    return this.dataPages().find((page) => page.connectionId === connectionId && page.route === route) ?? null;
  });
  readonly activeCreateTablePage = computed(() => {
    const route = this.currentRoute();
    const connectionId = this.connections.activeConnectionId();
    return this.createTablePages().find((page) => page.connectionId === connectionId && page.route === route)
      ?? this.createTablePages().find((page) => page.route === route) ?? null;
  });
  readonly activeRelationshipPage = computed(() => {
    const route = this.currentRoute();
    const connectionId = this.connections.activeConnectionId();
    return this.relationshipPages().find((page) => page.connectionId === connectionId && page.route === route) ?? null;
  });

  /** Tracks router navigation so active tabs follow the current URL. */
  constructor() {
    this.router.events.pipe(filter((event) => event instanceof NavigationEnd))
      .subscribe((event) => this.currentRoute.set(event.urlAfterRedirects));
  }

  /** Registers, selects, and navigates to a table schema tab. */
  openTableSchema(connectionId: string, schema: string, table: string): void {
    const page = this.registerOpenedTableSchema(connectionId, schema, table);

    this.connections.selectConnection(connectionId);
    void this.router.navigateByUrl(page.route);
  }

  /** Registers, selects, and navigates to a table data tab. */
  openTableData(connectionId: string, schema: string, table: string): void {
    const page = this.registerOpenedTableData(connectionId, schema, table);
    this.connections.selectConnection(connectionId);
    void this.router.navigateByUrl(page.route);
  }

  /** Creates or returns the unique data tab for a connection, schema, and table. */
  registerOpenedTableData(connectionId: string, schema: string, table: string): TableDataPage {
    const id = this.dataPageId(connectionId, schema, table);
    console.log(`registerOPenTableData ${id}`);
    let page = this.dataPages().find((candidate) => candidate.id === id);
    if (!page) {
      const database = this.connections.connections()
        .find((connection) => connection.connectionId === connectionId)?.target.database;
      page = {
        id,
        connectionId,
        schema,
        table,
        label: `${table} · Data`,
        title: `${database ? `${database} · ` : ''}${schema}.${table} data`,
        route: this.router.serializeUrl(this.router.createUrlTree(
          ['/tables', table, 'data'], { queryParams: { schema } },
        )),
      };
      this.dataPages.update((pages) => [...pages, page!]);
    }
    return page;
  }

  /** Returns the data page's Runbook preference, which survives route component changes. */
  saveDataChangesToRunbook(connectionId: string, schema: string, table: string): boolean {
    return this.dataRunbookPreferences().get(this.dataPageId(connectionId, schema, table)) ?? false;
  }

  /** Stores the Runbook preference for one open data page. */
  setSaveDataChangesToRunbook(connectionId: string, schema: string, table: string, enabled: boolean): void {
    const id = this.dataPageId(connectionId, schema, table);
    this.dataRunbookPreferences.update((current) => {
      const next = new Map(current);
      next.set(id, enabled);
      return next;
    });
  }

  /** Activates a data tab and its owning database connection. */
  selectDataPage(page: TableDataPage): void {
    this.connections.selectConnection(page.connectionId);
    void this.router.navigateByUrl(page.route);
  }

  /** Closes a data tab and activates the next available workspace page. */
  closeDataPage(page: TableDataPage): void {
    const wasActive = this.activeDataPage()?.id === page.id;
    this.dataPages.update((pages) => pages.filter((candidate) => candidate.id !== page.id));
    this.dataRunbookPreferences.update((current) => {
      if (!current.has(page.id)) return current;
      const next = new Map(current);
      next.delete(page.id);
      return next;
    });
    if (!wasActive) return;
    const nextDataPage = this.dataPages().at(-1);
    if (nextDataPage) this.selectDataPage(nextDataPage);
    else {
      const nextTablePage = this.pages().at(-1);
      if (nextTablePage) this.selectPage(nextTablePage);
      else {
        const nextCreatePage = this.createTablePages().at(-1);
        if (nextCreatePage) this.selectCreateTablePage(nextCreatePage);
        else {
          const nextRelationshipPage = this.relationshipPages().at(-1);
          if (nextRelationshipPage) this.selectRelationshipPage(nextRelationshipPage);
          else void this.router.navigateByUrl('/');
        }
      }
    }
  }

  /** Creates a uniquely identified table draft tab and navigates to it. */
  openCreateTable(schema: string): void {
    const page = this.registerOpenedCreateTable(schema, crypto.randomUUID());
    void this.router.navigateByUrl(page.route);
  }

  /** Registers and navigates to the relationship diagram for a connection. */
  openRelationshipDiagram(connectionId: string): void {
    const page = this.registerOpenedRelationshipDiagram(connectionId);
    this.connections.selectConnection(connectionId);
    void this.router.navigateByUrl(page.route);
  }

  /** Registers the diagram tab and activates its connection without navigation. */
  prepareRelationshipDiagram(connectionId: string): void {
    this.registerOpenedRelationshipDiagram(connectionId);
    this.connections.selectConnection(connectionId);
  }

  /** Creates or returns the one relationship-diagram tab for a connection. */
  registerOpenedRelationshipDiagram(connectionId: string): RelationshipDiagramPage {
    let page = this.relationshipPages().find((candidate) => candidate.connectionId === connectionId);
    if (!page) {
      const database = this.connections.connections()
        .find((connection) => connection.connectionId === connectionId)?.target.database;
      page = {
        id: JSON.stringify(['relationships', connectionId]),
        connectionId,
        label: database ? `Relationships · ${database}` : 'Relationships',
        title: `${database ? `${database} · ` : ''}Relationships`,
        route: '/relationships',
      };
      this.relationshipPages.update((pages) => [...pages, page!]);
    }
    return page;
  }

  /** Activates a relationship tab and its database connection. */
  selectRelationshipPage(page: RelationshipDiagramPage): void {
    this.connections.selectConnection(page.connectionId);
    void this.router.navigateByUrl(page.route);
  }

  /** Closes a relationship tab and chooses another open workspace page. */
  closeRelationshipPage(page: RelationshipDiagramPage): void {
    const wasActive = this.activeRelationshipPage()?.id === page.id;
    const remaining = this.relationshipPages().filter((candidate) => candidate.id !== page.id);
    this.relationshipPages.set(remaining);
    if (!wasActive) return;
    const nextRelationshipPage = remaining.at(-1);
    if (nextRelationshipPage) {
      this.selectRelationshipPage(nextRelationshipPage);
      return;
    }
    const nextDataPage = this.dataPages().at(-1);
    if (nextDataPage) {
      this.selectDataPage(nextDataPage);
      return;
    }
    const nextTablePage = this.pages().at(-1);
    if (nextTablePage) this.selectPage(nextTablePage);
    else {
      const nextCreatePage = this.createTablePages().at(-1);
      if (nextCreatePage) this.selectCreateTablePage(nextCreatePage);
      else void this.router.navigateByUrl('/');
    }
  }

  /** Registers a new-table tab, restoring an existing draft when its ID is reused. */
  registerOpenedCreateTable(schema: string, draftId: string = crypto.randomUUID()): CreateTablePage {
    const connectionId = this.connections.activeConnectionId();
    let page = this.createTablePages().find((candidate) => candidate.id === draftId);
    if (!page) {
      page = {
        id: draftId,
        connectionId,
        schema,
        label: `New ${schema} table`,
        title: `Create table in ${schema}`,
        route: this.router.serializeUrl(this.router.createUrlTree(
          ['/tables/create'], { queryParams: { schema, draft: draftId } },
        )),
      };
      this.createTablePages.update((pages) => [...pages, page!]);
    }
    return page;
  }

  /** Returns the saved editor state for a new-table tab. */
  createTableDraft(pageId: string): CreateTableDraft | null {
    return this.createTableDrafts().get(pageId) ?? null;
  }

  /** Saves a draft and updates the tab label and title from its table name. */
  saveCreateTableDraft(pageId: string, draft: CreateTableDraft): void {
    this.createTableDrafts.update((current) => {
      const next = new Map(current);
      next.set(pageId, draft);
      return next;
    });
    const tableName = draft.tableName.trim();
    this.createTablePages.update((pages) => pages.map((page) => page.id !== pageId ? page : {
      ...page,
      label: tableName ? `New table (${tableName})` : `New ${page.schema} table`,
      title: tableName ? `Create ${page.schema}.${tableName}` : `Create table in ${page.schema}`,
    }));
  }

  /** Activates a new-table draft and restores its connection when present. */
  selectCreateTablePage(page: CreateTablePage): void {
    if (page.connectionId) this.connections.selectConnection(page.connectionId);
    void this.router.navigateByUrl(page.route);
  }

  /** Removes a draft tab and its local draft state, then activates a remaining page. */
  closeCreateTablePage(page: CreateTablePage): void {
    const wasActive = this.activeCreateTablePage()?.id === page.id;
    this.createTablePages.update((pages) => pages.filter((candidate) => candidate.id !== page.id));
    this.createTableDrafts.update((drafts) => {
      const next = new Map(drafts);
      next.delete(page.id);
      return next;
    });
    if (!wasActive) return;
    const nextCreatePage = this.createTablePages().at(-1);
    if (nextCreatePage) {
      this.selectCreateTablePage(nextCreatePage);
      return;
    }
    const nextDataPage = this.dataPages().at(-1);
    if (nextDataPage) {
      this.selectDataPage(nextDataPage);
      return;
    }
    const nextRelationshipPage = this.relationshipPages().at(-1);
    if (nextRelationshipPage) {
      this.selectRelationshipPage(nextRelationshipPage);
      return;
    }
    const nextTablePage = this.pages().at(-1);
    if (nextTablePage) this.selectPage(nextTablePage);
    else void this.router.navigateByUrl('/');
  }

  /** Removes successfully created table drafts and their saved editor state after Apply. */
  completeCreatedTableDrafts(
    connectionId: string,
    createdTables: { draftId?: string; table: string }[],
  ): void {
    if (!createdTables.length) return;
    const completedPages = this.createTablePages().filter((page) => createdTables.some(({ draftId, table }) => draftId
      ? page.id === draftId
      : page.connectionId === connectionId && this.createTableDraft(page.id)?.tableName.trim() === table));
    const completedIds = new Set(completedPages.map(({ id }) => id));

    this.createTablePages.update((pages) => pages.filter((page) => !completedIds.has(page.id)));
    this.createTableDrafts.update((drafts) => {
      const next = new Map(drafts);
      for (const id of completedIds) next.delete(id);
      return next;
    });
  }

  /** Creates or reuses the schema tab identified by connection, schema, and table. */
  registerOpenedTableSchema(connectionId: string, schema: string, table: string): TableSchemaPage {
    const id = JSON.stringify([connectionId, schema, table]);
    let page = this.pages().find((candidate) => candidate.id === id);
    if (!page) {
      const database = this.connections.connections()
        .find((connection) => connection.connectionId === connectionId)?.target.database;
      page = {
        id,
        connectionId,
        schema,
        table,
        label: table,
        title: `${database ? `${database} · ` : ''}${schema}.${table}`,
        route: this.router.serializeUrl(this.router.createUrlTree(
          ['/tables', table, 'schema'],
          { queryParams: { schema } },
        )),
      };
      this.pages.update((pages) => [...pages, page!]);
    }
    return page;
  }

  /** Activates a schema tab and its owning connection. */
  selectPage(page: TableSchemaPage): void {
    this.connections.selectConnection(page.connectionId);
     void this.router.navigateByUrl(page.route);
  }

  /** Closes a schema tab and activates the next available page. */
  closePage(page: TableSchemaPage): void {
    const wasActive = this.activePage()?.id === page.id;
    const remaining = this.pages().filter((candidate) => candidate.id !== page.id);
    this.pages.set(remaining);
    if (!wasActive) return;

    const nextPage = remaining.at(-1);
    if (nextPage) {
      this.connections.selectConnection(nextPage.connectionId);
      void this.router.navigateByUrl(nextPage.route);
    } else {
      const nextDataPage = this.dataPages().at(-1);
      if (nextDataPage) this.selectDataPage(nextDataPage);
      else {
        const nextCreatePage = this.createTablePages().at(-1);
        if (nextCreatePage) this.selectCreateTablePage(nextCreatePage);
        else {
          const nextRelationshipPage = this.relationshipPages().at(-1);
          if (nextRelationshipPage) this.selectRelationshipPage(nextRelationshipPage);
          else void this.router.navigateByUrl('/');
        }
      }
    }
  }

  /** Replaces a table tab's name, label, title, and route after a successful rename. */
  renameTablePage(connectionId: string, schema: string, oldName: string, newName: string): TableSchemaPage | null {
    const page = this.pages().find((candidate) => candidate.connectionId === connectionId
      && candidate.schema === schema && candidate.table === oldName);
    if (!page) return null;
    const route = this.router.serializeUrl(this.router.createUrlTree(
      ['/tables', newName, 'schema'], { queryParams: { schema } },
    ));
    const database = this.connections.connections().find((item) => item.connectionId === connectionId)?.target.database;
    const updated = {
      ...page,
      id: JSON.stringify([connectionId, schema, newName]),
      table: newName,
      label: newName,
      title: `${database ? `${database} · ` : ''}${schema}.${newName}`,
      route,
    };
    this.pages.update((pages) => pages.map((candidate) => candidate.id === page.id ? updated : candidate));
    return updated;
  }

  /** Finds and closes the schema tab for a renamed or dropped table. */
  closeTablePage(connectionId: string, schema: string, table: string): void {
    const page = this.pages().find((candidate) => candidate.connectionId === connectionId
      && candidate.schema === schema && candidate.table === table);
    if (page) this.closePage(page);
  }

  /** Removes every tab and draft owned by a disconnected database connection. */
  closeConnectionPages(connectionId: string): void {
    const currentRoute = this.currentRoute();
    const closesCurrentRoute = this.pages().some((page) => page.connectionId === connectionId && page.route === currentRoute)
      || this.dataPages().some((page) => page.connectionId === connectionId && page.route === currentRoute)
      || this.createTablePages().some((page) => page.connectionId === connectionId && page.route === currentRoute)
      || this.relationshipPages().some((page) => page.connectionId === connectionId && page.route === currentRoute);
    const removedDataPageIds = new Set(this.dataPages().filter((page) => page.connectionId === connectionId).map(({ id }) => id));
    this.pages.update((pages) => pages.filter((page) => page.connectionId !== connectionId));
    this.dataPages.update((pages) => pages.filter((page) => page.connectionId !== connectionId));
    this.dataRunbookPreferences.update((current) => {
      if (![...removedDataPageIds].some((id) => current.has(id))) return current;
      const next = new Map(current);
      for (const id of removedDataPageIds) next.delete(id);
      return next;
    });
    this.relationshipPages.update((pages) => pages.filter((page) => page.connectionId !== connectionId));
    const removedCreatePages = this.createTablePages().filter((page) => page.connectionId === connectionId);
    const removedIds = new Set(removedCreatePages.map(({ id }) => id));
    this.createTablePages.update((pages) => pages.filter((page) => page.connectionId !== connectionId));
    this.createTableDrafts.update((drafts) => {
      const next = new Map(drafts);
      for (const id of removedIds) next.delete(id);
      return next;
    });
    if (!closesCurrentRoute) return;

    const nextPage = this.pages().at(-1);
    if (nextPage) {
      this.selectPage(nextPage);
      return;
    }
    const nextDataPage = this.dataPages().at(-1);
    if (nextDataPage) {
      this.selectDataPage(nextDataPage);
      return;
    }
    const nextCreatePage = this.createTablePages().at(-1);
    if (nextCreatePage) {
      this.selectCreateTablePage(nextCreatePage);
      return;
    }
    const nextRelationshipPage = this.relationshipPages().at(-1);
    if (nextRelationshipPage) {
      this.selectRelationshipPage(nextRelationshipPage);
      return;
    }
    void this.router.navigateByUrl('/');
  }

  /** Checks whether a schema page is active for the given database table. */
  isActiveTable(connectionId: string, schema: string, table: string): boolean {
    const active = this.activePage();
    return active?.connectionId === connectionId && active.schema === schema && active.table === table;
  }

  /** Creates the stable workspace key shared by a data tab and its local view preferences. */
  private dataPageId(connectionId: string, schema: string, table: string): string {
    return JSON.stringify(['data', connectionId, schema, table]);
  }
}
