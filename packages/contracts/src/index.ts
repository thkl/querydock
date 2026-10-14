export { z } from 'zod';

import { z } from 'zod';

export const postgresConnectRequestSchema = z.object({
  adapter: z.literal('postgresql'),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  database: z.string().trim().min(1).max(63),
  username: z.string().trim().min(1).max(63),
  password: z.string().max(1024),
  sslMode: z.enum(['disable', 'require', 'verify-full']),
});

export type PostgresConnectRequest = z.infer<typeof postgresConnectRequestSchema>;

export const connectionTargetSchema = postgresConnectRequestSchema
  .pick({ adapter: true, host: true, port: true, database: true, username: true })
  .strict();

export type ConnectionTarget = z.infer<typeof connectionTargetSchema>;

export const connectionCapabilitiesSchema = z.object({
  discoverResources: z.boolean(),
  inspectTables: z.boolean(),
  browseData: z.boolean(),
  mutateData: z.boolean(),
  editSchema: z.boolean(),
  executeSql: z.boolean(),
});

export const connectResponseSchema = z.object({
  connectionId: z.uuid(),
  target: connectionTargetSchema,
  serverVersion: z.string(),
  capabilities: connectionCapabilitiesSchema,
});

export type ConnectResponse = z.infer<typeof connectResponseSchema>;

export const resourceDescriptorSchema = z.object({
  schema: z.string(),
  name: z.string(),
  kind: z.enum(['table', 'partitionedTable', 'view', 'materializedView', 'foreignTable']),
  isUpdatable: z.boolean(),
});

export type ResourceDescriptor = z.infer<typeof resourceDescriptorSchema>;

export const tableFieldDescriptorSchema = z.object({
  ordinalPosition: z.number().int().positive(),
  name: z.string(),
  typeSchema: z.string(),
  typeName: z.string(),
  dataType: z.string(),
  editableType: z.string().nullable(),
  editable: z.boolean(),
  identityEditable: z.boolean(),
  characterMaximumLength: z.number().nullable(),
  numericPrecision: z.number().nullable(),
  numericScale: z.number().nullable(),
  nullable: z.boolean(),
  defaultExpression: z.string().nullable(),
  identityGeneration: z.enum(['always', 'byDefault']).nullable(),
  generated: z.boolean(),
  generationExpression: z.string().nullable(),
});

export type TableFieldDescriptor = z.infer<typeof tableFieldDescriptorSchema>;

export const tableConstraintDescriptorSchema = z.object({
  name: z.string(),
  kind: z.enum(['primaryKey', 'unique', 'foreignKey', 'check', 'exclusion']),
  editable: z.boolean(),
  fieldNames: z.array(z.string()),
  definition: z.string(),
  referencedSchema: z.string().nullable(),
  referencedTable: z.string().nullable(),
  referencedFieldNames: z.array(z.string()),
});

export type TableConstraintDescriptor = z.infer<typeof tableConstraintDescriptorSchema>;

export const editableConstraintKindSchema = z.enum(['primaryKey', 'unique', 'check']);
export type EditableConstraintKind = z.infer<typeof editableConstraintKindSchema>;

export const tableSnapshotSchema = z.object({
  schema: z.string(),
  name: z.string(),
  kind: resourceDescriptorSchema.shape.kind,
  canAlter: z.boolean(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  editableFieldTypes: z.array(z.object({
    value: z.string(),
    label: z.string(),
    typeSchema: z.string(),
    typeName: z.string(),
    identityGenerationSupported: z.boolean(),
  })),
  editableConstraintKinds: z.array(z.object({ value: editableConstraintKindSchema, label: z.string() })),
  editableIdentityGenerations: z.array(z.object({ value: z.enum(['none', 'always', 'byDefault']), label: z.string() })),
  fields: z.array(tableFieldDescriptorSchema),
  constraints: z.array(tableConstraintDescriptorSchema),
});

export type TableSnapshot = z.infer<typeof tableSnapshotSchema>;

// Type identifiers and parameter rules belong to the active database adapter.
export const nullableFieldTypeSchema = z.string().trim().min(1).max(128);

export type NullableFieldType = z.infer<typeof nullableFieldTypeSchema>;

export const addNullableFieldOperationSchema = z.object({
  kind: z.literal('addNullableField'),
  name: z.string().max(2048),
  type: nullableFieldTypeSchema,
  typeDetails: z.string().max(256).optional(),
  characterMaximumLength: z.number().nullable().optional(),
  numericPrecision: z.number().nullable().optional(),
  numericScale: z.number().nullable().optional(),
  defaultExpression: z.string().max(4096).nullable().optional(),
  identityGeneration: z.enum(['always', 'byDefault']).nullable().optional(),
});

export type AddNullableFieldOperation = z.infer<typeof addNullableFieldOperationSchema>;

export const alterFieldOperationSchema = z.object({
  kind: z.literal('alterField'),
  name: z.string().max(2048),
  newName: z.string().max(2048),
  type: nullableFieldTypeSchema,
  typeDetails: z.string().max(256).optional(),
  characterMaximumLength: z.number().nullable(),
  numericPrecision: z.number().nullable(),
  numericScale: z.number().nullable(),
  defaultExpression: z.string().max(4096).nullable(),
  nullable: z.boolean().optional(),
  identityGeneration: z.enum(['always', 'byDefault']).nullable().optional(),
});

export type AlterFieldOperation = z.infer<typeof alterFieldOperationSchema>;

export const addConstraintOperationSchema = z.discriminatedUnion('constraintKind', [
  z.object({
    kind: z.literal('addConstraint'),
    constraintKind: z.enum(['primaryKey', 'unique']),
    name: z.string().max(2048),
    fieldNames: z.array(z.string().max(2048)).min(1).max(32),
  }),
  z.object({
    kind: z.literal('addConstraint'),
    constraintKind: z.literal('check'),
    name: z.string().max(2048),
    expression: z.string().trim().min(1).max(4096),
  }),
]);

export type AddConstraintOperation = z.infer<typeof addConstraintOperationSchema>;

export const dropConstraintOperationSchema = z.object({
  kind: z.literal('dropConstraint'),
  name: z.string().max(2048),
});

export type DropConstraintOperation = z.infer<typeof dropConstraintOperationSchema>;

export const schemaOperationSchema = z.discriminatedUnion('kind', [
  addNullableFieldOperationSchema,
  alterFieldOperationSchema,
  addConstraintOperationSchema,
  dropConstraintOperationSchema,
]);

export type SchemaOperation = z.infer<typeof schemaOperationSchema>;

export const migrationPreviewRequestSchema = z.object({
  schema: z.string().max(1024),
  table: z.string().max(1024),
  baselineFingerprint: tableSnapshotSchema.shape.fingerprint,
  operations: z.array(schemaOperationSchema).min(1).max(50),
});

export type MigrationPreviewRequest = z.infer<typeof migrationPreviewRequestSchema>;

export const migrationPreviewResponseSchema = z.object({
  baselineFingerprint: tableSnapshotSchema.shape.fingerprint,
  statements: z.array(z.string()),
  warnings: z.array(z.string()),
});

export type MigrationPreviewResponse = z.infer<typeof migrationPreviewResponseSchema>;

export const schemaFieldDraftRequestSchema = z.object({
  schema: z.string().max(1024),
  table: z.string().max(1024),
  baselineFingerprint: tableSnapshotSchema.shape.fingerprint,
  operations: z.array(schemaOperationSchema).max(50),
  draft: z.object({
    sourceName: z.string().nullable(),
    name: z.string().max(2048),
    type: z.string().max(128),
    typeDetails: z.string().max(256),
    defaultValue: z.string().max(4096),
    nullable: z.boolean().optional(),
    identityGeneration: z.enum(['none', 'always', 'byDefault']).optional(),
  }),
});

export type SchemaFieldDraftRequest = z.infer<typeof schemaFieldDraftRequestSchema>;

export const schemaFieldDraftResponseSchema = migrationPreviewResponseSchema.extend({
  operations: z.array(schemaOperationSchema).max(50),
});

export type SchemaFieldDraftResponse = z.infer<typeof schemaFieldDraftResponseSchema>;

export const migrationApplyRequestSchema = migrationPreviewRequestSchema.extend({
  reviewedStatements: z.array(z.string().max(4096)).min(1).max(150),
  acknowledgedWarnings: z.array(z.string().max(2048)).max(50),
});

export type MigrationApplyRequest = z.infer<typeof migrationApplyRequestSchema>;

export const migrationApplyResponseSchema = z.object({
  appliedStatements: z.array(z.string()),
  snapshot: tableSnapshotSchema,
});

export type MigrationApplyResponse = z.infer<typeof migrationApplyResponseSchema>;
