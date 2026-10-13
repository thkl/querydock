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

  confirm(options: ConfirmationOptions): Promise<boolean> {
    this.resolve(false);

    return new Promise<boolean>((resolve) => {
      this.settle = resolve;
      this.request.set(options);
    });
  }

  resolve(confirmed: boolean): void {
    const settle = this.settle;
    this.settle = null;
    this.request.set(null);
    settle?.(confirmed);
  }
}
