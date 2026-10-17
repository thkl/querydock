import { ChangeDetectionStrategy, Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import type { DatabaseConnectRequest } from '@querydock/contracts';
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
  readonly saveToVault = signal(false);
  readonly vaultMessage = signal<string | null>(null);
  readonly pendingVaultSave = signal<{ configuration: DatabaseConnectRequest; name: string } | null>(null);
  readonly selectedAdapter = signal<'postgresql' | 'sqlserver'>('postgresql');
  readonly resetVaultArmed = signal(false);
  readonly forgettingProfileId = signal<string | null>(null);
  readonly editingProfileId = signal<string | null>(null);
  readonly editingProfileName = signal('');
  readonly editingConnectionProfile = signal<SavedConnectionProfile | null>(null);
  readonly connectionEditName = signal('');
  readonly pendingBackupFile = signal<File | null>(null);
  readonly backupFileInput = viewChild<ElementRef<HTMLInputElement>>('backupFileInput');
  readonly connectionForm = viewChild<ElementRef<HTMLFormElement>>('connectionForm');

  /** Closes the dialog through the connection service unless a request is active. */
  closeDialog(): void {
    this.saveToVault.set(false);
    this.cancelConnectionEdit();
    this.cancelVaultRestore();
    this.state.closeConnectDialog();
  }

  /** Locks the local connection vault and clears its selection state from the form. */
  lockVault(): void {
    this.vault.lock();
    this.saveToVault.set(false);
    this.vaultMessage.set(null);
  }

  /** Creates the encrypted vault after matching both password fields. */
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

  /** Unlocks the vault from the submitted password and reports a safe failure notice. */
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

  /** Validates form values, connects, and optionally stores the credentials in the vault. */
  async submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    if (!(form instanceof HTMLFormElement)) return;
    const values = new FormData(form);
    const common = {
      host: String(values.get('host') ?? '').trim(),
      port: Number(values.get('port')),
      database: String(values.get('database') ?? '').trim(),
      username: String(values.get('username') ?? '').trim(),
      password: String(values.get('password') ?? ''),
    };
    const configuration: DatabaseConnectRequest = this.selectedAdapter() === 'sqlserver'
      ? {
        adapter: 'sqlserver',
        ...common,
        encrypt: values.get('encrypt') === 'on',
        trustServerCertificate: values.get('trustServerCertificate') === 'on',
      }
      : {
        adapter: 'postgresql',
        ...common,
        sslMode: String(values.get('sslMode') ?? 'require') as 'disable' | 'require' | 'verify-full',
      };
    const saveInVault = values.get('saveInVault') === 'on';
    const profileName = String(values.get('connectionName') ?? '').trim();
    const editingProfile = this.editingConnectionProfile();
    if (editingProfile) {
      try {
        await this.vault.updateProfile(editingProfile.id, configuration, profileName);
        this.vaultMessage.set('Saved connection details updated.');
        this.cancelConnectionEdit();
      } catch (error) {
        this.vaultMessage.set(error instanceof Error ? error.message : 'Could not update this saved connection.');
      }
      return;
    }
    const connected = await this.state.connect(configuration, !saveInVault);
    if (!connected) return;
    if (saveInVault) {
      try {
        await this.vault.save(configuration, profileName);
        this.vaultMessage.set('Connection saved in the encrypted browser vault.');
      } catch (error) {
        this.vaultMessage.set(error instanceof Error ? error.message : 'Could not save this connection.');
        this.pendingVaultSave.set({ configuration, name: profileName });
        return;
      }
      this.state.closeConnectDialog();
    }
    form.reset();
    this.saveToVault.set(false);
  }

  /** Mirrors the save-to-vault checkbox into the form signal. */
  updateSaveToVault(event: Event): void {
    this.saveToVault.set((event.currentTarget as HTMLInputElement).checked);
  }

  /** Selects a database engine for the connection form. */
  updateAdapter(event: Event): void {
    this.selectedAdapter.set((event.currentTarget as HTMLSelectElement).value as 'postgresql' | 'sqlserver');
  }

  /** Retries saving credentials after a successful connection but failed vault write. */
  async retryVaultSave(): Promise<void> {
    const pending = this.pendingVaultSave();
    if (!pending) return;
    try {
      await this.vault.save(pending.configuration, pending.name);
      this.pendingVaultSave.set(null);
      this.saveToVault.set(false);
      this.vaultMessage.set('Connection saved in the encrypted browser vault.');
      this.state.closeConnectDialog();
    } catch (error) {
      this.vaultMessage.set(error instanceof Error ? error.message : 'Could not save this connection.');
    }
  }

  /** Connects with the selected decrypted profile. */
  async connectSaved(profile: SavedConnectionProfile): Promise<void> {
    this.vaultMessage.set(null);
    await this.state.connect(profile.configuration);
  }

  /** Requires a second click before removing a saved profile from browser storage. */
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

  /** Opens the inline name editor for one saved profile. */
  startRenameProfile(profile: SavedConnectionProfile): void {
    this.editingProfileId.set(profile.id);
    this.editingProfileName.set(profile.name);
  }

  /** Persists an edited profile name through the encrypted vault service. */
  async saveProfileName(profile: SavedConnectionProfile): Promise<void> {
    try {
      await this.vault.save(profile.configuration, this.editingProfileName());
      this.editingProfileId.set(null);
      this.vaultMessage.set('Connection name updated.');
    } catch (error) {
      this.vaultMessage.set(error instanceof Error ? error.message : 'Could not update this connection name.');
    }
  }

  /** Loads a saved profile into the connection form for editing without connecting. */
  editConnectionProfile(profile: SavedConnectionProfile): void {
    this.editingConnectionProfile.set(profile);
    this.connectionEditName.set(profile.name);
    this.selectedAdapter.set(profile.configuration.adapter);
    this.saveToVault.set(false);
    this.vaultMessage.set(null);
    queueMicrotask(() => this.connectionForm()?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  /** Leaves profile edit mode and clears its connection secret from the form. */
  cancelConnectionEdit(): void {
    this.editingConnectionProfile.set(null);
    this.connectionEditName.set('');
    this.connectionForm()?.nativeElement.reset();
    this.selectedAdapter.set('postgresql');
  }

  /** Downloads a JSON envelope containing only the vault's encrypted metadata and records. */
  async exportVault(): Promise<void> {
    try {
      const backup = await this.vault.exportBackup();
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `querydock-vault-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.vaultMessage.set('Encrypted vault backup downloaded. Keep the file private and remember its vault password.');
    } catch (error) {
      this.vaultMessage.set(error instanceof Error ? error.message : 'Could not export the encrypted vault.');
    }
  }

  /** Opens the browser file picker for an encrypted vault backup. */
  chooseVaultBackup(): void {
    this.backupFileInput()?.nativeElement.click();
  }

  /** Holds a selected backup until the user confirms restoration with its password. */
  selectVaultBackup(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = '';
    this.pendingBackupFile.set(file);
    this.vaultMessage.set(null);
  }

  /** Verifies a backup password and restores the vault after explicit replacement confirmation. */
  async restoreVault(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const file = this.pendingBackupFile();
    const form = event.currentTarget;
    if (!file || !(form instanceof HTMLFormElement)) return;
    try {
      const password = String(new FormData(form).get('backupPassword') ?? '');
      await this.vault.restoreBackup(await file.text(), password);
      this.pendingBackupFile.set(null);
      this.resetVaultArmed.set(false);
      this.vaultMessage.set('Encrypted vault restored and unlocked.');
      form.reset();
    } catch (error) {
      this.vaultMessage.set(error instanceof Error ? error.message : 'Could not restore this vault backup.');
    }
  }

  /** Cancels a pending backup restore without touching the current vault. */
  cancelVaultRestore(): void {
    this.pendingBackupFile.set(null);
  }

  /** Requires confirmation before deleting all encrypted vault records. */
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

  /** Formats named profiles or falls back to their database target details. */
  profileLabel(profile: SavedConnectionProfile): string {
    if (profile.name.trim()) return profile.name.trim();
    const { configuration } = profile;
    return `${configuration.database} · ${configuration.host}:${configuration.port} · ${configuration.username}`;
  }

  /** Formats adapter-specific transport options for a saved profile. */
  profileDetails(profile: SavedConnectionProfile): string {
    const { configuration } = profile;
    const transport = configuration.adapter === 'postgresql'
      ? configuration.sslMode
      : configuration.encrypt ? 'TLS encrypted' : 'TLS disabled';
    return `${configuration.database} · ${configuration.host}:${configuration.port} · ${configuration.username} · ${transport}`;
  }

  /** Returns the port displayed for a saved profile or the selected engine's usual default. */
  connectionPort(): number {
    const configuration = this.editingConnectionProfile()?.configuration;
    return configuration?.port ?? (this.selectedAdapter() === 'postgresql' ? 5432 : 1433);
  }

  /** Provides the saved password only while that profile is explicitly being edited. */
  connectionPassword(): string {
    return this.editingConnectionProfile()?.configuration.password ?? '';
  }

  /** Returns the TLS encryption setting displayed for a profile being edited. */
  connectionEncrypt(): boolean {
    const configuration = this.editingConnectionProfile()?.configuration;
    return configuration?.adapter === 'sqlserver' ? configuration.encrypt : true;
  }

  /** Returns the certificate trust setting displayed for a profile being edited. */
  connectionTrustServerCertificate(): boolean {
    const configuration = this.editingConnectionProfile()?.configuration;
    return configuration?.adapter === 'sqlserver' && configuration.trustServerCertificate;
  }
}
