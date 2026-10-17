import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SqlEditorComponent } from '../sql-editor/sql-editor.component';
import { RunbookService, type SchemaRunbook, type SchemaRunbookTableChange } from './runbook.service';
import { ConfirmationDialogService } from '../confirmation/confirmation-dialog.service';
import { WorkspacePagesService } from '../workspace-pages.service';
import { ConnectionApiService } from '../connections/connection-api.service';

@Component({
  selector: 'qd-runbook',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, SqlEditorComponent],
  templateUrl: './runbook.component.html',
  styleUrl: './runbook.component.css',
})
export class RunbookComponent {
  readonly runbook = inject(RunbookService);
  private readonly confirmation = inject(ConfirmationDialogService);
  private readonly workspacePages = inject(WorkspacePagesService);
  private readonly connections = inject(ConnectionApiService);

  /** Confirms warnings, applies the batch, and synchronizes affected workspace tabs. */
  async apply(): Promise<void> {
    const warnings = this.runbook.runbook()?.preview?.warnings ?? [];
    let acknowledgedWarnings: string[] = [];
    if (warnings.length) {
      const confirmed = await this.confirmation.confirm({
        title: 'Review migration warnings',
        message: `${warnings.join(' ')} Applying confirms you reviewed these risks for this batch.`,
        confirmLabel: 'Acknowledge and apply',
        intent: 'warning',
      });
      if (!confirmed) return;
      acknowledgedWarnings = warnings;
    }
    const state = this.runbook.runbook();
    const tableChanges = state ? this.tableChangesOf(state) : [];
    try {
      await this.runbook.applyPending(acknowledgedWarnings);
      if (!state) return;
      const connectionId = this.connectionIdFor(state);
      this.removeAppliedCreateDraftTabs(state, connectionId, tableChanges);
      if (connectionId) for (const change of tableChanges) {
        const tableOperation = change.operations.find((operation) =>
          operation.kind === 'renameTable' || operation.kind === 'dropTable');
        if (tableOperation?.kind === 'renameTable') {
          const page = this.workspacePages.renameTablePage(connectionId, change.schema, change.table, tableOperation.newName);
          if (page) this.workspacePages.selectPage(page);
        } else if (tableOperation?.kind === 'dropTable') {
          this.workspacePages.closeTablePage(connectionId, change.schema, change.table);
        }
      }
    } catch {
      // The runbook service exposes the detailed failure message in the workspace.
    }
  }

  /** Discards the current staged operations. */
  discard(): void {
    void this.runbook.discardPending();
  }

  /** Downloads SQL from batches that the server previously confirmed as applied. */
  export(): void {
    void this.runbook.exportAppliedSql();
  }

  /** Confirms and reconciles a batch whose database outcome could not be determined. */
  async resolveUnknown(outcome: 'applied' | 'notApplied'): Promise<void> {
    const message = outcome === 'applied'
      ? 'Confirm only after inspecting the database and verifying that the entire batch was applied.'
      : 'Confirm only after inspecting the database and verifying that none of the batch was applied.';
    const confirmed = await this.confirmation.confirm({
      title: outcome === 'applied' ? 'Confirm the batch was applied' : 'Confirm the batch was not applied',
      message,
      confirmLabel: outcome === 'applied' ? 'Confirm applied' : 'Confirm not applied',
      intent: 'warning',
    });
    if (!confirmed) return;
    const state = this.runbook.runbook();
    const tableChanges = state ? this.tableChangesOf(state) : [];
    try {
      await this.runbook.resolveUnknownApply(outcome);
      if (outcome !== 'applied' || !state) return;
      const connectionId = this.connectionIdFor(state);
      this.removeAppliedCreateDraftTabs(state, connectionId, tableChanges);
      if (connectionId) for (const change of tableChanges) {
        const tableOperation = change.operations.find((operation) =>
          operation.kind === 'renameTable' || operation.kind === 'dropTable');
        if (tableOperation?.kind === 'renameTable') {
          const page = this.workspacePages.renameTablePage(connectionId, change.schema, change.table, tableOperation.newName);
          if (page) this.workspacePages.selectPage(page);
        } else if (tableOperation?.kind === 'dropTable') {
          this.workspacePages.closeTablePage(connectionId, change.schema, change.table);
        }
      }
    } catch (error) {
      this.runbook.reportError(error);
    }
  }

  /** Asks before deleting the saved runbook and its locally recorded SQL history. */
  async clearRunbook(): Promise<void> {
    const confirmed = await this.confirmation.confirm({
      title: 'Clear this runbook?',
      message: 'This removes the runbook and all locally stored applied SQL. Export applied SQL first if you still need it.',
      confirmLabel: 'Clear runbook',
      intent: 'danger',
    });
    if (!confirmed) return;
    void this.runbook.clearRunbook();
  }

  /** Removes the editor tabs for create operations confirmed by the applied batch. */
  private removeAppliedCreateDraftTabs(
    state: SchemaRunbook,
    connectionId: string | null,
    changes = this.tableChangesOf(state),
  ): void {
    if (!connectionId) return;
    const createdTables = changes.flatMap(({ operations }) => operations.flatMap((operation) => operation.kind === 'createTable'
      ? [{ draftId: operation.draftId, table: operation.table }]
      : []));
    this.workspacePages.completeCreatedTableDrafts(connectionId, createdTables);
  }

  /** Supports newer per-table runbooks and older single-plan records. */
  private tableChangesOf(state: SchemaRunbook): SchemaRunbookTableChange[] {
    return state.tableChanges ?? (state.operations.length
      ? [{ schema: state.schema, table: state.table, baseline: state.baseline, operations: state.operations }]
      : []);
  }

  changesFor(state: SchemaRunbook): SchemaRunbookTableChange[] {
    return this.tableChangesOf(state);
  }

  /** Finds the live session connection matching the runbook's database target. */
  private connectionIdFor(state: SchemaRunbook): string | null {
    return this.connections.connections().find(({ target }) => target.adapter === state.target.adapter
      && target.host === state.target.host && target.port === state.target.port
      && target.database === state.target.database && target.username === state.target.username)?.connectionId ?? null;
  }
}
