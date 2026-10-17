import { describe, expect, it } from 'vitest';
import type { TableSnapshot } from '@querydock/contracts';
import {
  collectMigrationWarnings,
  createMigrationPreview,
  createTableStatement,
  MigrationPlanError,
} from '../src/feature/postgres/postgres.adapter.ts';

const snapshot: TableSnapshot = {
  schema: 'sales data',
  name: 'order items',
  kind: 'table',
  canAlter: true,
  fingerprint: 'a'.repeat(64),
  editableFieldTypes: [],
  editableConstraintKinds: [],
  editableIdentityGenerations: [],
  fields: [
    { ordinalPosition: 1, name: 'id', typeSchema: 'pg_catalog', typeName: 'int4', dataType: 'integer',
      editableType: 'integer', editable: true, identityEditable: true, characterMaximumLength: null,
      numericPrecision: 32, numericScale: 0, nullable: false, defaultExpression: null,
      identityGeneration: null, generated: false, generationExpression: null },
    { ordinalPosition: 2, name: 'label', typeSchema: 'pg_catalog', typeName: 'varchar', dataType: 'character varying',
      editableType: 'varchar', editable: true, identityEditable: false, characterMaximumLength: 40,
      numericPrecision: null, numericScale: null, nullable: true, defaultExpression: null,
      identityGeneration: null, generated: false, generationExpression: null },
  ],
  constraints: [
    { name: 'old_label_key', kind: 'unique', editable: true, fieldNames: ['label'], definition: 'UNIQUE (label)',
      referencedSchema: null, referencedTable: null, referencedFieldNames: [] },
  ],
};

function preview(operations: Parameters<typeof createMigrationPreview>[1]['operations']): string[] {
  return createMigrationPreview(snapshot, {
    schema: snapshot.schema,
    table: snapshot.name,
    baselineFingerprint: snapshot.fingerprint,
    operations,
  });
}

describe('PostgreSQL schema migration planning', () => {
  it('quotes identifiers and produces dedicated table rename and drop statements', () => {
    expect(preview([{ kind: 'renameTable', newName: 'order archive' }])).toEqual([
      'ALTER TABLE "sales data"."order items" RENAME TO "order archive";',
    ]);
    expect(preview([{ kind: 'dropTable' }])).toEqual(['DROP TABLE "sales data"."order items";']);
  });

  it('generates adapter-owned CREATE TABLE SQL for configured fields and IF NOT EXISTS', () => {
    expect(createTableStatement('sales data', 'daily totals', [
      { name: 'id', type: 'bigint', nullable: false, defaultExpression: null, identityGeneration: 'always' },
      { name: 'amount', type: 'numeric', typeDetails: '12, 2',
        nullable: true, defaultExpression: '0', identityGeneration: null },
    ], true)).toBe('CREATE TABLE IF NOT EXISTS "sales data"."daily totals" (\n  "id" bigint GENERATED ALWAYS AS IDENTITY,\n  "amount" numeric(12, 2) DEFAULT 0\n);');
  });

  it('orders constraint drops before field changes and additions after them', () => {
    expect(preview([
      { kind: 'addConstraint', constraintKind: 'unique', name: 'new_title_key', fieldNames: ['title'] },
      { kind: 'alterField', name: 'label', newName: 'title', type: 'text', characterMaximumLength: null,
        numericPrecision: null, numericScale: null, defaultExpression: "'untitled'", nullable: false },
      { kind: 'dropConstraint', name: 'old_label_key' },
    ])).toEqual([
      'ALTER TABLE "sales data"."order items" DROP CONSTRAINT "old_label_key";',
      'ALTER TABLE "sales data"."order items" RENAME COLUMN "label" TO "title";',
      'ALTER TABLE "sales data"."order items" ALTER COLUMN "title" TYPE text;',
      'ALTER TABLE "sales data"."order items" ALTER COLUMN "title" SET DEFAULT \'untitled\';',
      'ALTER TABLE "sales data"."order items" ALTER COLUMN "title" SET NOT NULL;',
      'ALTER TABLE "sales data"."order items" ADD CONSTRAINT "new_title_key" UNIQUE ("title");',
    ]);
  });

  it('generates supported foreign-key and CHECK SQL from structured operations', () => {
    expect(preview([
      { kind: 'addConstraint', constraintKind: 'foreignKey', name: 'fk_parent', fieldNames: ['id'],
        referencedSchema: 'public', referencedTable: 'parent', referencedFieldNames: ['id'] },
      { kind: 'addConstraint', constraintKind: 'check', name: 'positive_id', expression: 'id > 0' },
    ])).toEqual([
      'ALTER TABLE "sales data"."order items" ADD CONSTRAINT "fk_parent" FOREIGN KEY ("id") REFERENCES "public"."parent" ("id");',
      'ALTER TABLE "sales data"."order items" ADD CONSTRAINT "positive_id" CHECK (("id" > 0));',
    ]);
  });

  it('rejects type parameters unsupported by PostgreSQL and references to missing fields', () => {
    expect(() => preview([{ kind: 'addNullableField', name: 'notes', type: 'text',
      characterMaximumLength: 100 }])).toThrowError(MigrationPlanError);
    expect(() => preview([{ kind: 'addConstraint', constraintKind: 'unique', name: 'missing_key',
      fieldNames: ['missing'] }])).toThrow(/does not exist/);
  });

  it('generates identity transitions and warns about backfill and sequence risks', () => {
    const addIdentity = [{ kind: 'alterField', name: 'id', newName: 'id', type: 'integer',
      characterMaximumLength: null, numericPrecision: null, numericScale: null,
      defaultExpression: null, nullable: false, identityGeneration: 'always' }] as const;
    expect(preview([...addIdentity])).toEqual([
      'ALTER TABLE "sales data"."order items" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY;',
    ]);
    expect(collectMigrationWarnings(snapshot, [...addIdentity]).join(' ')).toContain('sequence will not collide');

    const identitySnapshot: TableSnapshot = {
      ...snapshot,
      fields: snapshot.fields.map((field) => field.name === 'id'
        ? { ...field, identityGeneration: 'always' as const }
        : field),
    };
    expect(createMigrationPreview(identitySnapshot, {
      schema: snapshot.schema, table: snapshot.name, baselineFingerprint: snapshot.fingerprint,
      operations: [{ ...addIdentity[0], identityGeneration: 'byDefault' }],
    })).toContain('ALTER TABLE "sales data"."order items" ALTER COLUMN "id" SET GENERATED BY DEFAULT;');
  });

  it('surfaces destructive and data validation warnings for table and constraint changes', () => {
    expect(collectMigrationWarnings(snapshot, [{ kind: 'dropTable' }])).toEqual([
      expect.stringContaining('permanently removes the table and its data'),
    ]);
    expect(collectMigrationWarnings(snapshot, [
      { kind: 'addConstraint', constraintKind: 'check', name: 'valid_label', expression: "label <> ''" },
      { kind: 'dropConstraint', name: 'old_label_key' },
    ])).toEqual([
      expect.stringContaining('may fail if existing rows'),
      expect.stringContaining('reduces database integrity protection'),
    ]);
  });

  it('quotes unusual table and column names and validates CREATE TABLE type options', () => {
    expect(createTableStatement('odd schema', 'select', [
      { name: 'display "name"', type: 'varchar', typeDetails: '24', nullable: true, defaultExpression: null, identityGeneration: null },
    ])).toContain('"display ""name""" character varying(24)');
    expect(() => createTableStatement('public', 'empty', [])).toThrow(/at least one field/i);
    expect(() => createTableStatement('public', 'dupe', [
      { name: 'id', type: 'integer', nullable: true, defaultExpression: null, identityGeneration: null },
      { name: 'id', type: 'text', nullable: true, defaultExpression: null, identityGeneration: null },
    ])).toThrow(/appears more than once/);
    expect(() => createTableStatement('public', 'bad', [
      { name: 'body', type: 'text', typeDetails: '255', nullable: true, defaultExpression: null, identityGeneration: null },
    ])).toThrow(/do not accept size/i);
    expect(() => createTableStatement('public', 'bad', [
      { name: 'amount', type: 'numeric', typeDetails: '1001, 2', nullable: true, defaultExpression: null, identityGeneration: null },
    ])).toThrow(/precision/i);
    expect(() => createTableStatement('public', 'bad', [
      { name: 'id', type: 'text', nullable: false, defaultExpression: null, identityGeneration: 'always' },
    ])).toThrow(/identity generation is not supported/i);
    expect(() => createTableStatement('public', 'bad', [
      { name: 'id', type: 'integer', nullable: false, defaultExpression: '1', identityGeneration: 'always' },
    ])).toThrow(/cannot also have a default/i);
  });

  it('validates and orders field operations while preserving correct defaults, nullability, and identity transitions', () => {
    const baseline: TableSnapshot = {
      ...snapshot,
      fields: snapshot.fields.map((field) => field.name === 'id'
        ? { ...field, identityGeneration: 'always' as const, defaultExpression: null }
        : field),
    };
    const result = createMigrationPreview(baseline, {
      schema: baseline.schema,
      table: baseline.name,
      baselineFingerprint: baseline.fingerprint,
      operations: [
        { kind: 'alterField', name: 'id', newName: 'account_id', type: 'integer', characterMaximumLength: null,
          numericPrecision: null, numericScale: null, defaultExpression: null, nullable: false, identityGeneration: null },
        { kind: 'addNullableField', name: 'active', type: 'boolean', defaultExpression: 'true' },
      ],
    });
    expect(result).toEqual([
      'ALTER TABLE "sales data"."order items" RENAME COLUMN "id" TO "account_id";',
      'ALTER TABLE "sales data"."order items" ALTER COLUMN "account_id" DROP IDENTITY;',
      'ALTER TABLE "sales data"."order items" ADD COLUMN "active" boolean DEFAULT true;',
    ]);
    expect(() => preview([
      { kind: 'alterField', name: 'id', newName: 'label', type: 'integer', characterMaximumLength: null,
        numericPrecision: null, numericScale: null, defaultExpression: null, nullable: false },
    ])).toThrow(/already exists/);
    expect(() => preview([
      { kind: 'addNullableField', name: 'label', type: 'text' },
    ])).toThrow(/already exists/);
    expect(() => preview([
      { kind: 'addNullableField', name: 'new', type: 'text' },
      { kind: 'addNullableField', name: 'new', type: 'text' },
    ])).toThrow(/appears more than once/);
    expect(() => preview([
      { kind: 'addNullableField', name: 'new', type: 'text', defaultExpression: '1; DROP TABLE t' },
    ])).toThrow(/single SQL default expression/);
  });

  it('rejects unsupported lifecycle combinations and duplicate or missing constraint operations', () => {
    expect(() => preview([
      { kind: 'renameTable', newName: 'renamed' },
      { kind: 'addNullableField', name: 'new', type: 'text' },
    ])).toThrow(/Rename a table in its own runbook plan/);
    expect(() => preview([{ kind: 'renameTable', newName: snapshot.name }])).toThrow(/different name/);
    expect(() => preview([{ kind: 'dropConstraint', name: 'missing_constraint' }])).toThrow(/no longer exists/);
    expect(() => preview([
      { kind: 'dropConstraint', name: 'old_label_key' },
      { kind: 'dropConstraint', name: 'old_label_key' },
    ])).toThrow(/appears more than once/);
    expect(() => preview([
      { kind: 'addConstraint', constraintKind: 'unique', name: 'new_key', fieldNames: ['id'] },
      { kind: 'addConstraint', constraintKind: 'unique', name: 'new_key', fieldNames: ['label'] },
    ])).toThrow(/appears more than once/);
    expect(() => preview([
      { kind: 'dropConstraint', name: 'old_label_key' },
      { kind: 'addConstraint', constraintKind: 'unique', name: 'old_label_key', fieldNames: ['id'] },
    ])).not.toThrow();
    const primaryKeySnapshot = {
      ...snapshot,
      constraints: [...snapshot.constraints, {
        name: 'id_pk', kind: 'primaryKey' as const, editable: true, fieldNames: ['id'], definition: 'PRIMARY KEY (id)',
        referencedSchema: null, referencedTable: null, referencedFieldNames: [],
      }],
    };
    expect(() => createMigrationPreview(primaryKeySnapshot, {
      schema: snapshot.schema, table: snapshot.name, baselineFingerprint: snapshot.fingerprint,
      operations: [{ kind: 'addConstraint', constraintKind: 'primaryKey', name: 'pk2', fieldNames: ['id'] }],
    }))
      .toThrow(/already has a primary key/);
  });

  it('normalizes safe CHECK expressions and rejects unknown fields, malformed tokens, and SQL statements', () => {
    expect(preview([{
      kind: 'addConstraint', constraintKind: 'check', name: 'safe_check',
      expression: 'id >= 1 AND (label <> \'blocked\' OR id IN (2, 3))',
    }])).toEqual([
      'ALTER TABLE "sales data"."order items" ADD CONSTRAINT "safe_check" CHECK ((("id" >= 1) AND ((("label" <> \'blocked\') OR ("id" IN (2, 3))))));',
    ]);
    expect(() => preview([{
      kind: 'addConstraint', constraintKind: 'check', name: 'unknown_check', expression: 'missing > 0',
    }])).toThrow(/does not exist/);
    expect(() => preview([{
      kind: 'addConstraint', constraintKind: 'check', name: 'statement_check', expression: 'id > 0; DROP TABLE users',
    }])).toThrow(/not supported/);
    expect(() => preview([{
      kind: 'addConstraint', constraintKind: 'check', name: 'quote_check', expression: 'label = \'broken',
    }])).toThrow(/Close the quoted string/);
  });

  it('covers warning generation for defaults, identity, keys, foreign keys, CHECK, and null changes', () => {
    const warnings = collectMigrationWarnings(snapshot, [
      { kind: 'addNullableField', name: 'new_id', type: 'integer', defaultExpression: '1', identityGeneration: null },
      { kind: 'addNullableField', name: 'generated_id', type: 'integer', identityGeneration: 'always' },
      { kind: 'alterField', name: 'label', newName: 'label', type: 'text', characterMaximumLength: null,
        numericPrecision: null, numericScale: null, defaultExpression: null, nullable: false },
      { kind: 'addConstraint', constraintKind: 'primaryKey', name: 'id_pk', fieldNames: ['label'] },
      { kind: 'addConstraint', constraintKind: 'foreignKey', name: 'parent_fk', fieldNames: ['id'],
        referencedSchema: 'public', referencedTable: 'parent', referencedFieldNames: ['id'] },
      { kind: 'addConstraint', constraintKind: 'check', name: 'positive_id', expression: 'id > 0' },
      { kind: 'dropConstraint', name: 'old_label_key' },
    ]);
    expect(warnings).toHaveLength(8);
    expect(warnings.join('\n')).toContain('may populate existing rows');
    expect(warnings.join('\n')).toContain('rewrites the table');
    expect(warnings.join('\n')).toContain('may fail if existing rows contain NULL');
    expect(warnings.join('\n')).toContain('matching referenced row');
    expect(warnings.join('\n')).toContain('CHECK constraint');
    expect(warnings.join('\n')).toContain('reduces database integrity protection');
  });
});
