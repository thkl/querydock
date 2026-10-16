import { Injectable, signal } from '@angular/core';

export type ConfirmationIntent = 'default' | 'warning' | 'danger';

export interface ConfirmationOptions {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  intent?: ConfirmationIntent;
}

@Injectable({ providedIn: 'root' })
export class ConfirmationDialogService {
  readonly request = signal<ConfirmationOptions | null>(null);

  private settle: ((confirmed: boolean) => void) | null = null;

  /** Opens a confirmation request and resolves any previous request as cancelled. */
  confirm(options: ConfirmationOptions): Promise<boolean> {
    this.resolve(false);

    return new Promise<boolean>((resolve) => {
      this.settle = resolve;
      this.request.set(options);
    });
  }

  /** Closes the active prompt and resolves its waiting caller exactly once. */
  resolve(confirmed: boolean): void {
    const settle = this.settle;
    this.settle = null;
    this.request.set(null);
    settle?.(confirmed);
  }
}
