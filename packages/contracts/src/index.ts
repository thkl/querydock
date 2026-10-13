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
  fieldNames: z.array(z.string()),
  definition: z.string(),
  referencedSchema: z.string().nullable(),
  referencedTable: z.string().nullable(),
  referencedFieldNames: z.array(z.string()),
});

export type TableConstraintDescriptor = z.infer<typeof tableConstraintDescriptorSchema>;

export const tableSnapshotSchema = z.object({
  schema: z.string(),
  name: z.string(),
  kind: resourceDescriptorSchema.shape.kind,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  fields: z.array(tableFieldDescriptorSchema),
  constraints: z.array(tableConstraintDescriptorSchema),
});

export type TableSnapshot = z.infer<typeof tableSnapshotSchema>;
