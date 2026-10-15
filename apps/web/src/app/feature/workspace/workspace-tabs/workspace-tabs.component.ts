import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, signal, viewChildren } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { RunbookService } from '../runbook/runbook.service';
import { ConfirmationDialogService } from '../confirmation/confirmation-dialog.service';
import { WorkspacePagesService, type CreateTablePage, type RelationshipDiagramPage, type TableDataPage, type TableSchemaPage } from '../workspace-pages.service';

@Component({
  selector: 'qd-workspace-tabs',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive],
  templateUrl: './workspace-tabs.component.html',
  styleUrl: './workspace-tabs.component.css',
})
export class WorkspaceTabsComponent {
  readonly runbook = inject(RunbookService);
  readonly pages = inject(WorkspacePagesService);
  private readonly confirmation = inject(ConfirmationDialogService);
  readonly closeError = signal<string | null>(null);
  private readonly pageTabElements = viewChildren<ElementRef<HTMLElement>>('pageTab');

  constructor() {
    effect(() => {
      const activeId = this.pages.activePage()?.id ?? this.pages.activeCreateTablePage()?.id
        ?? this.pages.activeDataPage()?.id ?? this.pages.activeRelationshipPage()?.id;
      const activeTab = this.pageTabElements().find((tab) => tab.nativeElement.dataset['pageId'] === activeId);
      if (activeTab) requestAnimationFrame(() => activeTab.nativeElement.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    });
  }

  closePage(event: MouseEvent, page: TableSchemaPage): void {
    event.preventDefault();
    event.stopPropagation();
    this.pages.closePage(page);
  }

  closeDataPage(event: MouseEvent, page: TableDataPage): void {
    event.preventDefault();
    event.stopPropagation();
    this.pages.closeDataPage(page);
  }

  closeRelationshipPage(event: MouseEvent, page: RelationshipDiagramPage): void {
    event.preventDefault();
    event.stopPropagation();
    this.pages.closeRelationshipPage(page);
  }

  async closeCreatePage(event: MouseEvent, page: CreateTablePage): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    this.closeError.set(null);
    const draft = this.pages.createTableDraft(page.id);
    const tableName = draft?.tableName.trim() ?? '';
    const confirmed = await this.confirmation.confirm({
      title: 'Close this table draft?',
      message: `Closing removes the draft${tableName ? ` for "${tableName}"` : ''}. Any staged CREATE TABLE SQL for this draft will also be removed from the runbook.`,
      confirmLabel: 'Close and discard draft',
      intent: 'warning',
    });
    if (!confirmed) return;
    try {
      await this.runbook.discardCreateTableDraft(page.id, tableName);
      this.pages.closeCreateTablePage(page);
    } catch (error) {
      this.closeError.set(error instanceof Error ? error.message : 'Unable to remove this table draft from the runbook.');
    }
  }
}
