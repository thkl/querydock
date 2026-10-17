import { describe, expect, it } from 'vitest';
import type { TableSnapshot } from '@querydock/contracts';
import { databaseConnectRequestSchema } from '@querydock/contracts';
import { sqlServerInternals } from '../src/feature/sqlserver/sqlserver.adapter.ts';

const snapshot: TableSnapshot = {
  schema: 'sales data',
  name: 'order]items',
  kind: 'table',
  canAlter: false,
  fingerprint: 'a'.repeat(64),
  editableFieldTypes: [],
  editableConstraintKinds: [],
  editableIdentityGenerations: [],
  fields: [
    {
      ordinalPosition: 1, name: 'tenant id', typeSchema: 'sys', typeName: 'int', dataType: 'int',
      editableType: null, editable: false, identityEditable: false, characterMaximumLength: null,
      numericPrecision: null, numericScale: null, nullable: false, defaultExpression: null,
      identityGeneration: null, generated: false, generationExpression: null,
    },
    {
      ordinalPosition: 2, name: 'label', typeSchema: 'sys', typeName: 'nvarchar', dataType: 'nvarchar(120)',
      editableType: null, editable: false, identityEditable: false, characterMaximumLength: 120,
      numericPrecision: null, numericScale: null, nullable: false, defaultExpression: null,
      identityGeneration: null, generated: false, generationExpression: null,
    },
  ],
  constraints: [{
    name: 'pk_order', kind: 'primaryKey', editable: false, fieldNames: ['tenant id'],
    definition: 'PRIMARY KEY ([tenant id])', referencedSchema: null, referencedTable: null, referencedFieldNames: [],
  }],
};

describe('SQL Server adapter shared contracts and SQL generation', () => {
  it('validates SQL Server connection settings with secure encryption defaults', () => {
    expect(databaseConnectRequestSchema.parse({
      adapter: 'sqlserver', host: 'localhost', port: 1433, database: 'querydock', username: 'reader', password: 'secret',
    })).toMatchObject({ encrypt: true, trustServerCertificate: false });
  });

  it('quotes closing brackets in identifiers and escapes Unicode literals', () => {
    expect(sqlServerInternals.quoteIdentifier('order]items')).toBe('[order]]items]');
    expect(sqlServerInternals.previewStatement(snapshot, {
      kind: 'insertDataRow', draftId: '36b9d28c-3a5e-4b53-9115-5a69e0c437b0',
      values: { 'tenant id': '7', label: "O'Brien" },
    })).toBe("INSERT INTO [sales data].[order]]items] ([tenant id], [label]) VALUES (N'7', N'O''Brien');");
  });

  it('preserves composite foreign key field ordering from SQL Server catalog ordinals', () => {
    expect(sqlServerInternals.mapConstraints([
      { constraintName: 'fk_child', constraintType: 'F', fieldName: 'tenant_id', keyOrdinal: 1,
        referencedSchema: 'dbo', referencedTable: 'parent', referencedFieldName: 'tenant_id', definition: null },
      { constraintName: 'fk_child', constraintType: 'F', fieldName: 'parent_id', keyOrdinal: 2,
        referencedSchema: 'dbo', referencedTable: 'parent', referencedFieldName: 'id', definition: null },
    ])).toEqual([expect.objectContaining({
      kind: 'foreignKey', fieldNames: ['tenant_id', 'parent_id'],
      referencedSchema: 'dbo', referencedTable: 'parent', referencedFieldNames: ['tenant_id', 'id'],
    })]);
  });

  it('keeps row versions stable and disables writes for unsupported SQL Server types', () => {
    const row = { 'tenant id': '7', label: 'customer' };
    expect(sqlServerInternals.rowVersion(snapshot.fields, row)).toBe(sqlServerInternals.rowVersion(snapshot.fields, row));
    expect(sqlServerInternals.rowVersion(snapshot.fields, row)).not.toBe(sqlServerInternals.rowVersion(snapshot.fields, { ...row, label: 'changed' }));
    expect(sqlServerInternals.supportsTextRoundTrip('nvarchar')).toBe(true);
    expect(sqlServerInternals.supportsTextRoundTrip('varbinary')).toBe(false);
  });
});
