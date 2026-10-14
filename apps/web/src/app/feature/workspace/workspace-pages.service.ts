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

export interface CreateTablePage {
  id: string;
  connectionId: string | null;
  schema: string;
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
  readonly createTablePages = signal<CreateTablePage[]>([]);
  readonly createTableDrafts = signal<ReadonlyMap<string, CreateTableDraft>>(new Map());
  private readonly currentRoute = signal(this.router.url);
  readonly activePage = computed(() => {
    const route = this.currentRoute();
    const connectionId = this.connections.activeConnectionId();
    return this.pages().find((page) => page.connectionId === connectionId && page.route === route) ?? null;
  });
  readonly activeCreateTablePage = computed(() => {
    const route = this.currentRoute();
    const connectionId = this.connections.activeConnectionId();
    return this.createTablePages().find((page) => page.connectionId === connectionId && page.route === route)
      ?? this.createTablePages().find((page) => page.route === route) ?? null;
  });

  constructor() {
    this.router.events.pipe(filter((event) => event instanceof NavigationEnd))
      .subscribe((event) => this.currentRoute.set(event.urlAfterRedirects));
  }

  openTableSchema(connectionId: string, schema: string, table: string): void {
    const page = this.registerOpenedTableSchema(connectionId, schema, table);

    this.connections.selectConnection(connectionId);
    void this.router.navigateByUrl(page.route);
  }

  openCreateTable(schema: string): void {
    const page = this.registerOpenedCreateTable(schema, crypto.randomUUID());
    void this.router.navigateByUrl(page.route);
  }

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

  createTableDraft(pageId: string): CreateTableDraft | null {
    return this.createTableDrafts().get(pageId) ?? null;
  }

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

  selectCreateTablePage(page: CreateTablePage): void {
    if (page.connectionId) this.connections.selectConnection(page.connectionId);
    void this.router.navigateByUrl(page.route);
  }

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
    const nextTablePage = this.pages().at(-1);
    if (nextTablePage) this.selectPage(nextTablePage);
    else void this.router.navigateByUrl('/');
  }

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

  selectPage(page: TableSchemaPage): void {
    this.connections.selectConnection(page.connectionId);
     void this.router.navigateByUrl(page.route);
  }

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
      const nextCreatePage = this.createTablePages().at(-1);
      if (nextCreatePage) this.selectCreateTablePage(nextCreatePage);
      else void this.router.navigateByUrl('/');
    }
  }

  isActiveTable(connectionId: string, schema: string, table: string): boolean {
    const active = this.activePage();
    return active?.connectionId === connectionId && active.schema === schema && active.table === table;
  }
}
