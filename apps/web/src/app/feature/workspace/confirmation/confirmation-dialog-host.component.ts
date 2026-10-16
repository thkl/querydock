import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, viewChild } from '@angular/core';
import { ConfirmationDialogService } from './confirmation-dialog.service';

@Component({
  selector: 'qd-confirmation-dialog-host',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './confirmation-dialog-host.component.html',
  styleUrl: './confirmation-dialog-host.component.css',
})
export class ConfirmationDialogHostComponent {
  readonly confirmation = inject(ConfirmationDialogService);
  private readonly cancelButton = viewChild<ElementRef<HTMLButtonElement>>('cancelButton');
  private readonly confirmButton = viewChild<ElementRef<HTMLButtonElement>>('confirmButton');
  private returnFocusTo: HTMLElement | null = null;
  private activeRequest: object | null = null;

  /** Moves focus into each dialog and restores focus after the request resolves. */
  constructor() {
    effect(() => {
      const request = this.confirmation.request();
      if (request && request !== this.activeRequest) {
        if (!this.activeRequest && typeof document !== 'undefined') {
          this.returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }
        queueMicrotask(() => this.cancelButton()?.nativeElement.focus());
      } else if (!request && this.activeRequest) {
        queueMicrotask(() => this.returnFocusTo?.focus());
        this.returnFocusTo = null;
      }
      this.activeRequest = request;
    });
  }

  /** Resolves the current prompt as cancelled. */
  cancel(): void {
    this.confirmation.resolve(false);
  }

  /** Resolves the current prompt as confirmed. */
  confirm(): void {
    this.confirmation.resolve(true);
  }

  /** Handles Escape and traps Tab navigation within the two dialog actions. */
  handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancel();
      return;
    }

    if (event.key !== 'Tab') return;
    const cancelButton = this.cancelButton()?.nativeElement;
    const confirmButton = this.confirmButton()?.nativeElement;
    if (!cancelButton || !confirmButton) return;

    const first = cancelButton;
    const last = confirmButton;
    const activeElement = document.activeElement;
    if (event.shiftKey) {
      if (activeElement === last) return;
      event.preventDefault();
      last.focus();
      return;
    }

    if (activeElement === first) return;
    event.preventDefault();
    first.focus();
  }
}
