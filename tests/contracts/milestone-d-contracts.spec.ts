import { describe, expect, it } from 'vitest';
import {
  migrationApplyResponseSchema,
  migrationPreviewRequestSchema,
  schemaOperationSchema,
} from '@querydock/contracts';

describe('Milestone D shared contracts', () => {
  it.each([
    { kind: 'createTable', table: 'audit_log', ifNotExists: true, fields: [
      { name: 'id', type: 'bigint', nullable: false, defaultExpression: null, identityGeneration: 'always' },
    ] },
    { kind: 'renameTable', newName: 'audit_archive' },
    { kind: 'dropTable' },
    { kind: 'alterField', name: 'label', newName: 'title', type: 'varchar', characterMaximumLength: 200,
      numericPrecision: null, numericScale: null, defaultExpression: null, nullable: true },
    { kind: 'addConstraint', constraintKind: 'foreignKey', name: 'fk_child_parent', fieldNames: ['parent_id'],
      referencedSchema: 'public', referencedTable: 'parent', referencedFieldNames: ['id'] },
    { kind: 'addConstraint', constraintKind: 'check', name: 'positive_count', expression: 'count >= 0' },
    { kind: 'dropConstraint', name: 'old_key' },
  ])('accepts supported operation shape: $kind', (operation) => {
    expect(schemaOperationSchema.safeParse(operation).success).toBe(true);
  });

  it('rejects malformed field, foreign-key, and unknown operations', () => {
    expect(schemaOperationSchema.safeParse({ kind: 'addNullableField', name: 'x', type: '' }).success).toBe(false);
    expect(schemaOperationSchema.safeParse({ kind: 'addConstraint', constraintKind: 'foreignKey', name: 'fk',
      fieldNames: ['id'], referencedSchema: 'public', referencedTable: 'parent', referencedFieldNames: [] }).success).toBe(false);
    expect(schemaOperationSchema.safeParse({ kind: 'createIndex', name: 'idx' }).success).toBe(false);
  });

  it('leaves baseline compatibility to the adapter and allows an empty snapshot result for a dropped table', () => {
    const baselineRequest = migrationPreviewRequestSchema.safeParse({
      schema: 'public', table: 'users', baselineFingerprint: null, operations: [{ kind: 'dropTable' }],
    });
    expect(baselineRequest.success).toBe(true); // Baseline/operation compatibility is enforced by the adapter.
    expect(migrationApplyResponseSchema.safeParse({ appliedStatements: ['DROP TABLE "public"."users";'], snapshots: [] }).success)
      .toBe(true);
  });

  it('accepts atomic cross-table schema plans and per-table apply results', () => {
    const plans = [
      { schema: 'public', table: 'children', baselineFingerprint: 'a'.repeat(64),
        operations: [{ kind: 'dropConstraint', name: 'fk_children_parents' }] },
      { schema: 'public', table: 'parents', baselineFingerprint: 'b'.repeat(64),
        operations: [{ kind: 'dropTable' }] },
    ];
    expect(migrationPreviewRequestSchema.safeParse({ ...plans[0], tablePlans: plans }).success).toBe(true);
    expect(migrationApplyResponseSchema.safeParse({
      appliedStatements: ['ALTER TABLE children DROP CONSTRAINT fk_children_parents', 'DROP TABLE parents'],
      snapshots: [],
      tableResults: [
        { schema: 'public', table: 'children', resultingTable: 'children', snapshot: null },
        { schema: 'public', table: 'parents', resultingTable: null, snapshot: null },
      ],
    }).success).toBe(true);
  });
});
