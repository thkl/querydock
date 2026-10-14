import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SqlEditorComponent } from '../sql-editor/sql-editor.component';
import { RunbookService } from './runbook.service';
import { ConfirmationDialogService } from '../confirmation/confirmation-dialog.service';

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
    void this.runbook.applyPending(acknowledgedWarnings).catch(() => undefined);
  }

  discard(): void {
    void this.runbook.discardPending();
  }

  export(): void {
    void this.runbook.exportAppliedSql();
  }

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
    void this.runbook.resolveUnknownApply(outcome).catch((error: unknown) => this.runbook.reportError(error));
  }

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
}
