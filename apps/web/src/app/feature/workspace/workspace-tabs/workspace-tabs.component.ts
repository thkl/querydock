import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, viewChildren } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { RunbookService } from '../runbook/runbook.service';
import { WorkspacePagesService, type TableSchemaPage } from '../workspace-pages.service';

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
  private readonly pageTabElements = viewChildren<ElementRef<HTMLElement>>('pageTab');

  constructor() {
    effect(() => {
      const activeId = this.pages.activePage()?.id;
      const activeTab = this.pageTabElements().find((tab) => tab.nativeElement.dataset['pageId'] === activeId);
      if (activeTab) requestAnimationFrame(() => activeTab.nativeElement.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    });
  }

  closePage(event: MouseEvent, page: TableSchemaPage): void {
    event.preventDefault();
    event.stopPropagation();
    this.pages.closePage(page);
  }
}
