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

export const sqlServerConnectRequestSchema = z.object({
  adapter: z.literal('sqlserver'),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  database: z.string().trim().min(1).max(128),
  username: z.string().trim().min(1).max(128),
  password: z.string().max(1024),
  encrypt: z.boolean().default(true),
  trustServerCertificate: z.boolean().default(false),
});

export type SqlServerConnectRequest = z.infer<typeof sqlServerConnectRequestSchema>;
export const mysqlConnectRequestSchema = z.object({
  adapter: z.literal('mysql'),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  database: z.string().trim().min(1).max(64),
  username: z.string().trim().min(1).max(128),
  password: z.string().max(1024),
  ssl: z.boolean().default(false),
});
export type MysqlConnectRequest = z.infer<typeof mysqlConnectRequestSchema>;
export const supportedDatabaseAdapterSchema = z.object({
  adapter: z.enum(['postgresql', 'sqlserver', 'mysql']),
  label: z.string(),
  defaultPort: z.number().int().min(1).max(65535),
  transportOptions: z.enum(['postgresSsl', 'sqlServerTls', 'mysqlTls']),
});
export type SupportedDatabaseAdapter = z.infer<typeof supportedDatabaseAdapterSchema>;
export const databaseConnectRequestSchema = z.discriminatedUnion('adapter', [
  postgresConnectRequestSchema,
  sqlServerConnectRequestSchema,
  mysqlConnectRequestSchema,
]);
export type DatabaseConnectRequest = z.infer<typeof databaseConnectRequestSchema>;

export const connectionTargetSchema = z.discriminatedUnion('adapter', [
  postgresConnectRequestSchema.pick({ adapter: true, host: true, port: true, database: true, username: true }),
  sqlServerConnectRequestSchema.pick({ adapter: true, host: true, port: true, database: true, username: true }),
  mysqlConnectRequestSchema.pick({ adapter: true, host: true, port: true, database: true, username: true }),
]);

export type ConnectionTarget = z.infer<typeof connectionTargetSchema>;

export const schemaCapabilitiesSchema = z.object({
  createTableIfNotExists: z.boolean(),
});
export type SchemaCapabilities = z.infer<typeof schemaCapabilitiesSchema>;

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
  schemaCapabilities: schemaCapabilitiesSchema,
});

export type ConnectResponse = z.infer<typeof connectResponseSchema>;

export const effectivePrivilegeSchema = z.object({
  name: z.string(),
  granted: z.boolean(),
});

export const databasePermissionReportSchema = z.object({
  adapter: z.enum(['postgresql', 'sqlserver', 'mysql']),
  database: z.string(),
  currentUser: z.string(),
  serverUser: z.string().nullable(),
  databasePrivileges: z.array(effectivePrivilegeSchema),
  schemas: z.array(z.object({
    name: z.string(),
    privileges: z.array(effectivePrivilegeSchema),
    objects: z.array(z.object({
      name: z.string(),
      kind: z.enum(['table', 'view']),
      privileges: z.array(effectivePrivilegeSchema),
    })),
  })),
});

export type DatabasePermissionReport = z.infer<typeof databasePermissionReportSchema>;

export const resourceDescriptorSchema = z.object({
  schema: z.string(),
  name: z.string(),
  kind: z.enum(['table', 'partitionedTable', 'view', 'materializedView', 'foreignTable']),
  isUpdatable: z.boolean(),
  canBrowseData: z.boolean().optional(),
  canCreateTable: z.boolean(),
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
  /** SQL Server names a default as a table constraint, which the adapter needs to replace it. */
  defaultConstraintName: z.string().nullable().optional(),
});

export type TableFieldDescriptor = z.infer<typeof tableFieldDescriptorSchema>;

export const editableFieldTypeDescriptorSchema = z.object({
  value: z.string(),
  label: z.string(),
  typeSchema: z.string(),
  typeName: z.string(),
  identityGenerationSupported: z.boolean(),
  defaultExpressions: z.array(z.object({ value: z.string(), label: z.string() })).default([]),
});
export type EditableFieldTypeDescriptor = z.infer<typeof editableFieldTypeDescriptorSchema>;

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

export const foreignKeyFieldChoicesSchema = z.object({
  fieldSets: z.array(z.object({
    fieldNames: z.array(z.string()).min(1),
    label: z.string(),
    compatible: z.boolean(),
    reason: z.string().nullable(),
  })),
});
export type ForeignKeyFieldChoices = z.infer<typeof foreignKeyFieldChoicesSchema>;

export const foreignKeyFieldChoicesRequestSchema = z.object({
  localFieldNames: z.array(z.string().min(1).max(2048)).min(1).max(32),
});
export type ForeignKeyFieldChoicesRequest = z.infer<typeof foreignKeyFieldChoicesRequestSchema>;

export const editableConstraintKindSchema = z.enum(['primaryKey', 'unique', 'foreignKey', 'check']);
export type EditableConstraintKind = z.infer<typeof editableConstraintKindSchema>;

export const tableSnapshotSchema = z.object({
  schema: z.string(),
  name: z.string(),
  kind: resourceDescriptorSchema.shape.kind,
  definitionSql: z.string().nullable().optional(),
  canAlter: z.boolean(),
  canBrowseData: z.boolean().optional(),
  /** Adapter-specific capabilities for schema operations narrower than general ALTER support. */
  canEditFields: z.boolean().optional(),
  canEditConstraints: z.boolean().optional(),
  canRenameTable: z.boolean().optional(),
  canDropTable: z.boolean().optional(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  editableFieldTypes: z.array(editableFieldTypeDescriptorSchema),
  editableConstraintKinds: z.array(z.object({ value: editableConstraintKindSchema, label: z.string() })),
  editableIdentityGenerations: z.array(z.object({ value: z.enum(['none', 'always', 'byDefault']), label: z.string() })),
  fields: z.array(tableFieldDescriptorSchema),
  constraints: z.array(tableConstraintDescriptorSchema),
});

export type TableSnapshot = z.infer<typeof tableSnapshotSchema>;

export const tableDataFilterSchema = z.object({
  field: z.string().min(1).max(63),
  operator: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'contains', 'notContains', 'startsWith', 'endsWith', 'in', 'isNull', 'isNotNull']),
  value: z.string().max(4096).optional(),
  secondValue: z.string().max(4096).optional(),
  values: z.array(z.string().max(4096)).max(100).optional(),
});

export const tableDataSortSchema = z.object({
  field: z.string().min(1).max(63),
  direction: z.enum(['asc', 'desc']),
});

export const tableDataQueryRequestSchema = z.object({
  offset: z.number().int().min(0).max(1_000_000),
  limit: z.number().int().min(1).max(100),
  sort: z.array(tableDataSortSchema).max(10).default([]),
  filters: z.array(tableDataFilterSchema).max(20).default([]),
  quickFilter: z.string().max(256).default(''),
});
export type TableDataQueryRequest = z.infer<typeof tableDataQueryRequestSchema>;

export const tableDataQueryResponseSchema = z.object({
  columns: z.array(z.object({
    ordinalPosition: z.number().int().positive(),
    name: z.string(),
    dataType: z.string(),
    nullable: z.boolean(),
    editable: z.boolean(),
    insertable: z.boolean(),
  })),
  rows: z.array(z.record(z.string(), z.string().nullable())),
  /** Primary key fields used as stable row identities for updates. */
  keyFields: z.array(z.string()),
  /** Opaque adapter concurrency tokens aligned by index with `rows` when row edits are supported. */
  rowVersions: z.array(z.string()),
  canUpdateRows: z.boolean(),
  canInsertRows: z.boolean(),
  canDeleteRows: z.boolean(),
  totalRows: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type TableDataQueryResponse = z.infer<typeof tableDataQueryResponseSchema>;

export const tableDataRowUpdateSchema = z.object({
  key: z.record(z.string(), z.string().nullable()).refine((value) => Object.keys(value).length > 0),
  expectedVersion: z.string().min(1).max(256),
  changes: z.record(z.string(), z.string().nullable()).refine((value) => Object.keys(value).length > 0),
});
export type TableDataRowUpdate = z.infer<typeof tableDataRowUpdateSchema>;

export const tableDataRowDeleteSchema = tableDataRowUpdateSchema.pick({ key: true, expectedVersion: true });
export type TableDataRowDelete = z.infer<typeof tableDataRowDeleteSchema>;

export const tableDataRowInsertSchema = z.object({
  draftId: z.uuid(),
  values: z.record(z.string(), z.string().nullable()),
});
export type TableDataRowInsert = z.infer<typeof tableDataRowInsertSchema>;

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
    constraintKind: z.literal('foreignKey'),
    name: z.string().max(2048),
    fieldNames: z.array(z.string().max(2048)).min(1).max(32),
    referencedSchema: z.string().max(1024),
    referencedTable: z.string().max(1024),
    referencedFieldNames: z.array(z.string().max(2048)).min(1).max(32),
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

export const createTableFieldSchema = z.object({
  name: z.string().max(2048),
  type: nullableFieldTypeSchema,
  typeDetails: z.string().max(256).optional(),
  nullable: z.boolean(),
  defaultExpression: z.string().max(4096).nullable(),
  identityGeneration: z.enum(['always', 'byDefault']).nullable(),
});

export type CreateTableField = z.infer<typeof createTableFieldSchema>;

export const createTableOperationSchema = z.object({
  kind: z.literal('createTable'),
  draftId: z.uuid().optional(),
  table: z.string().max(1024),
  ifNotExists: z.boolean(),
  fields: z.array(createTableFieldSchema).min(1).max(64),
});

export type CreateTableOperation = z.infer<typeof createTableOperationSchema>;

export const renameTableOperationSchema = z.object({
  kind: z.literal('renameTable'),
  newName: z.string().max(1024),
});

export const dropTableOperationSchema = z.object({
  kind: z.literal('dropTable'),
});

export const updateDataRowOperationSchema = tableDataRowUpdateSchema.extend({
  kind: z.literal('updateDataRow'),
});

export const insertDataRowOperationSchema = tableDataRowInsertSchema.extend({
  kind: z.literal('insertDataRow'),
});

export const deleteDataRowOperationSchema = tableDataRowDeleteSchema.extend({
  kind: z.literal('deleteDataRow'),
});

export const schemaOperationSchema = z.discriminatedUnion('kind', [
  createTableOperationSchema,
  renameTableOperationSchema,
  dropTableOperationSchema,
  updateDataRowOperationSchema,
  insertDataRowOperationSchema,
  deleteDataRowOperationSchema,
  addNullableFieldOperationSchema,
  alterFieldOperationSchema,
  addConstraintOperationSchema,
  dropConstraintOperationSchema,
]);

export type SchemaOperation = z.infer<typeof schemaOperationSchema>;

export const migrationTablePlanSchema = z.object({
  schema: z.string().max(1024),
  table: z.string().max(1024),
  baselineFingerprint: tableSnapshotSchema.shape.fingerprint.nullable(),
  operations: z.array(schemaOperationSchema).min(1).max(50),
});

export type MigrationTablePlan = z.infer<typeof migrationTablePlanSchema>;

export const migrationPreviewRequestSchema = migrationTablePlanSchema.extend({
  /** Additional table plans in one atomic batch, ordered by the server's dependency planner. */
  tablePlans: z.array(migrationTablePlanSchema).min(2).max(50).optional(),
});

export type MigrationPreviewRequest = z.infer<typeof migrationPreviewRequestSchema>;

export const migrationPreviewResponseSchema = z.object({
  baselineFingerprint: tableSnapshotSchema.shape.fingerprint.nullable(),
  statements: z.array(z.string()),
  warnings: z.array(z.string()),
});

export type MigrationPreviewResponse = z.infer<typeof migrationPreviewResponseSchema>;

export const dataRunbookPreviewRequestSchema = z.object({
  operations: z.array(z.union([updateDataRowOperationSchema, insertDataRowOperationSchema, deleteDataRowOperationSchema])).min(1).max(50),
});
export type DataRunbookPreviewRequest = z.infer<typeof dataRunbookPreviewRequestSchema>;

export const dataRunbookPreviewResponseSchema = z.object({
  snapshot: tableSnapshotSchema,
  preview: migrationPreviewResponseSchema,
});
export type DataRunbookPreviewResponse = z.infer<typeof dataRunbookPreviewResponseSchema>;

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
  snapshots: z.array(tableSnapshotSchema),
  tableResults: z.array(z.object({
    schema: z.string(),
    table: z.string(),
    resultingTable: z.string().nullable(),
    snapshot: tableSnapshotSchema.nullable(),
  })).optional(),
});

export type MigrationApplyResponse = z.infer<typeof migrationApplyResponseSchema>;
