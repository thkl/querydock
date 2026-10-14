import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import type { PostgresConnectRequest } from '@querydock/contracts';
import { ConnectionApiService } from './connection-api.service';
import { ConnectionVaultService, type SavedConnectionProfile } from './connection-vault.service';

@Component({
  selector: 'qd-connection-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './connection-dialog.component.html',
  styleUrl: './connection-dialog.component.css',
})
export class ConnectionDialogComponent {
  readonly state = inject(ConnectionApiService);
  readonly vault = inject(ConnectionVaultService);
  readonly vaultSetupOpen = signal(false);
  readonly vaultMessage = signal<string | null>(null);
  readonly pendingVaultSave = signal<PostgresConnectRequest | null>(null);
  readonly resetVaultArmed = signal(false);
  readonly forgettingProfileId = signal<string | null>(null);

  async createVault(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    if (!(form instanceof HTMLFormElement)) return;
    const values = new FormData(form);
    const password = String(values.get('vaultPassword') ?? '');
    const confirmation = String(values.get('confirmVaultPassword') ?? '');
    if (password !== confirmation) {
      this.vaultMessage.set('The vault passwords do not match.');
      return;
    }
    try {
      await this.vault.create(password);
      this.vaultMessage.set(null);
      this.vaultSetupOpen.set(false);
      form.reset();
    } catch (error) {
      this.vaultMessage.set(error instanceof Error ? error.message : 'Could not create the connection vault.');
    }
  }

  async unlockVault(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    if (!(form instanceof HTMLFormElement)) return;
    const password = String(new FormData(form).get('vaultPassword') ?? '');
    try {
      await this.vault.unlock(password);
      this.vaultMessage.set(null);
      form.reset();
    } catch (error) {
      this.vaultMessage.set(error instanceof Error ? error.message : 'Could not unlock the connection vault.');
      form.reset();
    }
  }

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
    const saveInVault = values.get('saveInVault') === 'on';
    const connected = await this.state.connect(configuration, !saveInVault);
    if (!connected) return;
    if (saveInVault) {
      try {
        await this.vault.save(configuration);
        this.vaultMessage.set('Connection saved in the encrypted browser vault.');
      } catch (error) {
        this.vaultMessage.set(error instanceof Error ? error.message : 'Could not save this connection.');
        this.pendingVaultSave.set(configuration);
        return;
      }
      this.state.closeConnectDialog();
    }
    form.reset();
  }

  async retryVaultSave(): Promise<void> {
    const configuration = this.pendingVaultSave();
    if (!configuration) return;
    try {
      await this.vault.save(configuration);
      this.pendingVaultSave.set(null);
      this.vaultMessage.set('Connection saved in the encrypted browser vault.');
      this.state.closeConnectDialog();
    } catch (error) {
      this.vaultMessage.set(error instanceof Error ? error.message : 'Could not save this connection.');
    }
  }

  async connectSaved(profile: SavedConnectionProfile): Promise<void> {
    this.vaultMessage.set(null);
    await this.state.connect(profile.configuration);
  }

  async forgetProfile(profile: SavedConnectionProfile): Promise<void> {
    if (this.forgettingProfileId() !== profile.id) {
      this.forgettingProfileId.set(profile.id);
      return;
    }
    try {
      await this.vault.forget(profile.id);
      this.forgettingProfileId.set(null);
      this.vaultMessage.set('Saved connection removed.');
    } catch (error) {
      this.vaultMessage.set(error instanceof Error ? error.message : 'Could not remove this connection.');
    }
  }

  async resetVault(): Promise<void> {
    if (!this.resetVaultArmed()) {
      this.resetVaultArmed.set(true);
      return;
    }
    try {
      await this.vault.reset();
      this.resetVaultArmed.set(false);
      this.vaultSetupOpen.set(false);
      this.vaultMessage.set('Encrypted connection vault deleted.');
    } catch (error) {
      this.vaultMessage.set(error instanceof Error ? error.message : 'Could not delete the connection vault.');
    }
  }

  profileLabel(profile: SavedConnectionProfile): string {
    const { configuration } = profile;
    return `${configuration.database} · ${configuration.host}:${configuration.port}`;
  }
}
