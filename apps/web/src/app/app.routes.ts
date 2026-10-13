import { Routes } from '@angular/router';
import { QueryWorkspaceComponent } from './feature/workspace/query/query-workspace.component';
import { RunbookComponent } from './feature/workspace/runbook/runbook.component';
import { TableDataComponent } from './feature/workspace/table-data/table-data.component';
import { TableSchemaComponent } from './feature/workspace/table-schema/table-schema.component';
import { WorkspaceShellComponent } from './feature/workspace/workspace-shell/workspace-shell.component';

export const routes: Routes = [
  {
    path: '',
    component: WorkspaceShellComponent,
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'tables/customers/data' },
      { path: 'tables/:tableName/data', component: TableDataComponent },
      { path: 'tables/:tableName/schema', component: TableSchemaComponent },
      { path: 'query', component: QueryWorkspaceComponent },
      { path: 'runbook', component: RunbookComponent },
      { path: '**', redirectTo: 'tables/customers/data' },
    ],
  },
];
