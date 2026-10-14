import { Injectable, signal } from '@angular/core';
import type { PostgresConnectRequest } from '@querydock/contracts';
import { postgresConnectRequestSchema } from '@querydock/contracts';

const DATABASE_NAME = 'querydock-connection-vault';
const STORE_NAME = 'encrypted-records';
const DATABASE_VERSION = 1;
const VAULT_ID = 'vault-metadata';
const KEY_DERIVATION_ITERATIONS = 600_000;
const VERIFICATION_TEXT = 'querydock-connection-vault:v1';
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

type VaultStatus = 'loading' | 'unconfigured' | 'locked' | 'unlocked' | 'unavailable';

interface VaultMetadata {
  id: typeof VAULT_ID;
  version: 1;
  salt: string;
  checkIv: string;
  checkCiphertext: string;
  iterations: number;
}

interface EncryptedProfileRecord {
  id: string;
  iv: string;
  ciphertext: string;
  updatedAt: number;
}

interface ProfilePayload {
  configuration: PostgresConnectRequest;
  createdAt: number;
}

export interface SavedConnectionProfile {
  id: string;
  configuration: PostgresConnectRequest;
  createdAt: number;
  updatedAt: number;
}

@Injectable({ providedIn: 'root' })
export class ConnectionVaultService {
  readonly status = signal<VaultStatus>('loading');
  readonly profiles = signal<SavedConnectionProfile[]>([]);
  readonly error = signal<string | null>(null);

  private databasePromise?: Promise<IDBDatabase>;
  private metadata: VaultMetadata | null = null;
  private key: CryptoKey | null = null;
  private readonly initialized = this.initialize();

  async create(password: string): Promise<void> {
    await this.initialized;
    if (this.status() !== 'unconfigured') throw new Error('A connection vault already exists in this browser.');
    this.requirePasswordLength(password);
    this.error.set(null);

    const salt = randomBytes(16);
    const key = await this.deriveKey(password, salt, KEY_DERIVATION_ITERATIONS);
    const check = await this.encrypt(VERIFICATION_TEXT, key, 'vault-check:v1');
    const metadata: VaultMetadata = {
      id: VAULT_ID,
      version: 1,
      salt: encodeBase64(salt),
      checkIv: encodeBase64(check.iv),
      checkCiphertext: encodeBase64(check.ciphertext),
      iterations: KEY_DERIVATION_ITERATIONS,
    };

    await this.putRecord(metadata);
    this.metadata = metadata;
    this.key = key;
    this.status.set('unlocked');
    this.profiles.set([]);
  }

  async unlock(password: string): Promise<void> {
    await this.initialized;
    if (!this.metadata) throw new Error('Set up a connection vault before unlocking it.');
    this.error.set(null);

    const key = await this.deriveKey(password, decodeBase64(this.metadata.salt), this.metadata.iterations);
    try {
      const check = await this.decrypt(
        decodeBase64(this.metadata.checkIv),
        decodeBase64(this.metadata.checkCiphertext),
        key,
        'vault-check:v1',
      );
      if (check !== VERIFICATION_TEXT) throw new Error('Vault verification failed.');
      const profiles = await this.readProfiles(key);
      this.key = key;
      this.profiles.set(profiles);
      this.status.set('unlocked');
    } catch {
      this.key = null;
      this.profiles.set([]);
      this.status.set('locked');
      throw new Error('The vault password is incorrect, or the encrypted vault data is damaged.');
    }
  }

  async save(configuration: PostgresConnectRequest): Promise<void> {
    const key = this.requireUnlockedKey();
    const existing = this.profiles().find(({ configuration: saved }) => sameTarget(saved, configuration));
    const id = existing?.id ?? crypto.randomUUID();
    const createdAt = existing?.createdAt ?? Date.now();
    const updatedAt = Date.now();
    const payload: ProfilePayload = { configuration, createdAt };
    const encrypted = await this.encrypt(JSON.stringify(payload), key, `profile:${id}:v1`);
    const record: EncryptedProfileRecord = {
      id: `profile:${id}`,
      iv: encodeBase64(encrypted.iv),
      ciphertext: encodeBase64(encrypted.ciphertext),
      updatedAt,
    };
    await this.putRecord(record);
    const profile = { id, configuration, createdAt, updatedAt };
    this.profiles.update((current) => [
      ...current.filter((candidate) => candidate.id !== id),
      profile,
    ].sort((left, right) => right.updatedAt - left.updatedAt));
  }

  async forget(profileId: string): Promise<void> {
    this.requireUnlockedKey();
    await this.deleteRecord(`profile:${profileId}`);
    this.profiles.update((current) => current.filter(({ id }) => id !== profileId));
  }

  lock(): void {
    this.key = null;
    this.profiles.set([]);
    this.error.set(null);
    this.status.set(this.metadata ? 'locked' : 'unconfigured');
  }

  async reset(): Promise<void> {
    await this.initialized;
    await this.clearRecords();
    this.key = null;
    this.metadata = null;
    this.profiles.set([]);
    this.error.set(null);
    this.status.set('unconfigured');
  }

  private async initialize(): Promise<void> {
    try {
      if (!globalThis.crypto?.subtle || !globalThis.indexedDB) {
        throw new Error('This browser does not provide the secure storage features required by the connection vault.');
      }
      const storedMetadata = await this.getRecord<unknown>(VAULT_ID);
      if (storedMetadata !== null && !isVaultMetadata(storedMetadata)) {
        throw new Error('The saved connection vault metadata is invalid. Reset the vault to use browser storage again.');
      }
      this.metadata = storedMetadata;
      this.status.set(this.metadata ? 'locked' : 'unconfigured');
    } catch (error) {
      this.status.set('unavailable');
      this.error.set(error instanceof Error ? error.message : 'The browser connection vault is unavailable.');
    }
  }

  private async readProfiles(key: CryptoKey): Promise<SavedConnectionProfile[]> {
    const records = await this.getAllRecords<unknown>();
    const profiles: SavedConnectionProfile[] = [];
    const candidates = records.filter(hasProfileId);
    if (candidates.some((record) => !isEncryptedProfileRecord(record))) {
      throw new Error('A saved connection record is damaged.');
    }
    for (const record of candidates as EncryptedProfileRecord[]) {
      const id = record.id.slice('profile:'.length);
      const plaintext = await this.decrypt(
        decodeBase64(record.iv),
        decodeBase64(record.ciphertext),
        key,
        `profile:${id}:v1`,
      );
      const payload = JSON.parse(plaintext) as ProfilePayload;
      const parsed = postgresConnectRequestSchema.safeParse(payload.configuration);
      if (!parsed.success || !Number.isFinite(payload.createdAt)) throw new Error('A saved connection profile is invalid.');
      profiles.push({
        id,
        configuration: parsed.data,
        createdAt: payload.createdAt,
        updatedAt: record.updatedAt,
      });
    }
    return profiles.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  private async deriveKey(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
    const material = await crypto.subtle.importKey(
      'raw', textEncoder.encode(password), 'PBKDF2', false, ['deriveKey'],
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  private async encrypt(
    value: string,
    key: CryptoKey,
    associatedData: string,
  ): Promise<{ iv: Uint8Array<ArrayBuffer>; ciphertext: Uint8Array<ArrayBuffer> }> {
    const iv = randomBytes(12);
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: textEncoder.encode(associatedData) },
      key,
      textEncoder.encode(value),
    );
    return { iv, ciphertext: new Uint8Array(ciphertext) };
  }

  private async decrypt(
    iv: Uint8Array<ArrayBuffer>,
    ciphertext: Uint8Array<ArrayBuffer>,
    key: CryptoKey,
    associatedData: string,
  ): Promise<string> {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: textEncoder.encode(associatedData) },
      key,
      ciphertext,
    );
    return textDecoder.decode(plaintext);
  }

  private requireUnlockedKey(): CryptoKey {
    if (this.status() !== 'unlocked' || !this.key) throw new Error('Unlock the connection vault first.');
    return this.key;
  }

  private requirePasswordLength(password: string): void {
    if (password.length < 12) throw new Error('Choose a vault password with at least 12 characters.');
  }

  private async getDatabase(): Promise<IDBDatabase> {
    this.databasePromise ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Could not open the browser connection vault.'));
      request.onblocked = () => reject(new Error('The browser connection vault is blocked by another tab.'));
    });
    return this.databasePromise;
  }

  private async getRecord<T>(id: string): Promise<T | null> {
    const database = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).get(id);
      request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new Error('Could not read the browser connection vault.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Could not read the browser connection vault.'));
    });
  }

  private async getAllRecords<T>(): Promise<T[]> {
    const database = await this.getDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result as T[]);
      request.onerror = () => reject(request.error ?? new Error('Could not read saved connections.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Could not read saved connections.'));
    });
  }

  private async putRecord<T extends { id: string }>(record: T): Promise<void> {
    const database = await this.getDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(record);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not save the encrypted connection.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Could not save the encrypted connection.'));
    });
  }

  private async deleteRecord(id: string): Promise<void> {
    const database = await this.getDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not remove the saved connection.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Could not remove the saved connection.'));
    });
  }

  private async clearRecords(): Promise<void> {
    const database = await this.getDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not reset the connection vault.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Could not reset the connection vault.'));
    });
  }
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(length));
  return crypto.getRandomValues(bytes);
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function sameTarget(left: PostgresConnectRequest, right: PostgresConnectRequest): boolean {
  return left.adapter === right.adapter && left.host === right.host && left.port === right.port
    && left.database === right.database && left.username === right.username && left.sslMode === right.sslMode;
}

function isVaultMetadata(value: unknown): value is VaultMetadata {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<VaultMetadata>;
  if (record.id !== VAULT_ID || record.version !== 1 || record.iterations !== KEY_DERIVATION_ITERATIONS
    || typeof record.salt !== 'string' || typeof record.checkIv !== 'string'
    || typeof record.checkCiphertext !== 'string') return false;
  try {
    return decodeBase64(record.salt).byteLength === 16
      && decodeBase64(record.checkIv).byteLength === 12
      && decodeBase64(record.checkCiphertext).byteLength >= 16;
  } catch {
    return false;
  }
}

function isEncryptedProfileRecord(value: unknown): value is EncryptedProfileRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<EncryptedProfileRecord>;
  if (typeof record.id !== 'string' || !record.id.startsWith('profile:')
    || typeof record.iv !== 'string' || typeof record.ciphertext !== 'string'
    || typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt)) return false;
  try {
    return decodeBase64(record.iv).byteLength === 12 && decodeBase64(record.ciphertext).byteLength >= 16;
  } catch {
    return false;
  }
}

function hasProfileId(value: unknown): value is { id: string } {
  return typeof value === 'object' && value !== null
    && 'id' in value && typeof value.id === 'string' && value.id.startsWith('profile:');
}
