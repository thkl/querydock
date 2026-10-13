import { createHash } from 'node:crypto';
import { Client } from 'pg';
import type {
  PostgresConnectRequest,
  ResourceDescriptor,
  TableConstraintDescriptor,
  TableFieldDescriptor,
  TableSnapshot,
} from '@querydock/contracts';

interface ResourceRow {
  schema: string;
  name: string;
  kind: ResourceDescriptor['kind'];
  isUpdatable: boolean;
}

interface FieldRow {
  ordinalPosition: number;
  name: string;
  typeSchema: string;
  typeName: string;
  dataType: string;
  characterMaximumLength: number | null;
  numericPrecision: number | null;
  numericScale: number | null;
  nullable: boolean;
  defaultExpression: string | null;
  identityGeneration: 'always' | 'byDefault' | null;
  generated: boolean;
  generationExpression: string | null;
}

interface ConstraintRow {
  name: string;
  constraintType: 'p' | 'u' | 'f' | 'c' | 'x';
  fieldNames: string[];
  definition: string;
  referencedSchema: string | null;
  referencedTable: string | null;
  referencedFieldNames: string[];
}

export interface VerifiedPostgresConnection {
  serverVersion: string;
}

export class PostgresConnectionError extends Error {
  constructor(
    message: string,
    readonly safeMessage: string,
  ) {
    super(message);
    this.name = 'PostgresConnectionError';
  }
}

export class PostgresAdapter {
  async verifyConnection(configuration: PostgresConnectRequest): Promise<VerifiedPostgresConnection> {
    return this.withClient(configuration, async (client) => {
      const result = await client.query<{ serverVersion: string }>(
        'SELECT current_setting(\'server_version\') AS "serverVersion"',
      );
      return { serverVersion: result.rows[0]?.serverVersion ?? 'unknown' };
    });
  }

  async listResources(configuration: PostgresConnectRequest): Promise<ResourceDescriptor[]> {
    return this.withClient(configuration, async (client) => {
      const result = await client.query<ResourceRow>(`
        SELECT
          namespace.nspname AS schema,
          relation.relname AS name,
          CASE relation.relkind
            WHEN 'r' THEN 'table'
            WHEN 'p' THEN 'partitionedTable'
            WHEN 'v' THEN 'view'
            WHEN 'm' THEN 'materializedView'
            WHEN 'f' THEN 'foreignTable'
          END AS kind,
          COALESCE(information_table.is_insertable_into = 'YES', false) AS "isUpdatable"
        FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        LEFT JOIN information_schema.tables AS information_table
          ON information_table.table_schema = namespace.nspname
          AND information_table.table_name = relation.relname
        WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND information_table.table_name IS NOT NULL
          AND namespace.nspname <> 'information_schema'
          AND namespace.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
        ORDER BY namespace.nspname, relation.relname
      `);

      return result.rows;
    });
  }

  async inspectTable(
    configuration: PostgresConnectRequest,
    schema: string,
    table: string,
  ): Promise<TableSnapshot | undefined> {
    return this.withClient(configuration, async (client) => {
      const resources = await client.query<ResourceRow>(`
        SELECT
          namespace.nspname AS schema,
          relation.relname AS name,
          CASE relation.relkind
            WHEN 'r' THEN 'table'
            WHEN 'p' THEN 'partitionedTable'
            WHEN 'v' THEN 'view'
            WHEN 'm' THEN 'materializedView'
            WHEN 'f' THEN 'foreignTable'
          END AS kind,
          COALESCE(information_table.is_insertable_into = 'YES', false) AS "isUpdatable"
        FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        LEFT JOIN information_schema.tables AS information_table
          ON information_table.table_schema = namespace.nspname
          AND information_table.table_name = relation.relname
        WHERE namespace.nspname = $1 AND relation.relname = $2
          AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND information_table.table_name IS NOT NULL
      `, [schema, table]);
      const resource = resources.rows[0];
      if (!resource) return undefined;

      const fieldResult = await client.query<FieldRow>(`
        SELECT
          columns.ordinal_position::int AS "ordinalPosition",
          columns.column_name AS name,
          columns.udt_schema AS "typeSchema",
          columns.udt_name AS "typeName",
          columns.data_type AS "dataType",
          columns.character_maximum_length AS "characterMaximumLength",
          columns.numeric_precision AS "numericPrecision",
          columns.numeric_scale AS "numericScale",
          (columns.is_nullable = 'YES') AS nullable,
          columns.column_default AS "defaultExpression",
          CASE columns.identity_generation
            WHEN 'ALWAYS' THEN 'always'
            WHEN 'BY DEFAULT' THEN 'byDefault'
            ELSE NULL
          END AS "identityGeneration",
          (columns.is_generated = 'ALWAYS') AS generated,
          columns.generation_expression AS "generationExpression"
        FROM information_schema.columns AS columns
        WHERE columns.table_schema = $1 AND columns.table_name = $2
        ORDER BY columns.ordinal_position
      `, [schema, table]);

      const constraintResult = await client.query<ConstraintRow>(`
        SELECT
          constraint_row.conname AS name,
          constraint_row.contype AS "constraintType",
          ARRAY(
            SELECT attribute.attname::text
            FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key_column(attnum, ordinal)
            JOIN pg_catalog.pg_attribute AS attribute
              ON attribute.attrelid = constraint_row.conrelid
              AND attribute.attnum = key_column.attnum
            ORDER BY key_column.ordinal
          ) AS "fieldNames",
          pg_catalog.pg_get_constraintdef(constraint_row.oid, true) AS definition,
          referenced_namespace.nspname AS "referencedSchema",
          referenced_relation.relname AS "referencedTable",
          ARRAY(
            SELECT referenced_attribute.attname::text
            FROM unnest(constraint_row.confkey) WITH ORDINALITY AS key_column(attnum, ordinal)
            JOIN pg_catalog.pg_attribute AS referenced_attribute
              ON referenced_attribute.attrelid = constraint_row.confrelid
              AND referenced_attribute.attnum = key_column.attnum
            ORDER BY key_column.ordinal
          ) AS "referencedFieldNames"
        FROM pg_catalog.pg_constraint AS constraint_row
        JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_row.conrelid
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        LEFT JOIN pg_catalog.pg_class AS referenced_relation
          ON referenced_relation.oid = constraint_row.confrelid
        LEFT JOIN pg_catalog.pg_namespace AS referenced_namespace
          ON referenced_namespace.oid = referenced_relation.relnamespace
        WHERE namespace.nspname = $1 AND relation.relname = $2
          AND constraint_row.contype IN ('p', 'u', 'f', 'c', 'x')
        ORDER BY constraint_row.conname
      `, [schema, table]);

      const fields: TableFieldDescriptor[] = fieldResult.rows;
      const constraints: TableConstraintDescriptor[] = constraintResult.rows.map((row) => ({
        name: row.name,
        kind: constraintKind(row.constraintType),
        fieldNames: row.fieldNames ?? [],
        definition: row.definition,
        referencedSchema: row.referencedSchema,
        referencedTable: row.referencedTable,
        referencedFieldNames: row.referencedFieldNames ?? [],
      }));
      const baseline = {
        schema: resource.schema,
        name: resource.name,
        kind: resource.kind,
        fields,
        constraints,
      };
      const fingerprint = createHash('sha256').update(JSON.stringify(baseline)).digest('hex');

      return { ...baseline, fingerprint };
    });
  }

  private async withClient<T>(
    configuration: PostgresConnectRequest,
    action: (client: Client) => Promise<T>,
  ): Promise<T> {
    const client = new Client({
      host: configuration.host,
      port: configuration.port,
      database: configuration.database,
      user: configuration.username,
      password: configuration.password,
      connectionTimeoutMillis: 8000,
      ssl: configuration.sslMode === 'disable'
        ? false
        : { rejectUnauthorized: configuration.sslMode === 'verify-full' },
      application_name: 'QueryDock',
    });

    try {
      await client.connect();
      return await action(client);
    } catch (error) {
      throw new PostgresConnectionError(
        error instanceof Error ? error.message : 'Unknown PostgreSQL error',
        safeDatabaseMessage(error),
      );
    } finally {
      await client.end().catch(() => undefined);
    }
  }
}

function constraintKind(
  kind: ConstraintRow['constraintType'],
): TableConstraintDescriptor['kind'] {
  switch (kind) {
    case 'p': return 'primaryKey';
    case 'u': return 'unique';
    case 'f': return 'foreignKey';
    case 'c': return 'check';
    case 'x': return 'exclusion';
  }
}

function safeDatabaseMessage(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : '';
  if (code === '28P01' || code === '28000') return 'PostgreSQL authentication failed. Check the username and password.';
  if (code === '3D000') return 'The PostgreSQL database was not found. Check the database name.';
  if (code === '42501') return 'The PostgreSQL user does not have permission to inspect this resource.';
  if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) {
    return 'Could not reach PostgreSQL. Check the host, port, and server availability.';
  }
  return 'The PostgreSQL request failed. Check the connection settings and database permissions.';
}
