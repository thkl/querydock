import { expect, test } from '@playwright/test';
import { connectFromHome, installMockApi } from './support/mock-api';

test('connects, discovers resources, and opens the table schema', async ({ page }) => {
  const calls = await installMockApi(page);
  await connectFromHome(page);

  await expect(page.getByRole('button', { name: 'Open table structure' })).toBeVisible();
  await page.locator('.table-row-grid').hover();
  await page.getByRole('button', { name: 'Open table structure' }).click();
  await expect(page).toHaveURL(/\/tables\/customers\/schema\?schema=public$/);
  await expect(page.getByRole('heading', { name: 'customers', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Fields', level: 2 })).toBeVisible();
  expect(calls.some(({ method, path }) => method === 'GET' && path.endsWith('/resources'))).toBe(true);
  expect(calls.some(({ method, path }) => method === 'GET' && path.endsWith('/tables'))).toBe(true);
});

test('keeps two database sessions separate and disconnects only the selected session', async ({ page }) => {
  await installMockApi(page);
  await connectFromHome(page, 'querydock_e2e', 'writer');
  await expect(page.locator('.connection-item').filter({ hasText: 'writer' })).toBeVisible();

  await page.getByRole('button', { name: 'Add connection' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect to PostgreSQL' });
  await dialog.getByLabel('Database').fill('querydock_e2e');
  await dialog.getByLabel('Username').fill('reader');
  await dialog.getByLabel('Password').fill('read-only-password');
  await dialog.getByLabel('Password').press('Enter');
  await expect(page.locator('.connection-item').filter({ hasText: 'reader' })).toBeVisible();

  await page.locator('.connection-item').filter({ hasText: 'writer' }).click();
  const disconnectGroup = page.getByRole('button', { name: 'Disconnect querydock_e2e · localhost:5432 · writer' });
  await disconnectGroup.click();
  const confirmation = page.getByRole('group', { name: /Confirm disconnect.*writer/ });
  await expect(confirmation).toContainText('Unsubmitted table drafts will be discarded');
  await confirmation.getByRole('button', { name: 'Disconnect', exact: true }).click();

  await expect(page.locator('.connection-item').filter({ hasText: 'writer' })).toHaveCount(0);
  await expect(page.locator('.connection-item').filter({ hasText: 'reader' })).toBeVisible();
});

test('shows sanitized connection failures in the connection dialog', async ({ page }) => {
  await installMockApi(page, { connectStatus: 502 });
  await connectFromHome(page, 'querydock_e2e', 'e2e_user', false);
  const dialog = page.getByRole('dialog', { name: 'Connect to PostgreSQL' });
  await expect(dialog.getByRole('alert')).toContainText(
    'PostgreSQL authentication failed. Check the username and password.',
  );
  await expect(dialog).toBeVisible();
});

test('a read-only connection can inspect a table but exposes no schema mutation actions', async ({ page }) => {
  await installMockApi(page, { readOnly: true });
  await connectFromHome(page, 'querydock_e2e', 'reader');
  await page.locator('.table-row-grid').hover();
  await page.getByRole('button', { name: 'Open table structure' }).click();

  await expect(page.getByRole('heading', { name: 'customers', level: 1 })).toBeVisible();
  await expect(page.locator('.readonly-badge')).toContainText('READ ONLY');
  await expect(page.getByRole('button', { name: 'Rename table' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stage table drop' })).toHaveCount(0);
});
