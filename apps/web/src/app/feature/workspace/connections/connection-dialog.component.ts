import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import type { PostgresConnectRequest } from '@querydock/contracts';
import { ConnectionApiService } from './connection-api.service';

@Component({
  selector: 'qd-connection-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './connection-dialog.component.html',
  styleUrl: './connection-dialog.component.css',
})
export class ConnectionDialogComponent {
  readonly state = inject(ConnectionApiService);

  async submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    if (!(form instanceof HTMLFormElement)) return;
    const values = new FormData(form);
    const configuration: PostgresConnectRequest = {
      adapter: 'postgresql',
      host: String(values.get('host') ?? '').trim(),
      port: Number(values.get('port')),
      database: String(values.get('database') ?? '').trim(),
      username: String(values.get('username') ?? '').trim(),
      password: String(values.get('password') ?? ''),
      sslMode: String(values.get('sslMode') ?? 'disable') as PostgresConnectRequest['sslMode'],
    };
    const connected = await this.state.connect(configuration);
    if (connected) form.reset();
  }
}
