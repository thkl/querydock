import { expect, test } from '@playwright/test';
import { connectFromHome, installMockApi, openTableSchema, openTreeMenu } from './support/mock-api';

test('creates a table with adapter options, stages SQL, and records a confirmed apply', async ({ page }) => {
  const calls = await installMockApi(page);
  await connectFromHome(page);
  await openTreeMenu(page, 'public');
  await page.getByRole('menuitem', { name: 'Create table' }).click();

  await page.getByLabel('Table name').fill('e2e_new_table');
  await page.getByLabel('Name', { exact: true }).first().fill('id');
  const fieldRow = page.locator('.field-row').first();
  await fieldRow.getByLabel('Type').selectOption('integer');
  await fieldRow.getByLabel('Identity').selectOption('byDefault');
  await page.getByLabel('Create if not exists').check();
  await page.getByRole('button', { name: 'Review in runbook' }).click();

  await expect(page).toHaveURL(/\/runbook$/);
  await expect(page.getByRole('heading', { name: 'Review SQL changes' })).toBeVisible();
  await expect(page.locator('qd-sql-editor')).toContainText('CREATE TABLE IF NOT EXISTS');
  const previewCall = calls.find(({ method, path }) => method === 'POST' && path.endsWith('/migrations/preview'));
  expect(previewCall?.body?.operations).toMatchObject([
    { kind: 'createTable', table: 'e2e_new_table', ifNotExists: true, fields: [{ name: 'id', type: 'integer', identityGeneration: 'byDefault' }] },
  ]);

  await page.getByRole('button', { name: 'Apply to development' }).click();
  await expect(page.getByRole('heading', { name: 'Applied SQL' })).toBeVisible();
  await expect(page.locator('qd-sql-editor')).toContainText('No pending SQL');
  await expect(page.locator('.applied-card pre')).toContainText('CREATE TABLE IF NOT EXISTS');
});

test('stages a nullable field from the schema grid and keeps failed Apply work pending', async ({ page }) => {
  const calls = await installMockApi(page, { applyStatus: 400 });
  await connectFromHome(page);
  await openTableSchema(page);
  await expect(page.getByRole('heading', { name: 'customers', level: 1 })).toBeVisible();

  const fieldGrid = page.locator('.schema-grid--fields');
  await fieldGrid.getByText('Add row', { exact: false }).click();
  const draftRow = fieldGrid.getByRole('row').nth(2);
  await draftRow.getByRole('gridcell').nth(0).dblclick();
  const nameEditor = page.getByRole('textbox').last();
  await nameEditor.fill('rollback_probe');
  await nameEditor.press('Tab');
  await draftRow.getByRole('gridcell').nth(1).dblclick();
  const typeEditor = page.getByRole('combobox').last();
  await typeEditor.selectOption('text');
  await typeEditor.press('Tab');

  await expect.poll(() => calls.some(({ method, path }) => method === 'POST' && path.endsWith('/migrations/field-draft'))).toBe(true);
  await page.getByRole('link', { name: /Runbook/ }).first().click();
  await expect(page).toHaveURL(/\/runbook$/);
  await expect(page.locator('qd-sql-editor')).toContainText('rollback_probe');
  await page.getByRole('button', { name: 'Apply to development' }).click();
  await expect(page.getByRole('alert')).toContainText('The migration was rejected by the database');
  await expect(page.locator('qd-sql-editor')).toContainText('rollback_probe');
});

test('a destructive table change requires the custom warning confirmation and sends acknowledgement', async ({ page }) => {
  const warning = 'Dropping this table permanently removes its data.';
  const calls = await installMockApi(page, { warnings: [warning] });
  await connectFromHome(page);
  await openTableSchema(page);
  await page.getByRole('button', { name: 'Stage table drop' }).click();
  await page.getByRole('link', { name: /Runbook/ }).first().click();
  await expect(page.locator('qd-sql-editor')).toContainText('DROP TABLE');

  await page.getByRole('button', { name: 'Apply to development' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Review migration warnings' });
  await expect(confirm).toContainText(warning);
  const applyResponse = page.waitForResponse((response) =>
    response.url().endsWith('/migrations/apply') && response.request().method() === 'POST');
  await confirm.getByRole('button', { name: 'Acknowledge and apply' }).click();
  await applyResponse;

  const applyCall = calls.find(({ method, path }) => method === 'POST' && path.endsWith('/migrations/apply'));
  expect(applyCall?.body?.acknowledgedWarnings).toEqual([warning]);
  await expect(page.getByText(/Table drop confirmed/)).toBeVisible();
});

test('stages a primary-key constraint from the constraint grid for server preview', async ({ page }) => {
  const calls = await installMockApi(page);
  await connectFromHome(page);
  await openTableSchema(page);

  const constraintGrid = page.locator('.schema-grid--constraints');
  await constraintGrid.getByText('Add row', { exact: false }).click();
  const draftRow = constraintGrid.getByRole('row').nth(1);
  await draftRow.getByRole('gridcell').nth(1).dblclick();
  const nameEditor = page.getByRole('textbox').last();
  await nameEditor.fill('pk_customers_name');
  await nameEditor.press('Tab');
  await draftRow.getByRole('gridcell').nth(2).dblclick();
  const fieldEditor = page.getByRole('textbox').last();
  await fieldEditor.fill('name');
  await fieldEditor.press('Tab');

  await expect.poll(() => calls.some(({ method, path, body }) =>
    method === 'POST' && path.endsWith('/migrations/preview')
      && JSON.stringify(body?.operations).includes('pk_customers_name'))).toBe(true);
  const preview = calls.find(({ method, path, body }) =>
    method === 'POST' && path.endsWith('/migrations/preview')
      && JSON.stringify(body?.operations).includes('pk_customers_name'));
  expect(preview?.body?.operations).toMatchObject([
    { kind: 'addConstraint', constraintKind: 'primaryKey', name: 'pk_customers_name', fieldNames: ['name'] },
  ]);
  await page.getByRole('link', { name: /Runbook/ }).first().click();
  await expect(page.locator('qd-sql-editor')).toContainText('pk_customers_name');
});

test('renames a table through the runbook and follows the renamed workspace tab after Apply', async ({ page }) => {
  const calls = await installMockApi(page);
  await connectFromHome(page);
  await openTableSchema(page);
  await page.getByRole('button', { name: 'Rename table' }).click();
  await page.getByRole('textbox', { name: 'Table name' }).fill('customers_renamed');
  await page.getByRole('button', { name: 'Save table rename to Runbook' }).click();

  await page.getByRole('link', { name: /Runbook/ }).first().click();
  await expect(page.locator('qd-sql-editor')).toContainText('RENAME TO');
  await page.getByRole('button', { name: 'Apply to development' }).click();
  await expect(page).toHaveURL(/\/tables\/customers_renamed\/schema\?schema=public$/);
  await expect(page.getByRole('heading', { name: 'customers_renamed', level: 1 })).toBeVisible();

  const preview = calls.find(({ method, path }) => method === 'POST' && path.endsWith('/migrations/preview'));
  expect(preview?.body?.operations).toEqual([{ kind: 'renameTable', newName: 'customers_renamed' }]);
});

test('a new table draft stays available in the runbook after leaving and returning to its workspace page', async ({ page }) => {
  await installMockApi(page);
  await connectFromHome(page);
  await openTreeMenu(page, 'public');
  await page.getByRole('menuitem', { name: 'Create table' }).click();
  await page.getByLabel('Table name').fill('draft_to_keep');
  await page.getByLabel('Name', { exact: true }).first().fill('id');
  await page.getByRole('button', { name: 'Review in runbook' }).click();
  await expect(page.getByRole('heading', { name: 'Review SQL changes' })).toBeVisible();

  await page.getByRole('link', { name: /New table \(draft_to_keep\)/ }).click();
  await expect(page.getByLabel('Table name')).toHaveValue('draft_to_keep');
  await page.getByRole('link', { name: /Runbook/ }).first().click();
  await expect(page.locator('qd-sql-editor')).toContainText('draft_to_keep');
});
