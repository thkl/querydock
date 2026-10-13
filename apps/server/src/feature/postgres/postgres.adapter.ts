import { createHash } from 'node:crypto';
import { Client } from 'pg';
import type {
  MigrationApplyRequest,
  MigrationApplyResponse,
  MigrationPreviewRequest,
  MigrationPreviewResponse,
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

interface InspectedResourceRow extends ResourceRow {
  canAlter: boolean;
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

export class MigrationPlanError extends Error {
  constructor(
    readonly kind: 'not-found' | 'drift' | 'review-mismatch' | 'invalid' | 'unknown',
    message: string,
  ) {
    super(message);
    this.name = 'MigrationPlanError';
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
    return this.withClient(configuration, (client) => this.inspectTableWithClient(client, schema, table));
  }

  async previewMigration(
    configuration: PostgresConnectRequest,
    request: MigrationPreviewRequest,
  ): Promise<MigrationPreviewResponse> {
    return this.withClient(configuration, async (client) => {
      const snapshot = await this.inspectTableWithClient(client, request.schema, request.table);
      if (!snapshot) throw new MigrationPlanError('not-found', 'The requested table was not found or is not visible.');
      if (snapshot.fingerprint !== request.baselineFingerprint) {
        throw new MigrationPlanError('drift', 'The table changed since it was loaded. Refresh the schema before drafting a migration.');
      }
      const preview = createMigrationPreview(snapshot, request);
      return { baselineFingerprint: snapshot.fingerprint, statements: preview, warnings: [] };
    });
  }

  async applyMigration(
    configuration: PostgresConnectRequest,
    request: MigrationApplyRequest,
  ): Promise<MigrationApplyResponse> {
    return this.withClient(configuration, async (client) => {
      await client.query('BEGIN');
      let commitStarted = false;
      try {
        await client.query(`LOCK TABLE ${quoteIdentifier(request.schema)}.${quoteIdentifier(request.table)} IN ACCESS EXCLUSIVE MODE`);
        const snapshot = await this.inspectTableWithClient(client, request.schema, request.table);
        if (!snapshot) throw new MigrationPlanError('not-found', 'The requested table was not found or is not visible.');
        if (snapshot.fingerprint !== request.baselineFingerprint) {
          throw new MigrationPlanError('drift', 'The table changed since this preview was generated. Refresh the schema and review the draft again.');
        }

        const statements = createMigrationPreview(snapshot, request);
        if (!sameStatements(statements, request.reviewedStatements)) {
          throw new MigrationPlanError('review-mismatch', 'The reviewed SQL no longer matches this migration plan. Generate a new preview before applying.');
        }

        for (const statement of statements) await client.query(statement);
        const updatedSnapshot = await this.inspectTableWithClient(client, request.schema, request.table);
        if (!updatedSnapshot) throw new MigrationPlanError('unknown', 'The migration ran, but the resulting schema could not be confirmed.');
        commitStarted = true;
        const commitResult = await client.query('COMMIT');
        if (commitResult.command !== 'COMMIT') {
          throw new MigrationPlanError('unknown', 'The server could not confirm that the migration transaction committed.');
        }
        return { appliedStatements: statements, snapshot: updatedSnapshot };
      } catch (error) {
        let rollbackConfirmed = false;
        try {
          await client.query('ROLLBACK');
          rollbackConfirmed = true;
        } catch {
          // A lost database connection can leave the transaction outcome uncertain.
        }
        if (error instanceof MigrationPlanError) throw error;
        if (commitStarted || !rollbackConfirmed) {
          throw new MigrationPlanError('unknown', 'The transaction outcome could not be confirmed. Inspect the database before retrying.');
        }
        throw new MigrationPlanError('invalid', safeDatabaseMessage(error));
      }
    });
  }

  private async inspectTableWithClient(
    client: Client,
    schema: string,
    table: string,
  ): Promise<TableSnapshot | undefined> {
    const resources = await client.query<InspectedResourceRow>(`
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
        (relation.relkind IN ('r', 'p')
          AND pg_catalog.pg_has_role(current_user, relation.relowner, 'USAGE')
          AND pg_catalog.has_schema_privilege(current_user, namespace.oid, 'USAGE')) AS "canAlter",
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

    return { ...baseline, canAlter: resource.canAlter, fingerprint };
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
      if (error instanceof MigrationPlanError) throw error;
      throw new PostgresConnectionError(
        error instanceof Error ? error.message : 'Unknown PostgreSQL error',
        safeDatabaseMessage(error),
      );
    } finally {
      await client.end().catch(() => undefined);
    }
  }
}

function createMigrationPreview(snapshot: TableSnapshot, request: MigrationPreviewRequest): string[] {
  if (snapshot.kind !== 'table' && snapshot.kind !== 'partitionedTable') {
    throw new MigrationPlanError('invalid', 'Only PostgreSQL tables can receive a new nullable field.');
  }

  const typeSql = {
    text: 'text',
    integer: 'integer',
    bigint: 'bigint',
    boolean: 'boolean',
    uuid: 'uuid',
    date: 'date',
    timestamptz: 'timestamp with time zone',
    jsonb: 'jsonb',
    numeric: 'numeric',
  } as const;
  const existingNames = new Set(snapshot.fields.map(({ name }) => name));
  const plannedNames = new Set<string>();

  return request.operations.map((operation) => {
    if (Buffer.byteLength(operation.name, 'utf8') > 63) {
      throw new MigrationPlanError('invalid', 'PostgreSQL field names must fit within 63 bytes.');
    }
    if (existingNames.has(operation.name) || plannedNames.has(operation.name)) {
      throw new MigrationPlanError('invalid', `A field named "${operation.name}" already exists or is already in this plan.`);
    }
    plannedNames.add(operation.name);
    return `ALTER TABLE ${quoteIdentifier(snapshot.schema)}.${quoteIdentifier(snapshot.name)} ADD COLUMN ${quoteIdentifier(operation.name)} ${typeSql[operation.type]};`;
  });
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function sameStatements(expected: string[], reviewed: string[]): boolean {
  return expected.length === reviewed.length && expected.every((statement, index) => statement === reviewed[index]);
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
