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

@Injectable({ providedIn: 'root' })
export class WorkspacePagesService {
  private readonly router = inject(Router);
  private readonly connections = inject(ConnectionApiService);
  readonly pages = signal<TableSchemaPage[]>([]);
  private readonly currentRoute = signal(this.router.url);
  readonly activePage = computed(() => {
    const route = this.currentRoute();
    const connectionId = this.connections.activeConnectionId();
    return this.pages().find((page) => page.connectionId === connectionId && page.route === route) ?? null;
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
      void this.router.navigateByUrl('/');
    }
  }

  isActiveTable(connectionId: string, schema: string, table: string): boolean {
    const active = this.activePage();
    return active?.connectionId === connectionId && active.schema === schema && active.table === table;
  }
}
