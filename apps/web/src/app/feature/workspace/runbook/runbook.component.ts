import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SqlEditorComponent } from '../sql-editor/sql-editor.component';
import { RunbookService, type SchemaRunbook } from './runbook.service';
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
    const tableOperation = state?.operations[0];
    try {
      await this.runbook.applyPending(acknowledgedWarnings);
      if (!state) return;
      const connectionId = this.connectionIdFor(state);
      this.removeAppliedCreateDraftTabs(state, connectionId);
      if (tableOperation?.kind === 'renameTable') {
        const page = connectionId
          ? this.workspacePages.renameTablePage(connectionId, state.schema, state.table, tableOperation.newName)
          : null;
        if (page) this.workspacePages.selectPage(page);
      } else if (tableOperation?.kind === 'dropTable' && connectionId) {
        this.workspacePages.closeTablePage(connectionId, state.schema, state.table);
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
    const tableOperation = state?.operations[0];
    try {
      await this.runbook.resolveUnknownApply(outcome);
      if (outcome !== 'applied' || !state) return;
      const connectionId = this.connectionIdFor(state);
      this.removeAppliedCreateDraftTabs(state, connectionId);
      if (tableOperation?.kind === 'renameTable' && connectionId) {
        const page = this.workspacePages.renameTablePage(connectionId, state.schema, state.table, tableOperation.newName);
        if (page) this.workspacePages.selectPage(page);
      } else if (tableOperation?.kind === 'dropTable' && connectionId) {
        this.workspacePages.closeTablePage(connectionId, state.schema, state.table);
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
  private removeAppliedCreateDraftTabs(state: SchemaRunbook, connectionId: string | null): void {
    if (!connectionId) return;
    const createdTables = state.operations.flatMap((operation) => operation.kind === 'createTable'
      ? [{ draftId: operation.draftId, table: operation.table }]
      : []);
    this.workspacePages.completeCreatedTableDrafts(connectionId, createdTables);
  }

  /** Finds the live session connection matching the runbook's database target. */
  private connectionIdFor(state: SchemaRunbook): string | null {
    return this.connections.connections().find(({ target }) => target.adapter === state.target.adapter
      && target.host === state.target.host && target.port === state.target.port
      && target.database === state.target.database && target.username === state.target.username)?.connectionId ?? null;
  }
}
