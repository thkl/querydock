import { Routes } from '@angular/router';
import { WorkspaceShellComponent } from './feature/workspace/workspace-shell/workspace-shell.component';
import { WorkspaceHomeComponent } from './feature/workspace/workspace-home/workspace-home.component';

export const routes: Routes = [
  {
    path: '',
    component: WorkspaceShellComponent,
    children: [
      { path: '', component: WorkspaceHomeComponent },
      {
        path: 'tables/create',
        loadComponent: () =>
          import('./feature/workspace/table-create/table-create.component').then(
            (component) => component.TableCreateComponent,
          ),
      },
      {
        path: 'relationships',
        loadComponent: () =>
          import('./feature/workspace/relationship-diagram/relationship-diagram.component').then(
            (component) => component.RelationshipDiagramComponent,
          ),
      },
      {
        path: 'permissions',
        loadComponent: () =>
          import('./feature/workspace/connection-permissions/connection-permissions.component').then(
            (component) => component.ConnectionPermissionsComponent,
          ),
      },
      {
        path: 'tables/:tableName/data',
        loadComponent: () =>
          import('./feature/workspace/table-data/table-data.component').then(
            (component) => component.TableDataComponent,
          ),
      },
      {
        path: 'tables/:tableName/schema',
        loadComponent: () =>
          import('./feature/workspace/table-schema/table-schema.component').then(
            (component) => component.TableSchemaComponent,
          ),
      },
      {
        path: 'query',
        loadComponent: () =>
          import('./feature/workspace/query/query-workspace.component').then(
            (component) => component.QueryWorkspaceComponent,
          ),
      },
      {
        path: 'runbook',
        loadComponent: () =>
          import('./feature/workspace/runbook/runbook.component').then(
            (component) => component.RunbookComponent,
          ),
      },
      { path: '**', redirectTo: '' },
    ],
  },
];
