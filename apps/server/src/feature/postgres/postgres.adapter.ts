import { createHash } from 'node:crypto';
import { Client } from 'pg';
import type {
  MigrationApplyRequest,
  MigrationApplyResponse,
  MigrationPreviewRequest,
  MigrationPreviewResponse,
  SchemaFieldDraftRequest,
  SchemaFieldDraftResponse,
  SchemaOperation,
  NullableFieldType,
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

const POSTGRES_EDITABLE_FIELD_TYPES = [
  { value: 'text', label: 'Text', typeSchema: 'pg_catalog', typeName: 'text' },
  { value: 'varchar', label: 'Varchar', typeSchema: 'pg_catalog', typeName: 'varchar' },
  { value: 'integer', label: 'Integer', typeSchema: 'pg_catalog', typeName: 'int4' },
  { value: 'bigint', label: 'Big integer', typeSchema: 'pg_catalog', typeName: 'int8' },
  { value: 'numeric', label: 'Numeric', typeSchema: 'pg_catalog', typeName: 'numeric' },
  { value: 'boolean', label: 'Boolean', typeSchema: 'pg_catalog', typeName: 'bool' },
  { value: 'uuid', label: 'UUID', typeSchema: 'pg_catalog', typeName: 'uuid' },
  { value: 'date', label: 'Date', typeSchema: 'pg_catalog', typeName: 'date' },
  { value: 'timestamptz', label: 'Timestamp with time zone', typeSchema: 'pg_catalog', typeName: 'timestamptz' },
  { value: 'jsonb', label: 'JSON', typeSchema: 'pg_catalog', typeName: 'jsonb' },
] as const;

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
    validatePostgresIdentifier(schema, 'schema');
    validatePostgresIdentifier(table, 'table');
    return this.withClient(configuration, (client) => this.inspectTableWithClient(client, schema, table));
  }

  async previewMigration(
    configuration: PostgresConnectRequest,
    request: MigrationPreviewRequest,
  ): Promise<MigrationPreviewResponse> {
    validatePostgresIdentifier(request.schema, 'schema');
    validatePostgresIdentifier(request.table, 'table');
    return this.withClient(configuration, async (client) => {
      const snapshot = await this.inspectTableWithClient(client, request.schema, request.table);
      if (!snapshot) throw new MigrationPlanError('not-found', 'The requested table was not found or is not visible.');
      if (snapshot.fingerprint !== request.baselineFingerprint) {
        throw new MigrationPlanError('drift', 'The table changed since it was loaded. Refresh the schema before drafting a migration.');
      }
      const preview = createMigrationPreview(snapshot, request);
      const warnings = collectMigrationWarnings(snapshot, request.operations);
      return { baselineFingerprint: snapshot.fingerprint, statements: preview, warnings };
    });
  }

  async applyMigration(
    configuration: PostgresConnectRequest,
    request: MigrationApplyRequest,
  ): Promise<MigrationApplyResponse> {
    validatePostgresIdentifier(request.schema, 'schema');
    validatePostgresIdentifier(request.table, 'table');
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
        const warnings = collectMigrationWarnings(snapshot, request.operations);
        if (!sameStatements(warnings, request.acknowledgedWarnings)) {
          throw new MigrationPlanError('review-mismatch', 'Review and acknowledge the current migration warnings before applying.');
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

    const fields: TableFieldDescriptor[] = fieldResult.rows.map((field) => {
      const editableType = fieldTypeFor(field.dataType);
      return {
        ...field,
        editableType,
        editable: resource.canAlter && editableType !== null && !field.generated && !field.identityGeneration,
      };
    });
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

    return {
      ...baseline,
      editableFieldTypes: [...POSTGRES_EDITABLE_FIELD_TYPES],
      fields,
      canAlter: resource.canAlter,
      fingerprint,
    };
  }

  async previewSchemaFieldDraft(
    configuration: PostgresConnectRequest,
    request: SchemaFieldDraftRequest,
  ): Promise<SchemaFieldDraftResponse> {
    validatePostgresIdentifier(request.schema, 'schema');
    validatePostgresIdentifier(request.table, 'table');
    return this.withClient(configuration, async (client) => {
      const snapshot = await this.inspectTableWithClient(client, request.schema, request.table);
      if (!snapshot) throw new MigrationPlanError('not-found', 'The requested table was not found or is not visible.');
      if (snapshot.fingerprint !== request.baselineFingerprint) {
        throw new MigrationPlanError('drift', 'The table changed since it was loaded. Refresh the schema before drafting a migration.');
      }
      const draftOperation = normalizeFieldDraft(snapshot, request.draft);
      const operations = draftOperation ? [...request.operations, draftOperation] : request.operations;
      const plan: MigrationPreviewRequest = {
        schema: request.schema,
        table: request.table,
        baselineFingerprint: request.baselineFingerprint,
        operations,
      };
      const statements = operations.length ? createMigrationPreview(snapshot, plan) : [];
      const warnings = operations.length ? collectMigrationWarnings(snapshot, operations) : [];
      return { baselineFingerprint: snapshot.fingerprint, statements, warnings, operations };
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

function fieldTypeFor(dataType: string): string | null {
  if (dataType === 'character varying') return 'varchar';
  if (dataType === 'timestamp with time zone') return 'timestamptz';
  return POSTGRES_EDITABLE_FIELD_TYPES.find((type) => type.value === dataType)?.value ?? null;
}

function normalizeFieldDraft(
  snapshot: TableSnapshot,
  draft: SchemaFieldDraftRequest['draft'],
): SchemaOperation | null {
  const name = draft.name.trim();
  if (!name) throw new MigrationPlanError('invalid', 'Enter a field name.');
  validateFieldName(name);
  const selectedType = POSTGRES_EDITABLE_FIELD_TYPES.find(({ value }) => value === draft.type);
  if (!selectedType) {
    throw new MigrationPlanError('invalid', 'Choose a field type supported by the connected database.');
  }
  const type = selectedType.value as NullableFieldType;
  const typeDetails = draft.typeDetails.trim();
  let characterMaximumLength: number | null = null;
  let numericPrecision: number | null = null;
  let numericScale: number | null = null;
  if (typeDetails && type === 'varchar') {
    if (!/^\d+$/.test(typeDetails)) {
      throw new MigrationPlanError('invalid', 'For Varchar, enter a positive maximum length, such as 255.');
    }
    characterMaximumLength = Number(typeDetails);
    if (characterMaximumLength < 1 || characterMaximumLength > 10_485_760) {
      throw new MigrationPlanError('invalid', 'Varchar length must be between 1 and 10,485,760 characters.');
    }
  } else if (typeDetails && type === 'numeric') {
    const match = /^(\d+)(?:\s*,\s*(-?\d+))?$/.exec(typeDetails);
    if (!match) throw new MigrationPlanError('invalid', 'For Numeric, enter precision and optional scale, such as 12, 2.');
    numericPrecision = Number(match[1]);
    numericScale = match[2] === undefined ? 0 : Number(match[2]);
    if (numericPrecision < 1 || numericPrecision > 1000 || numericScale < -1000 || numericScale > 1000) {
      throw new MigrationPlanError('invalid', 'Numeric precision must be 1–1000 and scale must be -1000–1000.');
    }
  } else if (typeDetails) {
    const typeLabel = selectedType.label;
    const explanation = type === 'text'
      ? 'PostgreSQL text fields are unbounded and do not have a maximum size. Leave Size / precision blank, or choose Varchar and enter a length, such as 255.'
      : `PostgreSQL ${typeLabel} fields do not accept size or precision parameters. Leave Size / precision blank.`;
    throw new MigrationPlanError('invalid', explanation);
  }

  const defaultValue = draft.defaultValue.trim();
  const defaultExpression = defaultValue && defaultValue !== '—'
    ? validateDefaultExpression(defaultValue)
    : null;
  if (draft.sourceName === null) {
    return { kind: 'addNullableField', name, type, typeDetails, characterMaximumLength, numericPrecision, numericScale, defaultExpression };
  }

  const field = snapshot.fields.find(({ name: fieldName }) => fieldName === draft.sourceName);
  if (!field) throw new MigrationPlanError('invalid', `The field "${draft.sourceName}" no longer exists.`);
  if (field.generated || field.identityGeneration) {
    throw new MigrationPlanError('invalid', `Generated field "${draft.sourceName}" cannot be edited by this migration.`);
  }
  const currentDefault = field.defaultExpression?.trim() ?? null;
  if (name === field.name && fieldTypeFor(field.dataType) === type
    && field.characterMaximumLength === characterMaximumLength
    && field.numericPrecision === numericPrecision && field.numericScale === numericScale
    && currentDefault === defaultExpression) return null;
  return {
    kind: 'alterField', name: draft.sourceName, newName: name, type, typeDetails,
    characterMaximumLength, numericPrecision, numericScale, defaultExpression,
  };
}

function createMigrationPreview(snapshot: TableSnapshot, request: MigrationPreviewRequest): string[] {
  if (snapshot.kind !== 'table' && snapshot.kind !== 'partitionedTable') {
    throw new MigrationPlanError('invalid', 'Only PostgreSQL tables can receive a new nullable field.');
  }

  const table = `${quoteIdentifier(snapshot.schema)}.${quoteIdentifier(snapshot.name)}`;
  const currentNames = new Set(snapshot.fields.map(({ name }) => name));
  const finalNames = new Map<string, string>();
  const operationSources = new Set<string>();
  for (const operation of request.operations) {
    if (operation.kind === 'addNullableField') {
      validateFieldName(operation.name);
      if (operationSources.has(operation.name)) {
        throw new MigrationPlanError('invalid', `A field operation for "${operation.name}" appears more than once.`);
      }
      operationSources.add(operation.name);
      if (currentNames.has(operation.name) || [...finalNames.values()].includes(operation.name)) {
        throw new MigrationPlanError('invalid', `A field named "${operation.name}" already exists or is already in this plan.`);
      }
      finalNames.set(operation.name, operation.name);
    } else {
      validateFieldName(operation.newName);
      if (operationSources.has(operation.name)) {
        throw new MigrationPlanError('invalid', `A field operation for "${operation.name}" appears more than once.`);
      }
      operationSources.add(operation.name);
      if (!currentNames.has(operation.name)) {
        throw new MigrationPlanError('invalid', `The field "${operation.name}" no longer exists.`);
      }
      const targetName = operation.newName;
      const collision = snapshot.fields.some(({ name }) => name === targetName && name !== operation.name)
        || [...finalNames.values()].includes(targetName);
      if (collision) throw new MigrationPlanError('invalid', `A field named "${targetName}" already exists or is already in this plan.`);
      finalNames.set(operation.name, targetName);
    }
  }

  return request.operations.flatMap((operation) => {
    if (operation.kind === 'addNullableField') {
      const typeSql = formatFieldType(operation);
      const defaultSql = operation.defaultExpression ? ` DEFAULT ${validateDefaultExpression(operation.defaultExpression)}` : '';
      return [`ALTER TABLE ${table} ADD COLUMN ${quoteIdentifier(operation.name)} ${typeSql}${defaultSql};`];
    }
    return statementsForAlterField(table, snapshot, operation);
  });
}

function statementsForAlterField(
  table: string,
  snapshot: TableSnapshot,
  operation: Extract<SchemaOperation, { kind: 'alterField' }>,
): string[] {
  const field = snapshot.fields.find(({ name }) => name === operation.name);
  if (!field) throw new MigrationPlanError('invalid', `The field "${operation.name}" no longer exists.`);
  if (field.generated || field.identityGeneration) {
    throw new MigrationPlanError('invalid', `Generated field "${operation.name}" cannot be edited by this migration.`);
  }

  const statements: string[] = [];
  const oldName = quoteIdentifier(operation.name);
  const finalName = quoteIdentifier(operation.newName);
  if (operation.newName !== operation.name) {
    statements.push(`ALTER TABLE ${table} RENAME COLUMN ${oldName} TO ${finalName};`);
  }

  const targetType = formatFieldType(operation);
  const typeChanged = !sameFieldType(field, operation);
  const currentDefault = field.defaultExpression?.trim() ?? null;
  const nextDefault = operation.defaultExpression?.trim() ?? null;
  if (typeChanged && currentDefault !== null) {
    statements.push(`ALTER TABLE ${table} ALTER COLUMN ${finalName} DROP DEFAULT;`);
  }
  if (typeChanged) {
    statements.push(`ALTER TABLE ${table} ALTER COLUMN ${finalName} TYPE ${targetType};`);
  }

  const defaultChanged = currentDefault !== nextDefault;
  if (typeChanged) {
    if (nextDefault !== null) {
      statements.push(`ALTER TABLE ${table} ALTER COLUMN ${finalName} SET DEFAULT ${validateDefaultExpression(nextDefault)};`);
    }
  } else if (defaultChanged) {
    statements.push(nextDefault === null
      ? `ALTER TABLE ${table} ALTER COLUMN ${finalName} DROP DEFAULT;`
      : `ALTER TABLE ${table} ALTER COLUMN ${finalName} SET DEFAULT ${validateDefaultExpression(nextDefault)};`);
  }
  return statements;
}

function sameFieldType(
  field: TableFieldDescriptor,
  operation: Extract<SchemaOperation, { kind: 'alterField' }>,
): boolean {
  const existingType = normalizeFieldType(field.dataType);
  return existingType === operation.type
    && field.characterMaximumLength === operation.characterMaximumLength
    && field.numericPrecision === operation.numericPrecision
    && field.numericScale === operation.numericScale;
}

function normalizeFieldType(dataType: string): string {
  if (dataType === 'character varying') return 'varchar';
  if (dataType === 'timestamp with time zone') return 'timestamptz';
  if (dataType === 'bigint') return 'bigint';
  if (dataType === 'integer') return 'integer';
  return dataType;
}

function formatFieldType(operation: Pick<SchemaOperation, 'type'> & {
  characterMaximumLength?: number | null;
  numericPrecision?: number | null;
  numericScale?: number | null;
}): string {
  if (operation.type === 'varchar') {
    if (operation.characterMaximumLength != null
      && (!Number.isInteger(operation.characterMaximumLength) || operation.characterMaximumLength < 1 || operation.characterMaximumLength > 10_485_760)) {
      throw new MigrationPlanError('invalid', 'Varchar length must be a whole number between 1 and 10,485,760 characters.');
    }
    return operation.characterMaximumLength ? `character varying(${operation.characterMaximumLength})` : 'character varying';
  }
  if (operation.type === 'numeric') {
    if ((operation.numericScale !== null && operation.numericScale !== undefined)
      && (operation.numericPrecision === null || operation.numericPrecision === undefined)) {
      throw new MigrationPlanError('invalid', 'Numeric scale requires a precision.');
    }
    if (operation.numericPrecision != null
      && (!Number.isInteger(operation.numericPrecision) || operation.numericPrecision < 1 || operation.numericPrecision > 1000)) {
      throw new MigrationPlanError('invalid', 'Numeric precision must be a whole number from 1 to 1000.');
    }
    if (operation.numericScale != null
      && (!Number.isInteger(operation.numericScale) || operation.numericScale < -1000 || operation.numericScale > 1000)) {
      throw new MigrationPlanError('invalid', 'Numeric scale must be a whole number from -1000 to 1000.');
    }
    if (operation.numericPrecision === null || operation.numericPrecision === undefined) return 'numeric';
    const scale = operation.numericScale ?? 0;
    return `numeric(${operation.numericPrecision}, ${scale})`;
  }
  if (operation.characterMaximumLength != null || operation.numericPrecision != null || operation.numericScale != null) {
    const typeLabel = operation.type === 'timestamptz' ? 'timestamp with time zone' : operation.type;
    const explanation = operation.type === 'text'
      ? 'PostgreSQL text fields are unbounded and do not accept a maximum size. Leave Size / precision blank, or use Varchar and enter a length such as 255.'
      : `PostgreSQL ${typeLabel} fields do not accept size or precision parameters. Leave them blank; Varchar accepts a length, and Numeric accepts precision and scale.`;
    throw new MigrationPlanError('invalid', explanation);
  }
  const typeSql = {
    text: 'text', integer: 'integer', bigint: 'bigint', boolean: 'boolean', uuid: 'uuid',
    date: 'date', timestamptz: 'timestamp with time zone', jsonb: 'jsonb',
  } as const;
  const sqlType = typeSql[operation.type as keyof typeof typeSql];
  if (!sqlType) throw new MigrationPlanError('invalid', `The connected database does not support the field type "${operation.type}".`);
  return sqlType;
}

function collectMigrationWarnings(snapshot: TableSnapshot, operations: SchemaOperation[]): string[] {
  const warnings: string[] = [];
  for (const operation of operations) {
    if (operation.kind === 'addNullableField' && operation.defaultExpression) {
      warnings.push(`Adding "${operation.name}" with a default may populate existing rows. Review the expression and resulting SQL.`);
    }
    if (operation.kind === 'alterField') {
      const field = snapshot.fields.find(({ name }) => name === operation.name);
      if (field && !sameFieldType(field, operation)) {
        warnings.push(`Changing the type of "${operation.name}" may fail or transform existing values. Review the conversion before applying.`);
      }
    }
  }
  return warnings;
}

function validateFieldName(name: string): void {
  validatePostgresIdentifier(name, 'field');
}

function validatePostgresIdentifier(name: string, kind: 'schema' | 'table' | 'field'): void {
  if (!name.trim() || name.includes('\0') || Buffer.byteLength(name, 'utf8') > 63) {
    throw new MigrationPlanError('invalid', `Enter a non-empty PostgreSQL ${kind} name that fits within 63 bytes.`);
  }
}

function validateDefaultExpression(expression: string): string {
  const trimmed = expression.trim();
  if (!trimmed || trimmed.length > 2048 || /[;\u0000]|--|\/\*/.test(trimmed)) {
    throw new MigrationPlanError('invalid', 'Enter a single SQL default expression without statement separators or comments.');
  }
  return trimmed;
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
