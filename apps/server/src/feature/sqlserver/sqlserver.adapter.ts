import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import sql from 'mssql';
import type {
  DataRunbookPreviewResponse,
  DatabasePermissionReport,
  MigrationApplyRequest,
  MigrationApplyResponse,
  MigrationPreviewRequest,
  MigrationPreviewResponse,
  ResourceDescriptor,
  SchemaCapabilities,
  SqlServerConnectRequest,
  TableConstraintDescriptor,
  TableDataQueryRequest,
  TableDataQueryResponse,
  TableDataRowDelete,
  TableDataRowInsert,
  TableDataRowUpdate,
  TableFieldDescriptor,
  TableSnapshot,
} from '@querydock/contracts';
import { MigrationPlanError } from '../database/database-errors.js';

interface SqlColumn {
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

interface SqlKeyColumn {
  constraintName: string;
  constraintType: string;
  fieldName: string | null;
  keyOrdinal: number | null;
  referencedSchema: string | null;
  referencedTable: string | null;
  referencedFieldName: string | null;
  definition: string | null;
}

type SqlDataRow = Record<string, string | null>;
type SqlDataOperation = Extract<MigrationApplyRequest['operations'][number], { kind: 'updateDataRow' | 'insertDataRow' | 'deleteDataRow' }>;

/** Implements SQL Server discovery, schema inspection, bounded reads, and guarded data writes. */
export class SqlServerAdapter {
  private readonly logger = new Logger(SqlServerAdapter.name);

  /** SQL Server currently exposes data workflows; schema editing is explicitly capability-gated. */
  schemaCapabilities(): SchemaCapabilities {
    return { createTableIfNotExists: false };
  }

  /** SQL Server schema editing is not enabled yet, so no editable type presets are advertised. */
  editableFieldTypes(): [] {
    return [];
  }

  /** Opens a short-lived connection and verifies the server/database pair. */
  async verifyConnection(configuration: SqlServerConnectRequest): Promise<{ serverVersion: string }> {
    return this.withPool(configuration, async (pool) => {
      const result = await pool.request().query<{ serverVersion: string }>(
        "SELECT CONVERT(nvarchar(256), SERVERPROPERTY('ProductVersion')) AS serverVersion",
      );
      return { serverVersion: result.recordset[0]?.serverVersion ?? 'unknown' };
    });
  }

  /** Reports effective SQL Server database, schema, and object permissions for the active principal. */
  async inspectPermissions(configuration: SqlServerConnectRequest): Promise<DatabasePermissionReport> {
    return this.withPool(configuration, async (pool) => {
      const identityResult = await pool.request().query<{
        database: string; currentUser: string; serverUser: string | null;
      }>(`
        SELECT DB_NAME() AS [database], USER_NAME() AS currentUser, SUSER_SNAME() AS serverUser;
      `);
      const identity = identityResult.recordset[0];
      if (!identity) throw new MigrationPlanError('unknown', 'SQL Server did not return the active database identity.');

      const databaseResult = await pool.request().query<{
        canConnect: boolean; canCreateTable: boolean; canCreateView: boolean;
        canCreateSchema: boolean; canAlterAnySchema: boolean; canViewDefinition: boolean; canControl: boolean;
      }>(`
        SELECT CONVERT(bit, COALESCE(HAS_DBACCESS(DB_NAME()), 0)) AS canConnect,
          CONVERT(bit, COALESCE(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CREATE TABLE'), 0)) AS canCreateTable,
          CONVERT(bit, COALESCE(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CREATE VIEW'), 0)) AS canCreateView,
          CONVERT(bit, COALESCE(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CREATE SCHEMA'), 0)) AS canCreateSchema,
          CONVERT(bit, COALESCE(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'ALTER ANY SCHEMA'), 0)) AS canAlterAnySchema,
          CONVERT(bit, COALESCE(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'VIEW DEFINITION'), 0)) AS canViewDefinition,
          CONVERT(bit, COALESCE(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CONTROL'), 0)) AS canControl;
      `);
      const schemaResult = await pool.request().query<{
        schema: string; canSelect: boolean; canInsert: boolean; canUpdate: boolean;
        canDelete: boolean; canExecute: boolean; canAlter: boolean; canControl: boolean;
      }>(`
        SELECT name AS [schema],
          CONVERT(bit, COALESCE(HAS_PERMS_BY_NAME(QUOTENAME(name), 'SCHEMA', 'SELECT'), 0)) AS canSelect,
          CONVERT(bit, COALESCE(HAS_PERMS_BY_NAME(QUOTENAME(name), 'SCHEMA', 'INSERT'), 0)) AS canInsert,
          CONVERT(bit, COALESCE(HAS_PERMS_BY_NAME(QUOTENAME(name), 'SCHEMA', 'UPDATE'), 0)) AS canUpdate,
          CONVERT(bit, COALESCE(HAS_PERMS_BY_NAME(QUOTENAME(name), 'SCHEMA', 'DELETE'), 0)) AS canDelete,
          CONVERT(bit, COALESCE(HAS_PERMS_BY_NAME(QUOTENAME(name), 'SCHEMA', 'EXECUTE'), 0)) AS canExecute,
          CONVERT(bit, COALESCE(HAS_PERMS_BY_NAME(QUOTENAME(name), 'SCHEMA', 'ALTER'), 0)) AS canAlter,
          CONVERT(bit, COALESCE(HAS_PERMS_BY_NAME(QUOTENAME(name), 'SCHEMA', 'CONTROL'), 0)) AS canControl
        FROM sys.schemas
        WHERE name NOT IN ('sys', 'INFORMATION_SCHEMA')
        ORDER BY name;
      `);
      const objectResult = await pool.request().query<{
        schema: string; name: string; kind: 'table' | 'view';
        canSelect: boolean; canInsert: boolean; canUpdate: boolean; canDelete: boolean;
        canAlter: boolean; canViewDefinition: boolean; canControl: boolean;
      }>(`
        SELECT s.name AS [schema], o.name,
          CASE WHEN o.type = 'V' THEN 'view' ELSE 'table' END AS kind,
          CONVERT(bit, COALESCE(HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(o.name), 'OBJECT', 'SELECT'), 0)) AS canSelect,
          CONVERT(bit, COALESCE(HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(o.name), 'OBJECT', 'INSERT'), 0)) AS canInsert,
          CONVERT(bit, COALESCE(HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(o.name), 'OBJECT', 'UPDATE'), 0)) AS canUpdate,
          CONVERT(bit, COALESCE(HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(o.name), 'OBJECT', 'DELETE'), 0)) AS canDelete,
          CONVERT(bit, COALESCE(HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(o.name), 'OBJECT', 'ALTER'), 0)) AS canAlter,
          CONVERT(bit, COALESCE(HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(o.name), 'OBJECT', 'VIEW DEFINITION'), 0)) AS canViewDefinition,
          CONVERT(bit, COALESCE(HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(o.name), 'OBJECT', 'CONTROL'), 0)) AS canControl
        FROM sys.objects o
        JOIN sys.schemas s ON s.schema_id = o.schema_id
        WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0
        ORDER BY s.name, o.name;
      `);
      const database = databaseResult.recordset[0];
      return {
        adapter: 'sqlserver',
        database: identity.database,
        currentUser: identity.currentUser,
        serverUser: identity.serverUser,
        databasePrivileges: [
          { name: 'CONNECT', granted: Boolean(database?.canConnect) },
          { name: 'CREATE TABLE', granted: Boolean(database?.canCreateTable) },
          { name: 'CREATE VIEW', granted: Boolean(database?.canCreateView) },
          { name: 'CREATE SCHEMA', granted: Boolean(database?.canCreateSchema) },
          { name: 'ALTER ANY SCHEMA', granted: Boolean(database?.canAlterAnySchema) },
          { name: 'VIEW DEFINITION', granted: Boolean(database?.canViewDefinition) },
          { name: 'CONTROL', granted: Boolean(database?.canControl) },
        ],
        schemas: schemaResult.recordset.map((schema) => ({
          name: schema.schema,
          privileges: [
            { name: 'SELECT', granted: schema.canSelect },
            { name: 'INSERT', granted: schema.canInsert },
            { name: 'UPDATE', granted: schema.canUpdate },
            { name: 'DELETE', granted: schema.canDelete },
            { name: 'EXECUTE', granted: schema.canExecute },
            { name: 'ALTER', granted: schema.canAlter },
            { name: 'CONTROL', granted: schema.canControl },
          ],
          objects: objectResult.recordset.filter((object) => object.schema === schema.schema).map((object) => ({
            name: object.name,
            kind: object.kind,
            privileges: [
              { name: 'SELECT', granted: object.canSelect },
              { name: 'INSERT', granted: object.canInsert },
              { name: 'UPDATE', granted: object.canUpdate },
              { name: 'DELETE', granted: object.canDelete },
              { name: 'ALTER', granted: object.canAlter },
              { name: 'VIEW DEFINITION', granted: object.canViewDefinition },
              { name: 'CONTROL', granted: object.canControl },
            ],
          })),
        })),
      };
    });
  }

  /** Lists user tables and views visible in the selected SQL Server database. */
  async listResources(configuration: SqlServerConnectRequest): Promise<ResourceDescriptor[]> {
    return this.withPool(configuration, async (pool) => {
      const result = await pool.request().query<{
        schema: string; name: string; kind: 'table' | 'view'; isUpdatable: boolean;
      }>(`
        SELECT s.name AS [schema], o.name AS name,
          CASE WHEN o.type = 'V' THEN 'view' ELSE 'table' END AS kind,
          CONVERT(bit, CASE WHEN o.type = 'U' AND
            (HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(o.name), 'OBJECT', 'UPDATE') = 1
             OR HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(o.name), 'OBJECT', 'INSERT') = 1
             OR HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(o.name), 'OBJECT', 'DELETE') = 1)
            THEN 1 ELSE 0 END) AS isUpdatable
        FROM sys.objects o
        JOIN sys.schemas s ON s.schema_id = o.schema_id
        WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0
          AND HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(o.name), 'OBJECT', 'SELECT') = 1
        ORDER BY s.name, o.name;
      `);
      return result.recordset.map((row) => ({ ...row, canCreateTable: false }));
    });
  }

  /** Inspects a SQL Server table/view and returns the shared schema descriptor. */
  async inspectTable(configuration: SqlServerConnectRequest, schema: string, table: string): Promise<TableSnapshot | undefined> {
    validateIdentifier(schema, 'schema');
    validateIdentifier(table, 'table');
    return this.withPool(configuration, (pool) => this.inspectWithPool(pool, schema, table));
  }

  /** Returns a bounded page using parameterized filters and stable ordering. */
  async queryTableData(
    configuration: SqlServerConnectRequest,
    schema: string,
    table: string,
    query: TableDataQueryRequest,
  ): Promise<TableDataQueryResponse> {
    validateIdentifier(schema, 'schema');
    validateIdentifier(table, 'table');
    return this.withPool(configuration, async (pool) => {
      const snapshot = await this.inspectWithPool(pool, schema, table);
      if (!snapshot) throw new MigrationPlanError('not-found', 'The requested table was not found or is not visible to this user.');
      for (const sort of query.sort) if (!snapshot.fields.some(({ name }) => name === sort.field)) {
        throw new MigrationPlanError('invalid', `The sort field "${sort.field}" is not part of this table. Refresh the table and try again.`);
      }
      for (const filter of query.filters) if (!snapshot.fields.some(({ name }) => name === filter.field)) {
        throw new MigrationPlanError('invalid', `The filter field "${filter.field}" is not part of this table. Refresh the table and try again.`);
      }

      const keyFields = snapshot.constraints.find(({ kind }) => kind === 'primaryKey')?.fieldNames ?? [];
      const resource = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
      const predicates: string[] = [];
      const request = pool.request();
      this.addFilters(request, snapshot.fields, query, predicates);
      const quick = query.quickFilter.trim();
      if (quick) {
        request.input('quick', sql.NVarChar(sql.MAX), `%${escapeLike(quick)}%`);
        predicates.push(`(${snapshot.fields.map(({ name, typeName }) => `${displayValueSql(name, typeName)} LIKE @quick ESCAPE N'!'`).join(' OR ')})`);
      }
      const where = predicates.length ? ` WHERE ${predicates.join(' AND ')}` : '';
      const countResult = await request.query<{ total: string }>(`SELECT COUNT_BIG(*) AS total FROM ${resource}${where};`);
      const totalRows = Number(countResult.recordset[0]?.total ?? 0);
      if (!Number.isSafeInteger(totalRows)) throw new MigrationPlanError('invalid', 'This table has too many rows to browse safely in the current grid.');

      const order = buildOrder(snapshot, query.sort);
      const rowValueSelect = snapshot.fields.map(({ name, dataType }) =>
        `${displayValueSql(name, dataType)} AS ${quoteIdentifier(name)}`).join(', ');
      const pageRequest = pool.request().input('offset', sql.Int, query.offset).input('limit', sql.Int, query.limit);
      const pagePredicates: string[] = [];
      this.addFilters(pageRequest, snapshot.fields, query, pagePredicates);
      if (quick) pageRequest.input('quick', sql.NVarChar(sql.MAX), `%${escapeLike(quick)}%`);
      if (quick) pagePredicates.push(`(${snapshot.fields.map(({ name, typeName }) => `${displayValueSql(name, typeName)} LIKE @quick ESCAPE N'!'`).join(' OR ')})`);
      const pageWhere = pagePredicates.length ? ` WHERE ${pagePredicates.join(' AND ')}` : '';
      const pageResult = await pageRequest.query<SqlDataRow>(`
        SELECT ${rowValueSelect} FROM ${resource}${pageWhere}
        ORDER BY ${order} OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
      `);
      const permissions = await pool.request()
        .input('resource', sql.NVarChar(776), `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`)
        .input('schema', sql.NVarChar(128), schema)
        .input('table', sql.NVarChar(128), table)
        .query<{ isTable: boolean; canSelect: boolean; canUpdate: boolean; canInsert: boolean; canDelete: boolean }>(`
          SELECT CONVERT(bit, CASE WHEN o.type = 'U' THEN 1 ELSE 0 END) AS isTable,
            CONVERT(bit, HAS_PERMS_BY_NAME(@resource, 'OBJECT', 'SELECT')) AS canSelect,
            CONVERT(bit, HAS_PERMS_BY_NAME(@resource, 'OBJECT', 'UPDATE')) AS canUpdate,
            CONVERT(bit, HAS_PERMS_BY_NAME(@resource, 'OBJECT', 'INSERT')) AS canInsert,
            CONVERT(bit, HAS_PERMS_BY_NAME(@resource, 'OBJECT', 'DELETE')) AS canDelete
          FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
          WHERE s.name = @schema AND o.name = @table;
        `);
      // Schema and data permissions are intentionally separate; existence is established by inspection above.
      const permissionRow = permissions.recordset[0];
      const isBaseTable = snapshot.kind === 'table' && Boolean(permissionRow?.isTable);
      const editableKey = keyFields.length > 0 && keyFields.every((name) => {
        const field = snapshot.fields.find(({ name: fieldName }) => fieldName === name);
        return Boolean(field && supportsTextRoundTrip(field.typeName));
      });
      const canUpdateRows = Boolean(isBaseTable && editableKey && permissionRow?.canUpdate);
      const canInsertRows = Boolean(isBaseTable && permissionRow?.canInsert);
      const canDeleteRows = Boolean(isBaseTable && editableKey && permissionRow?.canDelete);
      const columns = snapshot.fields.map((field) => ({
        ordinalPosition: field.ordinalPosition,
        name: field.name,
        dataType: field.dataType,
        nullable: field.nullable,
        editable: Boolean(canUpdateRows && !field.generated && supportsTextRoundTrip(field.typeName)),
        insertable: Boolean(canInsertRows && !field.generated && !field.identityGeneration && supportsTextRoundTrip(field.typeName)),
      }));
      const rows = pageResult.recordset.map((row) => normalizeRow(row, snapshot.fields));
      const rowVersions = rows.map((row) => rowVersion(snapshot.fields, row));
      return { columns, rows, keyFields, rowVersions, canUpdateRows, canInsertRows, canDeleteRows, totalRows };
    });
  }

  /** Applies one completed row update with a key lock and full-row optimistic concurrency check. */
  async updateTableDataRow(configuration: SqlServerConnectRequest, schema: string, table: string, update: TableDataRowUpdate): Promise<void> {
    await this.withPool(configuration, async (pool) => {
      const tx = await beginTransaction(pool);
      try {
        const snapshot = await this.inspectWithPool(pool, schema, table);
        if (!snapshot) throw new MigrationPlanError('not-found', 'The requested table was not found or is not visible.');
        await updateWithinTransaction(tx, snapshot, update);
        await tx.commit();
      } catch (error) {
        await tx.rollback().catch(() => undefined);
        throw error;
      }
    });
  }

  /** Inserts one row using bound values and leaves omitted columns to SQL Server defaults. */
  async insertTableDataRow(configuration: SqlServerConnectRequest, schema: string, table: string, insert: TableDataRowInsert): Promise<void> {
    await this.withPool(configuration, async (pool) => {
      const snapshot = await this.inspectWithPool(pool, schema, table);
      if (!snapshot) throw new MigrationPlanError('not-found', 'The requested table was not found or is not visible.');
      await insertInto(pool.request(), snapshot, insert);
    });
  }

  /** Deletes one row using its primary key and a locked full-row concurrency check. */
  async deleteTableDataRow(configuration: SqlServerConnectRequest, schema: string, table: string, deletion: TableDataRowDelete): Promise<void> {
    await this.withPool(configuration, async (pool) => {
      const tx = await beginTransaction(pool);
      try {
        const snapshot = await this.inspectWithPool(pool, schema, table);
        if (!snapshot) throw new MigrationPlanError('not-found', 'The requested table was not found or is not visible.');
        await deleteWithinTransaction(tx, snapshot, deletion);
        await tx.commit();
      } catch (error) {
        await tx.rollback().catch(() => undefined);
        throw error;
      }
    });
  }

  /** Generates SQL preview for data-only runbook operations. */
  async previewDataRunbook(configuration: SqlServerConnectRequest, schema: string, table: string, operations: SqlDataOperation[]): Promise<DataRunbookPreviewResponse> {
    const snapshot = await this.inspectTable(configuration, schema, table);
    if (!snapshot) throw new MigrationPlanError('not-found', 'The requested table was not found or is not visible.');
    const statements = operations.map((operation) => previewStatement(snapshot, operation));
    return { snapshot, preview: { baselineFingerprint: snapshot.fingerprint, statements, warnings: [] } };
  }

  /** Converts the shared migration preview API into a SQL Server data-only preview. */
  async previewMigration(configuration: SqlServerConnectRequest, request: MigrationPreviewRequest): Promise<MigrationPreviewResponse> {
    if (request.tablePlans?.length) {
      throw new MigrationPlanError('invalid', 'Cross-table schema migration batches are not supported by the SQL Server adapter yet.');
    }
    const operations = request.operations.filter(isDataOperation);
    if (operations.length !== request.operations.length) {
      throw new MigrationPlanError('invalid', 'SQL Server schema editing is not enabled yet. This adapter currently supports data Runbook operations only.');
    }
    const result = await this.previewDataRunbook(configuration, request.schema, request.table, operations);
    if (request.baselineFingerprint !== result.snapshot.fingerprint) {
      throw new MigrationPlanError('drift', 'The table changed since this preview was generated. Refresh the schema and review the draft again.');
    }
    return result.preview;
  }

  /** Applies only reviewed data operations atomically and returns the current inspected snapshot. */
  async applyMigration(configuration: SqlServerConnectRequest, request: MigrationApplyRequest): Promise<MigrationApplyResponse> {
    if (request.tablePlans?.length) {
      throw new MigrationPlanError('invalid', 'Cross-table schema migration batches are not supported by the SQL Server adapter yet.');
    }
    validateIdentifier(request.schema, 'schema');
    validateIdentifier(request.table, 'table');
    const operations = request.operations.filter(isDataOperation);
    if (!request.baselineFingerprint || operations.length !== request.operations.length) {
      throw new MigrationPlanError('invalid', 'SQL Server currently supports data-only Runbook operations.');
    }
    return this.withPool(configuration, async (pool) => {
      const tx = await beginTransaction(pool);
      try {
        const snapshot = await this.inspectWithPool(pool, request.schema, request.table);
        if (!snapshot) throw new MigrationPlanError('not-found', 'The requested table was not found or is not visible.');
        if (snapshot.fingerprint !== request.baselineFingerprint) {
          throw new MigrationPlanError('drift', 'The table changed since this preview was generated. Refresh the schema and review the draft again.');
        }
        const statements = operations.map((operation) => previewStatement(snapshot, operation));
        if (!sameStrings(statements, request.reviewedStatements)) {
          throw new MigrationPlanError('review-mismatch', 'The reviewed SQL no longer matches this data plan. Generate a new preview before applying.');
        }
        for (const operation of operations) {
          if (operation.kind === 'updateDataRow') await updateWithinTransaction(tx, snapshot, operation);
          else if (operation.kind === 'deleteDataRow') await deleteWithinTransaction(tx, snapshot, operation);
          else await insertInto(new sql.Request(tx), snapshot, operation);
        }
        await tx.commit();
        const updated = await this.inspectWithPool(pool, request.schema, request.table);
        if (!updated) throw new MigrationPlanError('unknown', 'The data changes committed, but the table metadata could not be reloaded.');
        return { appliedStatements: statements, snapshots: [updated] };
      } catch (error) {
        await tx.rollback().catch(() => undefined);
        throw error;
      }
    });
  }

  /** Introspects columns and supported key/foreign-key/check metadata on an existing object. */
  private async inspectWithPool(pool: sql.ConnectionPool, schema: string, table: string): Promise<TableSnapshot | undefined> {
    const objectResult = await pool.request()
      .input('schema', sql.NVarChar(128), schema)
      .input('table', sql.NVarChar(128), table)
      .query<{ kind: 'table' | 'view'; definitionSql: string | null }>(`
        SELECT CASE WHEN o.type = 'V' THEN 'view' ELSE 'table' END AS kind,
          CASE WHEN o.type = 'V' THEN OBJECT_DEFINITION(o.object_id) ELSE NULL END AS definitionSql
        FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
        WHERE s.name = @schema AND o.name = @table AND o.type IN ('U', 'V') AND o.is_ms_shipped = 0
          AND HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(o.name), 'OBJECT', 'SELECT') = 1;
      `);
    const kind = objectResult.recordset[0]?.kind;
    if (!kind) return undefined;
    const fieldResult = await pool.request()
      .input('schema', sql.NVarChar(128), schema)
      .input('table', sql.NVarChar(128), table)
      .query<SqlColumn>(`
        SELECT c.column_id AS ordinalPosition, c.name,
          SCHEMA_NAME(ty.schema_id) AS typeSchema, ty.name AS typeName,
          CASE WHEN ty.name IN ('nvarchar','nchar') AND c.max_length <> -1 THEN CONCAT(ty.name, '(', c.max_length / 2, ')')
               WHEN ty.name IN ('varchar','char','varbinary','binary') AND c.max_length <> -1 THEN CONCAT(ty.name, '(', c.max_length, ')')
               WHEN c.max_length = -1 AND ty.name IN ('nvarchar','nchar','varchar','char','varbinary','binary') THEN CONCAT(ty.name, '(max)')
               WHEN ty.name IN ('decimal','numeric') THEN CONCAT(ty.name, '(', c.precision, ',', c.scale, ')')
               WHEN ty.name IN ('datetime2','datetimeoffset','time') THEN CONCAT(ty.name, '(', c.scale, ')')
               ELSE ty.name END AS dataType,
          CASE WHEN c.max_length = -1 THEN NULL
               WHEN ty.name IN ('nvarchar','nchar') THEN c.max_length / 2
               WHEN ty.name IN ('varchar','char') THEN c.max_length ELSE NULL END AS characterMaximumLength,
          CASE WHEN ty.name IN ('decimal','numeric') THEN c.precision ELSE NULL END AS numericPrecision,
          CASE WHEN ty.name IN ('decimal','numeric') THEN c.scale ELSE NULL END AS numericScale,
          CONVERT(bit, c.is_nullable) AS nullable, dc.definition AS defaultExpression,
          CASE WHEN c.is_identity = 1 THEN 'byDefault' ELSE NULL END AS identityGeneration,
          CONVERT(bit, CASE WHEN c.is_computed = 1 OR ty.name IN ('timestamp','rowversion') OR c.generated_always_type <> 0 THEN 1 ELSE 0 END) AS generated,
          cc.definition AS generationExpression
        FROM sys.columns c
        JOIN sys.objects o ON o.object_id = c.object_id
        JOIN sys.schemas s ON s.schema_id = o.schema_id
        JOIN sys.types ty ON ty.user_type_id = c.user_type_id
        LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
        LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
        WHERE s.name = @schema AND o.name = @table
        ORDER BY c.column_id;
      `);
    const fields = fieldResult.recordset.map((column) => mapField(column));
    const constraintResult = await pool.request()
      .input('schema', sql.NVarChar(128), schema)
      .input('table', sql.NVarChar(128), table)
      .query<SqlKeyColumn>(`
        SELECT kc.name AS constraintName, kc.type AS constraintType, c.name AS fieldName,
          ic.key_ordinal AS keyOrdinal, CAST(NULL AS nvarchar(128)) AS referencedSchema,
          CAST(NULL AS nvarchar(128)) AS referencedTable, CAST(NULL AS nvarchar(128)) AS referencedFieldName,
          CAST(NULL AS nvarchar(max)) AS definition
        FROM sys.key_constraints kc
        JOIN sys.objects o ON o.object_id = kc.parent_object_id
        JOIN sys.schemas s ON s.schema_id = o.schema_id
        JOIN sys.index_columns ic ON ic.object_id = kc.parent_object_id AND ic.index_id = kc.unique_index_id
        JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
        WHERE s.name = @schema AND o.name = @table
        UNION ALL
        SELECT fk.name, 'F', pc.name, fkc.constraint_column_id, rs.name, ro.name, rc.name, NULL
        FROM sys.foreign_keys fk
        JOIN sys.objects o ON o.object_id = fk.parent_object_id
        JOIN sys.schemas s ON s.schema_id = o.schema_id
        JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
        JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
        JOIN sys.objects ro ON ro.object_id = fkc.referenced_object_id
        JOIN sys.schemas rs ON rs.schema_id = ro.schema_id
        JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
        WHERE s.name = @schema AND o.name = @table
        UNION ALL
        SELECT ck.name, 'C', NULL, NULL, NULL, NULL, NULL, ck.definition
        FROM sys.check_constraints ck
        JOIN sys.objects o ON o.object_id = ck.parent_object_id
        JOIN sys.schemas s ON s.schema_id = o.schema_id
        WHERE s.name = @schema AND o.name = @table
        ORDER BY constraintName, keyOrdinal;
      `);
    const constraints = mapConstraints(constraintResult.recordset);
    const definitionSql = objectResult.recordset[0]?.definitionSql ?? null;
    const fingerprint = createHash('sha256').update(JSON.stringify({ schema, table, kind, definitionSql, fields, constraints })).digest('hex');
    return {
      schema, name: table, kind, definitionSql, canAlter: false, fingerprint,
      editableFieldTypes: [], editableConstraintKinds: [], editableIdentityGenerations: [], fields, constraints,
    };
  }

  /** Adds validated values for SQL Server data filters as bound parameters. */
  private addFilters(request: sql.Request, fields: TableFieldDescriptor[], query: TableDataQueryRequest, predicates: string[]): void {
    const known = new Set(fields.map(({ name }) => name));
    query.filters.forEach((filter, index) => {
      if (!known.has(filter.field)) throw new MigrationPlanError('invalid', `The filter field "${filter.field}" is not part of this table.`);
      const fieldType = fields.find(({ name }) => name === filter.field)?.typeName ?? '';
      const field = displayValueSql(filter.field, fieldType);
      const bind = (suffix: string, value: string | null | undefined): string => {
        const name = `filter_${index}_${suffix}`;
        request.input(name, sql.NVarChar(sql.MAX), value ?? null);
        return `@${name}`;
      };
      switch (filter.operator) {
        case 'isNull': predicates.push(`${quoteIdentifier(filter.field)} IS NULL`); break;
        case 'isNotNull': predicates.push(`${quoteIdentifier(filter.field)} IS NOT NULL`); break;
        case 'in': {
          if (!filter.values?.length) throw new MigrationPlanError('invalid', 'Choose at least one filter value.');
          predicates.push(`${field} IN (${filter.values.map((value, valueIndex) => bind(`v${valueIndex}`, value)).join(', ')})`);
          break;
        }
        case 'between':
          if (filter.value === undefined || filter.secondValue === undefined) throw new MigrationPlanError('invalid', 'Provide both bounds for the range filter.');
          predicates.push(`${field} BETWEEN ${bind('a', filter.value)} AND ${bind('b', filter.secondValue)}`);
          break;
        case 'contains': case 'notContains': case 'startsWith': case 'endsWith': {
          if (filter.value === undefined) throw new MigrationPlanError('invalid', 'Enter a value for this filter.');
          const raw = escapeLike(filter.value);
          const pattern = filter.operator === 'contains' || filter.operator === 'notContains' ? `%${raw}%`
            : filter.operator === 'startsWith' ? `${raw}%` : `%${raw}`;
          predicates.push(`${field} ${filter.operator === 'notContains' ? 'NOT ' : ''}LIKE ${bind('v', pattern)} ESCAPE N'!'`);
          break;
        }
        default: {
          const operators = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' } as const;
          const operator = operators[filter.operator as keyof typeof operators];
          if (!operator || filter.value === undefined) throw new MigrationPlanError('invalid', 'This filter requires a supported comparison and value.');
          predicates.push(`${quoteIdentifier(filter.field)} ${operator} ${bind('v', filter.value)}`);
        }
      }
    });
  }

  /** Opens one bounded pool lifecycle and translates driver failures into safe SQL Server errors. */
  private async withPool<T>(configuration: SqlServerConnectRequest, action: (pool: sql.ConnectionPool) => Promise<T>): Promise<T> {
    assertAllowedHost(configuration.host);
    const pool = new sql.ConnectionPool({
      server: configuration.host,
      port: configuration.port,
      database: configuration.database,
      user: configuration.username,
      password: configuration.password,
      connectionTimeout: 8000,
      requestTimeout: 15000,
      pool: { max: 2, min: 0, idleTimeoutMillis: 5000 },
      options: {
        encrypt: configuration.encrypt,
        trustServerCertificate: configuration.trustServerCertificate,
        appName: 'QueryDock',
        abortTransactionOnError: true,
      },
    });
    pool.on('error', (error) => this.logger.warn(`SQL Server pool error: ${safeDriverCode(error)} ${error.message}`));
    try {
      await pool.connect();
      return await action(pool);
    } catch (error) {
      if (error instanceof MigrationPlanError || error instanceof SqlServerConnectionError) throw error;
      const message = error instanceof Error ? error.message : 'Unknown SQL Server error';
      this.logger.warn(`SQL Server request failed (${safeDriverCode(error)}): ${message}`);
      throw new SqlServerConnectionError(message, safeSqlServerMessage(error));
    } finally {
      await pool.close().catch(() => undefined);
    }
  }
}

/** Safe adapter error with a user-facing explanation and no connection secret. */
export class SqlServerConnectionError extends Error {
  constructor(message: string, readonly safeMessage: string) {
    super(message);
    this.name = 'SqlServerConnectionError';
  }
}

/** Safely quotes one SQL Server identifier. */
function quoteIdentifier(value: string): string {
  return `[${value.replaceAll(']', ']]')}]`;
}

/** Validates schema/table names against SQL Server identifier limits before composing SQL. */
function validateIdentifier(value: string, label: string): void {
  if (!value.trim() || value.length > 128 || value.includes('\0')) throw new MigrationPlanError('invalid', `The ${label} name is invalid for SQL Server.`);
}

/** Maps SQL Server catalog types to the shared table field shape. */
function mapField(column: SqlColumn): TableFieldDescriptor {
  return {
    ordinalPosition: column.ordinalPosition,
    name: column.name,
    typeSchema: column.typeSchema,
    typeName: column.typeName,
    dataType: column.dataType,
    editableType: null,
    editable: false,
    identityEditable: false,
    characterMaximumLength: column.characterMaximumLength,
    numericPrecision: column.numericPrecision,
    numericScale: column.numericScale,
    nullable: column.nullable,
    defaultExpression: column.defaultExpression,
    identityGeneration: column.identityGeneration,
    generated: column.generated,
    generationExpression: column.generationExpression,
  };
}

/** Groups catalog rows into shared key, foreign-key, and check-constraint descriptors. */
function mapConstraints(rows: SqlKeyColumn[]): TableConstraintDescriptor[] {
  const groups = new Map<string, SqlKeyColumn[]>();
  for (const row of rows) groups.set(row.constraintName, [...(groups.get(row.constraintName) ?? []), row]);
  return [...groups].map(([name, items]) => {
    const first = items[0]!;
    const ordered = items.filter(({ fieldName }) => fieldName !== null).sort((a, b) => (a.keyOrdinal ?? 0) - (b.keyOrdinal ?? 0));
    const kind: TableConstraintDescriptor['kind'] = first.constraintType === 'PK' ? 'primaryKey'
      : first.constraintType === 'UQ' ? 'unique' : first.constraintType === 'F' ? 'foreignKey' : 'check';
    return {
      name,
      kind,
      editable: false,
      fieldNames: ordered.map(({ fieldName }) => fieldName!),
      definition: first.definition ?? '',
      referencedSchema: first.referencedSchema,
      referencedTable: first.referencedTable,
      referencedFieldNames: ordered.flatMap(({ referencedFieldName }) => referencedFieldName ? [referencedFieldName] : []),
    };
  });
}

/** Uses lossless textual projections for values before they enter the browser. */
function displayValueSql(name: string, dataType: string): string {
  const field = quoteIdentifier(name);
  if (['binary', 'varbinary', 'image', 'timestamp', 'rowversion'].includes(dataType)) {
    return `CASE WHEN ${field} IS NULL THEN NULL ELSE CONVERT(varchar(max), ${field}, 2) END`;
  }
  if (dataType === 'geography' || dataType === 'geometry') {
    return `CASE WHEN ${field} IS NULL THEN NULL ELSE ${field}.STAsText() END`;
  }
  if (dataType === 'hierarchyid') return `CASE WHEN ${field} IS NULL THEN NULL ELSE ${field}.ToString() END`;
  if (['float', 'real'].includes(dataType)) return `CASE WHEN ${field} IS NULL THEN NULL ELSE CONVERT(nvarchar(max), ${field}, 3) END`;
  if (['date', 'datetime', 'datetime2', 'datetimeoffset', 'smalldatetime', 'time'].includes(dataType)) {
    return `CASE WHEN ${field} IS NULL THEN NULL ELSE CONVERT(nvarchar(max), ${field}, 127) END`;
  }
  return `CASE WHEN ${field} IS NULL THEN NULL ELSE CONVERT(nvarchar(max), ${field}) END`;
}

/** Restricts SQL Server writes to types whose text form converts losslessly through parameters. */
function supportsTextRoundTrip(typeName: string): boolean {
  return new Set([
    'bigint', 'bit', 'char', 'date', 'datetime', 'datetime2', 'datetimeoffset', 'decimal', 'float', 'int',
    'money', 'nchar', 'ntext', 'numeric', 'nvarchar', 'real', 'smalldatetime', 'smallint', 'smallmoney',
    'text', 'time', 'tinyint', 'uniqueidentifier', 'varchar', 'xml',
  ]).has(typeName.toLowerCase());
}

/** Converts driver result values to the shared string-or-null row representation. */
function normalizeRow(row: SqlDataRow, fields: TableFieldDescriptor[]): SqlDataRow {
  return Object.fromEntries(fields.map(({ name }) => {
    const value = row[name];
    return [name, value === null || value === undefined ? null : String(value)];
  }));
}

/** Computes an opaque concurrency token from the lossless displayed row representation. */
function rowVersion(fields: TableFieldDescriptor[], row: SqlDataRow): string {
  return createHash('sha256').update(JSON.stringify(fields.map(({ name }) => [name, row[name] ?? null]))).digest('hex');
}

/** Builds deterministic ordering with primary-key columns as the tie breaker. */
function buildOrder(snapshot: TableSnapshot, requested: TableDataQueryRequest['sort']): string {
  const order = new Map<string, 'ASC' | 'DESC'>();
  for (const item of requested) order.set(item.field, item.direction === 'desc' ? 'DESC' : 'ASC');
  const keyFields = snapshot.constraints.find(({ kind }) => kind === 'primaryKey')?.fieldNames ?? [];
  for (const field of keyFields.length ? keyFields : snapshot.fields.map(({ name }) => name)) {
    if (!order.has(field)) order.set(field, 'ASC');
  }
  return [...order].map(([field, direction]) => `${quoteIdentifier(field)} ${direction}`).join(', ');
}

/** Creates driver request parameters for a composite key. */
function addKeyParameters(request: sql.Request, snapshot: TableSnapshot, key: Record<string, string | null>): string[] {
  const keyFields = snapshot.constraints.find(({ kind }) => kind === 'primaryKey')?.fieldNames ?? [];
  if (!keyFields.length || keyFields.length !== Object.keys(key).length || keyFields.some((field) => !(field in key))) {
    throw new MigrationPlanError('invalid', 'This table needs a complete primary key before its rows can be changed safely.');
  }
  return keyFields.map((field, index) => {
    const parameter = `key_${index}`;
    const descriptor = snapshot.fields.find(({ name }) => name === field);
    if (!descriptor || !supportsTextRoundTrip(descriptor.typeName)) {
      throw new MigrationPlanError('invalid', `Rows in this SQL Server table cannot be changed safely because primary-key field "${field}" uses an unsupported type.`);
    }
    request.input(parameter, sql.NVarChar(sql.MAX), key[field]);
    return key[field] === null ? `${quoteIdentifier(field)} IS NULL` : `${displayValueSql(field, descriptor.typeName)} = @${parameter}`;
  });
}

/** Locks and reads the addressed row, then compares the opaque token before a write. */
async function readCurrentRow(tx: sql.Transaction, snapshot: TableSnapshot, key: Record<string, string | null>): Promise<SqlDataRow> {
  const request = new sql.Request(tx);
  const keyPredicates = addKeyParameters(request, snapshot, key);
  const projection = snapshot.fields.map(({ name, dataType }) => `${displayValueSql(name, dataType)} AS ${quoteIdentifier(name)}`).join(', ');
  const result = await request.query<SqlDataRow>(`
    SELECT ${projection} FROM ${quoteIdentifier(snapshot.schema)}.${quoteIdentifier(snapshot.name)} WITH (UPDLOCK, HOLDLOCK)
    WHERE ${keyPredicates.join(' AND ')};
  `);
  const row = result.recordset[0];
  if (!row) throw new MigrationPlanError('drift', 'This row no longer exists. Refresh the table and stage the operation again.');
  return normalizeRow(row, snapshot.fields);
}

/** Updates a locked row only when its complete current value hash matches the submitted token. */
async function updateWithinTransaction(tx: sql.Transaction, snapshot: TableSnapshot, update: TableDataRowUpdate): Promise<void> {
  const current = await readCurrentRow(tx, snapshot, update.key);
  if (rowVersion(snapshot.fields, current) !== update.expectedVersion) {
    throw new MigrationPlanError('drift', 'This row changed in the database after it was loaded. Refresh the row and review your edit before saving.');
  }
  const fields = new Map(snapshot.fields.map((field) => [field.name, field]));
  const request = new sql.Request(tx);
  const keyPredicates = addKeyParameters(request, snapshot, update.key);
  const assignments = Object.entries(update.changes).map(([field, value], index) => {
    const descriptor = fields.get(field);
    if (!descriptor || descriptor.generated || !supportsTextRoundTrip(descriptor.typeName)) {
      throw new MigrationPlanError('invalid', `The field "${field}" cannot be safely edited in this SQL Server table.`);
    }
    request.input(`change_${index}`, sql.NVarChar(sql.MAX), value);
    return `${quoteIdentifier(field)} = @change_${index}`;
  });
  if (!assignments.length) throw new MigrationPlanError('invalid', 'Change at least one field before saving this row.');
  const result = await request.query(`UPDATE ${quoteIdentifier(snapshot.schema)}.${quoteIdentifier(snapshot.name)} SET ${assignments.join(', ')} WHERE ${keyPredicates.join(' AND ')};`);
  if (result.rowsAffected.reduce((sum, count) => sum + count, 0) !== 1) {
    throw new MigrationPlanError('drift', 'The row was not updated. Refresh the table and stage the change again.');
  }
}

/** Deletes a locked row only when its primary key and current value token still match. */
async function deleteWithinTransaction(tx: sql.Transaction, snapshot: TableSnapshot, deletion: TableDataRowDelete): Promise<void> {
  const current = await readCurrentRow(tx, snapshot, deletion.key);
  if (rowVersion(snapshot.fields, current) !== deletion.expectedVersion) {
    throw new MigrationPlanError('drift', 'This row changed in the database after it was loaded. Refresh the row and stage the delete again.');
  }
  const request = new sql.Request(tx);
  const predicates = addKeyParameters(request, snapshot, deletion.key);
  const result = await request.query(`DELETE FROM ${quoteIdentifier(snapshot.schema)}.${quoteIdentifier(snapshot.name)} WHERE ${predicates.join(' AND ')};`);
  if (result.rowsAffected.reduce((sum, count) => sum + count, 0) !== 1) {
    throw new MigrationPlanError('drift', 'The row was not deleted. Refresh the table and stage the operation again.');
  }
}

/** Inserts validated fields with parameters so values never become SQL syntax. */
async function insertInto(request: sql.Request, snapshot: TableSnapshot, insert: TableDataRowInsert): Promise<void> {
  const columns = new Map(snapshot.fields.map((field) => [field.name, field]));
  const entries = Object.entries(insert.values);
  for (const [name] of entries) {
    const field = columns.get(name);
    if (!field || field.generated || field.identityGeneration || !supportsTextRoundTrip(field.typeName)) {
      throw new MigrationPlanError('invalid', `The field "${name}" cannot be inserted in this SQL Server table.`);
    }
  }
  if (!entries.length) {
    await request.query(`INSERT INTO ${quoteIdentifier(snapshot.schema)}.${quoteIdentifier(snapshot.name)} DEFAULT VALUES;`);
    return;
  }
  const columnsSql = entries.map(([name]) => quoteIdentifier(name)).join(', ');
  const valuesSql = entries.map(([, value], index) => {
    request.input(`insert_${index}`, sql.NVarChar(sql.MAX), value);
    return `@insert_${index}`;
  }).join(', ');
  await request.query(`INSERT INTO ${quoteIdentifier(snapshot.schema)}.${quoteIdentifier(snapshot.name)} (${columnsSql}) VALUES (${valuesSql});`);
}

/** Produces reviewable SQL text using SQL Server quoting and escaped Unicode literals. */
function previewStatement(snapshot: TableSnapshot, operation: SqlDataOperation): string {
  const resource = `${quoteIdentifier(snapshot.schema)}.${quoteIdentifier(snapshot.name)}`;
  if (operation.kind === 'insertDataRow') {
    const entries = Object.entries(operation.values);
    if (!entries.length) return `INSERT INTO ${resource} DEFAULT VALUES;`;
    return `INSERT INTO ${resource} (${entries.map(([name]) => quoteIdentifier(name)).join(', ')}) VALUES (${entries.map(([, value]) => sqlLiteral(value)).join(', ')});`;
  }
  const keyFields = snapshot.constraints.find(({ kind }) => kind === 'primaryKey')?.fieldNames ?? [];
  if (!keyFields.length || keyFields.length !== Object.keys(operation.key).length || keyFields.some((name) => !(name in operation.key))) {
    throw new MigrationPlanError('invalid', 'This table needs a complete primary key before its rows can be changed safely.');
  }
  const where = keyFields.map((name) => `${quoteIdentifier(name)} ${operation.key[name] === null ? 'IS NULL' : `= ${sqlLiteral(operation.key[name])}`}`).join(' AND ');
  if (operation.kind === 'deleteDataRow') return `DELETE FROM ${resource} WHERE ${where};`;
  const fields = new Set(snapshot.fields.filter(({ generated, typeName }) => !generated && supportsTextRoundTrip(typeName)).map(({ name }) => name));
  const entries = Object.entries(operation.changes);
  for (const [name] of entries) if (!fields.has(name)) throw new MigrationPlanError('invalid', `The field "${name}" is not editable in this SQL Server table.`);
  if (!entries.length) throw new MigrationPlanError('invalid', 'Change at least one field before saving this row.');
  return `UPDATE ${resource} SET ${entries.map(([name, value]) => `${quoteIdentifier(name)} = ${sqlLiteral(value)}`).join(', ')} WHERE ${where};`;
}

/** Produces a SQL Server Unicode literal or NULL without allowing statement injection. */
function sqlLiteral(value: string | null): string {
  return value === null ? 'NULL' : `N'${value.replaceAll("'", "''")}'`;
}

/** Validates data filters and binds every value through the driver. */
function escapeLike(value: string): string {
  return value.replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_').replaceAll('[', '![');
}

/** Produces the SQL Server hash token using the same normalized values returned to clients. */
function isDataOperation(operation: MigrationApplyRequest['operations'][number]): operation is SqlDataOperation {
  return operation.kind === 'updateDataRow' || operation.kind === 'insertDataRow' || operation.kind === 'deleteDataRow';
}

/** Compares reviewed and regenerated SQL in order. */
function sameStrings(expected: string[], actual: string[]): boolean {
  return expected.length === actual.length && expected.every((value, index) => value === actual[index]);
}

/** Creates the SQL Server table lock used for row-level edit transactions. */
async function beginTransaction(pool: sql.ConnectionPool): Promise<sql.Transaction> {
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  return transaction;
}

/** Validates host restrictions with the shared server allow-list setting. */
function assertAllowedHost(host: string): void {
  const configured = process.env['QUERYDOCK_ALLOWED_DATABASE_HOSTS']?.trim();
  if (!configured) return;
  const normalize = (value: string) => value.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const allowed = new Set(configured.split(',').map(normalize));
  if (!allowed.has(normalize(host))) throw new SqlServerConnectionError('Host denied by server allow list', 'This database host is not allowed by the server configuration.');
}

/** Returns a safe SQL Server error message for common login, database, and permission failures. */
function safeSqlServerMessage(error: unknown): string {
  const code = safeDriverCode(error);
  if (code === 'ELOGIN') return 'SQL Server authentication failed. Check the username and password.';
  if (code === 'ESOCKET' || code === 'ECONNREFUSED' || code === 'ETIMEOUT') return 'Could not reach SQL Server. Check the host, port, network, and TLS settings.';
  if (code === 'EREQUEST') return 'SQL Server rejected the request. Check the selected database and this account’s permissions.';
  return `The SQL Server request failed (${code}). Check the connection settings and database permissions.`;
}

/** Extracts a stable driver code without exposing request details. */
function safeDriverCode(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('code' in error)) return 'unknown';
  return typeof error.code === 'string' ? error.code : 'unknown';
}

/** Exported for unit tests to verify the SQL Server concurrency token normalization. */
export const sqlServerInternals = { mapConstraints, rowVersion, quoteIdentifier, previewStatement, supportsTextRoundTrip };
