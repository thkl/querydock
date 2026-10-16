import { ChangeDetectionStrategy, Component, HostListener, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { WorkspaceHeaderComponent } from '../header/workspace-header.component';
import { WorkspaceSidebarComponent } from '../sidebar/workspace-sidebar.component';
import { WorkspaceTabsComponent } from '../workspace-tabs/workspace-tabs.component';
import { ConnectionDialogComponent } from '../connections/connection-dialog.component';
import { ConfirmationDialogHostComponent } from '../confirmation/confirmation-dialog-host.component';

@Component({
  selector: 'qd-workspace-shell',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, WorkspaceHeaderComponent, WorkspaceSidebarComponent, WorkspaceTabsComponent, ConnectionDialogComponent, ConfirmationDialogHostComponent],
  templateUrl: './workspace-shell.component.html',
  styleUrl: './workspace-shell.component.css',
})
export class WorkspaceShellComponent {
  readonly minSidebarWidth = 180;
  readonly isResizingSidebar = signal(false);
  private readonly sidebarWidthStorageKey = 'querydock.workspace.sidebar-width';
  readonly sidebarWidth = signal(this.readStoredSidebarWidth());

  private dragStartX = 0;
  private dragStartWidth = 242;

  /** Limits the sidebar to a usable width while preserving room for the main workspace. */
  get maxSidebarWidth(): number {
    const viewportWidth = typeof window === 'undefined' ? 1200 : window.innerWidth;
    return Math.max(this.minSidebarWidth, Math.min(480, Math.floor(viewportWidth * 0.4)));
  }

  /** Starts a pointer drag on the vertical workspace splitter. */
  beginSidebarResize(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    this.dragStartX = event.clientX;
    this.dragStartWidth = this.sidebarWidth();
    this.isResizingSidebar.set(true);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  /** Updates the sidebar width during an active pointer drag. */
  resizeSidebar(event: PointerEvent): void {
    if (!this.isResizingSidebar()) return;
    this.updateSidebarWidth(this.dragStartWidth + event.clientX - this.dragStartX);
  }

  /** Ends pointer resizing and saves the chosen width locally. */
  endSidebarResize(event: PointerEvent): void {
    if (!this.isResizingSidebar()) return;
    this.isResizingSidebar.set(false);
    const splitter = event.currentTarget as HTMLElement;
    if (splitter.hasPointerCapture(event.pointerId)) splitter.releasePointerCapture(event.pointerId);
    this.persistSidebarWidth();
  }

  /** Supports keyboard resizing and persists the resulting sidebar width. */
  resizeSidebarByKeyboard(event: KeyboardEvent): void {
    const step = event.shiftKey ? 32 : 16;
    let nextWidth: number;
    switch (event.key) {
      case 'ArrowLeft': nextWidth = this.sidebarWidth() - step; break;
      case 'ArrowRight': nextWidth = this.sidebarWidth() + step; break;
      case 'Home': nextWidth = this.minSidebarWidth; break;
      case 'End': nextWidth = this.maxSidebarWidth; break;
      default: return;
    }
    event.preventDefault();
    this.updateSidebarWidth(nextWidth, true);
  }

  /** Clamps the saved width after the browser viewport changes. */
  @HostListener('window:resize')
  keepSidebarWithinViewport(): void {
    const width = this.clampSidebarWidth(this.sidebarWidth());
    if (width !== this.sidebarWidth()) this.updateSidebarWidth(width, true);
  }

  /** Keeps the sidebar between its minimum and responsive maximum widths. */
  private clampSidebarWidth(width: number): number {
    return Math.max(this.minSidebarWidth, Math.min(this.maxSidebarWidth, width));
  }

  /** Updates sidebar state and optionally commits it to local storage. */
  private updateSidebarWidth(width: number, persist = false): void {
    this.sidebarWidth.set(this.clampSidebarWidth(width));
    if (persist) this.persistSidebarWidth();
  }

  /** Restores a valid width while falling back when browser storage is unavailable. */
  private readStoredSidebarWidth(): number {
    try {
      const savedWidth = Number(localStorage.getItem(this.sidebarWidthStorageKey));
      return Number.isFinite(savedWidth) && savedWidth > 0 ? this.clampSidebarWidth(savedWidth) : 242;
    } catch {
      return 242;
    }
  }

  /** Saves the current sidebar width without interrupting the active session on failure. */
  private persistSidebarWidth(): void {
    try {
      localStorage.setItem(this.sidebarWidthStorageKey, String(this.sidebarWidth()));
    } catch {
      // Keep the current width for this session if storage is unavailable.
    }
  }
}
