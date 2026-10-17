import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { AgridDataSource, AgridTreeComponent, AgridTreeProvider } from '@thkl/agrid';
import type { AgridTreeContextMenuItem, AgridTreeNodeEvent, AgridTreeNodeMenuAction } from '@thkl/agrid';
import type { ResourceDescriptor } from '@querydock/contracts';
import { ConnectionApiService } from '../connections/connection-api.service';
import { ConnectionVaultService } from '../connections/connection-vault.service';
import { WorkspacePagesService } from '../workspace-pages.service';

type ExplorerNodeKind = 'connection' | 'schema' | 'category' | 'resource' | 'relationships' | 'permissions' | 'empty' | 'error';

interface ExplorerTreeNode {
  id: string;
  parentId: string | null;
  label: string;
  description?: string;
  kind: ExplorerNodeKind;
  connectionId: string;
  schema?: string;
  resourceName?: string;
  resourceKind?: ResourceDescriptor['kind'];
  canCreateTable?: boolean;
  canBrowseData?: boolean;
}

/** Database navigation sidebar backed by aGrid's standalone hierarchical tree. */
@Component({
  selector: 'qd-workspace-sidebar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive, AgridTreeComponent],
  templateUrl: './workspace-sidebar.component.html',
  styleUrl: './workspace-sidebar.component.css',
})
export class WorkspaceSidebarComponent {
  readonly connections = inject(ConnectionApiService);
  readonly vault = inject(ConnectionVaultService);
  readonly pages = inject(WorkspacePagesService);
  readonly mobileTreeOpen = signal(false);
  readonly treeProvider = signal(this.createTreeProvider([]));
  private treeStructureKey = '';

  constructor() {
    effect(() => {
      const rows = this.buildTreeRows();
      const structureKey = rows.map(({ id, parentId, label, description, kind, resourceKind, canCreateTable, canBrowseData }) =>
        `${id}\u0000${parentId ?? ''}\u0000${label}\u0000${description ?? ''}\u0000${kind}\u0000${resourceKind ?? ''}\u0000${canCreateTable ?? ''}\u0000${canBrowseData ?? ''}`).join('\u0001');
      if (structureKey === this.treeStructureKey) return;
      this.treeStructureKey = structureKey;
      this.treeProvider.set(this.createTreeProvider(rows));
    });
  }

  /** Closes the narrow-screen navigation drawer after a destination is chosen. */
  closeMobileTree(): void {
    this.mobileTreeOpen.set(false);
  }

  /** Toggles the database navigation drawer on narrow screens. */
  toggleMobileTree(): void {
    this.mobileTreeOpen.update((open) => !open);
  }

  /** Formats a connection tree label using its saved name or database target. */
  connectionLabel(connectionId: string): string {
    const connection = this.connections.connections().find(({ connectionId: id }) => id === connectionId);
    if (!connection) return 'Disconnected';
    const saved = this.vault.profiles().find(({ configuration }) =>
      configuration.adapter === connection.target.adapter
      && configuration.host === connection.target.host
      && configuration.port === connection.target.port
      && configuration.database === connection.target.database
      && configuration.username === connection.target.username);
    if (saved?.name.trim()) return saved.name.trim();
    const { target } = connection;
    return `${target.database} · ${target.host}:${target.port} · ${target.username}`;
  }

  /** Confirms and closes a connection and its workspace tabs. */
  async disconnect(connectionId: string): Promise<void> {
    const disconnected = await this.connections.disconnect(connectionId);
    if (disconnected) this.pages.closeConnectionPages(connectionId);
  }

  /** Handles a row click, opening resources and activating connection diagrams. */
  onTreeNodeClick(event: AgridTreeNodeEvent<ExplorerTreeNode>): void {
    const row = event.row;
    if (!row) return;
    switch (row.kind) {
      case 'connection':
        this.connections.selectConnection(row.connectionId);
        break;
      case 'resource':
        this.pages.openTableSchema(row.connectionId, row.schema!, row.resourceName!);
        this.closeMobileTree();
        break;
      case 'relationships':
        this.pages.openRelationshipDiagram(row.connectionId);
        this.closeMobileTree();
        break;
      case 'permissions':
        this.pages.openPermissionReport(row.connectionId);
        this.closeMobileTree();
        break;
      case 'schema':
      case 'category':
        this.connections.selectConnection(row.connectionId);
        break;
    }
  }

  /** Routes aGrid's per-node menu actions to the corresponding workspace operation. */
  async onTreeMenuAction(event: AgridTreeNodeMenuAction<ExplorerTreeNode>): Promise<void> {
    const row = event.node.row;
    if (!row) return;
    switch (event.id) {
      case 'disconnect':
        await this.disconnect(row.connectionId);
        break;
      case 'create-table':
        if (row.schema) {
          this.connections.selectConnection(row.connectionId);
          this.pages.openCreateTable(row.schema);
        }
        this.closeMobileTree();
        break;
      case 'open-schema':
        if (row.schema && row.resourceName) {
          this.pages.openTableSchema(row.connectionId, row.schema, row.resourceName);
        }
        this.closeMobileTree();
        break;
      case 'browse-data':
        if (row.schema && row.resourceName) {
          this.pages.openTableData(row.connectionId, row.schema, row.resourceName);
        }
        this.closeMobileTree();
        break;
      case 'open-relationships':
        this.pages.openRelationshipDiagram(row.connectionId);
        this.closeMobileTree();
        break;
      case 'open-permissions':
        this.pages.openPermissionReport(row.connectionId);
        this.closeMobileTree();
        break;
    }
  }

  /** Creates a stable provider; replacing it on structural changes reapplies default expansion. */
  private createTreeProvider(rows: ExplorerTreeNode[]): AgridTreeProvider<ExplorerTreeNode> {
    return new AgridTreeProvider<ExplorerTreeNode>({
      datasource: new AgridDataSource(rows),
      treeConfig: {
        getId: (row) => row.id,
        getParentId: (row) => row.parentId,
        treeField: 'label',
        defaultExpanded: true,
      },
      getLabel: (row) => this.treeLabel(row),
      getDescription: (row) => row.description,
      getNodeClass: (row) => this.treeNodeClass(row),
      contextMenuItems: (node) => this.menuItems(node),
      selection: 'single',
      rowHeight: 34,
      ariaLabel: 'Database connections and objects',
      emptyText: 'Connect to a database to inspect schemas and tables.',
    });
  }

  /** Builds connection → schema → object rows from the resources already cached per connection. */
  private buildTreeRows(): ExplorerTreeNode[] {
    const connections = this.connections.connections();
    const resourcesByConnection = this.connections.resourcesByConnection();
    const errorsByConnection = this.connections.resourceErrorsByConnection();
    const rows: ExplorerTreeNode[] = [];

    for (const connection of connections) {
      const connectionId = connection.connectionId;
      const connectionNodeId = `connection:${connectionId}`;
      rows.push({
        id: connectionNodeId,
        parentId: null,
        label: this.connectionLabel(connectionId),
        description: `${connection.target.adapter} · ${connection.target.database} · ${connection.target.host}:${connection.target.port}`,
        kind: 'connection',
        connectionId,
      });

      const resources = resourcesByConnection.get(connectionId) ?? [];
      const bySchema = new Map<string, ResourceDescriptor[]>();
      for (const resource of resources) {
        const schemaResources = bySchema.get(resource.schema) ?? [];
        schemaResources.push(resource);
        bySchema.set(resource.schema, schemaResources);
      }

      for (const [schema, schemaResources] of bySchema) {
        const schemaNodeId = `schema:${connectionId}:${schema}`;
        rows.push({
          id: schemaNodeId,
          parentId: connectionNodeId,
          label: schema,
          description: `${schemaResources.length} ${schemaResources.length === 1 ? 'object' : 'objects'}`,
          kind: 'schema',
          connectionId,
          schema,
          canCreateTable: schemaResources.some(({ canCreateTable }) => canCreateTable),
        });

        const categories = [
          {
            id: 'tables',
            label: 'Tables',
            resources: schemaResources.filter(({ kind }) => ['table', 'partitionedTable', 'foreignTable'].includes(kind)),
          },
          {
            id: 'views',
            label: 'Views',
            resources: schemaResources.filter(({ kind }) => ['view', 'materializedView'].includes(kind)),
          },
        ].filter(({ resources: categoryResources }) => categoryResources.length > 0);

        for (const category of categories) {
          const categoryNodeId = `category:${connectionId}:${schema}:${category.id}`;
          rows.push({
            id: categoryNodeId,
            parentId: schemaNodeId,
            label: category.label,
            description: `${category.resources.length}`,
            kind: 'category',
            connectionId,
            schema,
          });
          for (const resource of category.resources) {
            rows.push({
              id: `resource:${connectionId}:${schema}:${resource.kind}:${resource.name}`,
              parentId: categoryNodeId,
              label: resource.name,
              description: category.id === 'views' ? 'View definition' : 'Table structure',
              kind: 'resource',
              connectionId,
              schema,
              resourceName: resource.name,
              resourceKind: resource.kind,
              canBrowseData: resource.canBrowseData ?? connection.capabilities.browseData,
            });
          }
        }
      }

      const resourceError = errorsByConnection.get(connectionId);
      if (resourceError) {
        rows.push({
          id: `error:${connectionId}`,
          parentId: connectionNodeId,
          label: 'Resource discovery failed',
          description: resourceError,
          kind: 'error',
          connectionId,
        });
      } else if (!resources.length) {
        rows.push({
          id: `empty:${connectionId}`,
          parentId: connectionNodeId,
          label: 'No visible tables or views',
          kind: 'empty',
          connectionId,
        });
      }

      rows.push({
        id: `relationships:${connectionId}`,
        parentId: connectionNodeId,
        label: 'Relationships',
        description: 'Database diagram',
        kind: 'relationships',
        connectionId,
      });
      rows.push({
        id: `permissions:${connectionId}`,
        parentId: connectionNodeId,
        label: 'Permissions',
        description: 'Current database access',
        kind: 'permissions',
        connectionId,
      });
    }
    return rows;
  }

  /** Adds small object-kind markers while keeping the raw object name in the datasource. */
  private treeLabel(row: ExplorerTreeNode): string {
    switch (row.kind) {
      case 'connection': return `◉  ${row.label}`;
      case 'schema': return `▱  ${row.label}`;
      case 'category': return row.label;
      case 'resource': return `${row.resourceKind === 'view' || row.resourceKind === 'materializedView' ? '◉' : '▦'}  ${row.label}`;
      case 'relationships': return `⌘  ${row.label}`;
      case 'permissions': return `⌑  ${row.label}`;
      case 'error': return `!  ${row.label}`;
      default: return row.label;
    }
  }

  /** Marks active connections and workspace objects without coupling selection to the route. */
  private treeNodeClass(row: ExplorerTreeNode): string {
    const classes = [`tree-node-${row.kind}`];
    if (row.kind === 'connection' && this.connections.activeConnectionId() === row.connectionId) {
      classes.push('tree-node-active-connection');
    }
    if (row.kind === 'resource' && row.schema && row.resourceName
      && this.pages.isActiveTable(row.connectionId, row.schema, row.resourceName)) {
      classes.push('tree-node-active-page');
    }
    return classes.join(' ');
  }

  /** Supplies the relevant actions for each connection, schema, or table/view row. */
  private menuItems(node: AgridTreeNodeEvent<ExplorerTreeNode>): AgridTreeContextMenuItem[] {
    const row = node.row;
    if (!row) return [];
    switch (row.kind) {
      case 'connection':
        return [{
          id: 'disconnect',
          label: 'Disconnect',
          danger: true,
          confirm: {
            title: 'Disconnect database?',
            message: 'This closes the connection and its open table pages. Unsubmitted table drafts will be discarded; Runbook changes remain.',
            confirmLabel: 'Disconnect',
          },
        }];
      case 'schema':
        return row.canCreateTable ? [{ id: 'create-table', label: 'Create table' }] : [];
      case 'resource':
        return [
          { id: 'open-schema', label: row.resourceKind === 'view' || row.resourceKind === 'materializedView' ? 'Open view definition' : 'Open table structure' },
          ...(row.canBrowseData ? [{ id: 'browse-data', label: 'Browse data' }] : []),
        ];
      case 'relationships':
        return [{ id: 'open-relationships', label: 'Open relationship diagram' }];
      case 'permissions':
        return [{ id: 'open-permissions', label: 'View database permissions' }];
      default:
        return [];
    }
  }
}
