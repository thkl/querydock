import '@angular/compiler';
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PostgresConnectRequest } from '@querydock/contracts';
import { ConnectionVaultService } from '../src/app/feature/workspace/connections/connection-vault.service';

const databaseName = 'querydock-connection-vault';
const storeName = 'encrypted-records';
const password = 'correct horse battery staple';

const profileConfiguration: PostgresConnectRequest = {
  adapter: 'postgresql',
  host: 'db.internal',
  port: 5432,
  database: 'querydock',
  username: 'qd_readonly',
  password: 'secret',
  sslMode: 'require',
};

beforeEach(async () => clearVaultRecords());

describe('ConnectionVaultService named profiles', () => {
  it('saves and renames encrypted names, restores them after reload, and reads legacy unnamed profiles', async () => {
    const vault = new ConnectionVaultService();
    await vi.waitFor(() => expect(vault.status()).toBe('unconfigured'));
    await vault.create(password);
    await vault.save(profileConfiguration, 'Production read-only');
    expect(vault.profiles()).toHaveLength(1);
    expect(vault.profiles()[0]?.name).toBe('Production read-only');

    await vault.save(profileConfiguration, 'Production analytics');
    expect(vault.profiles()).toHaveLength(1);
    expect(vault.profiles()[0]?.name).toBe('Production analytics');

    await insertLegacyUnnamedProfile({ ...profileConfiguration, database: 'legacy' }, 'legacy-profile');
    vault.lock();

    const restored = new ConnectionVaultService();
    await vi.waitFor(() => expect(restored.status()).toBe('locked'));
    await restored.unlock(password);

    expect(restored.profiles()).toHaveLength(2);
    expect(restored.profiles().find(({ configuration }) => configuration.database === 'querydock')?.name)
      .toBe('Production analytics');
    expect(restored.profiles().find(({ configuration }) => configuration.database === 'legacy')?.name).toBe('');
  });

  it('enforces password and profile rules, rejects a wrong password, and supports forget, lock, and reset', async () => {
    const vault = new ConnectionVaultService();
    await vi.waitFor(() => expect(vault.status()).toBe('unconfigured'));
    await expect(vault.create('too short')).rejects.toThrow('at least 12 characters');
    await expect(vault.save(profileConfiguration)).rejects.toThrow('Unlock the connection vault first');
    await vault.create(password);
    await expect(vault.save(profileConfiguration, 'x'.repeat(81))).rejects.toThrow('80 characters or fewer');
    await vault.save(profileConfiguration, 'Read only');
    const profileId = vault.profiles()[0]!.id;

    vault.lock();
    expect(vault.status()).toBe('locked');
    expect(vault.profiles()).toEqual([]);
    await expect(vault.unlock('incorrect password')).rejects.toThrow('password is incorrect');
    expect(vault.status()).toBe('locked');
    await vault.unlock(password);
    expect(vault.profiles()).toHaveLength(1);
    await vault.forget(profileId);
    expect(vault.profiles()).toEqual([]);
    await vault.reset();
    expect(vault.status()).toBe('unconfigured');
  });
});

async function insertLegacyUnnamedProfile(configuration: PostgresConnectRequest, profileId: string): Promise<void> {
  const database = await openVaultDatabase();
  const metadata = await readMetadata(database);
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: decodeBase64(metadata.salt),
      iterations: metadata.iterations,
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`profile:${profileId}:v1`) },
    key,
    new TextEncoder().encode(JSON.stringify({ configuration, createdAt: Date.now() })),
  );
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).put({
      id: `profile:${profileId}`,
      iv: encodeBase64(iv),
      ciphertext: encodeBase64(new Uint8Array(ciphertext)),
      updatedAt: Date.now(),
    });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  database.close();
}

function openVaultDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function clearVaultRecords(): Promise<void> {
  const database = await openVaultDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  database.close();
}

function readMetadata(database: IDBDatabase): Promise<{ salt: string; iterations: number }> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readonly');
    const request = transaction.objectStore(storeName).get('vault-metadata');
    request.onsuccess = () => resolve(request.result as { salt: string; iterations: number });
    request.onerror = () => reject(request.error);
  });
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
