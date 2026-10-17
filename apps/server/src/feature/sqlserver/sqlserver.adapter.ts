import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import sql from 'mssql';
import type {
  DataRunbookPreviewResponse,
  DatabasePermissionReport,
  EditableFieldTypeDescriptor,
  ForeignKeyFieldChoices,
  MigrationApplyRequest,
  MigrationApplyResponse,
  MigrationPreviewRequest,
  MigrationPreviewResponse,
  MigrationTablePlan,
  NullableFieldType,
  ResourceDescriptor,
  SchemaFieldDraftRequest,
  SchemaFieldDraftResponse,
  SchemaCapabilities,
  SchemaOperation,
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
  defaultConstraintName: string | null;
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
type SqlServerFieldOperation = Extract<SchemaOperation, { kind: 'addNullableField' | 'alterField' }>;

const SQLSERVER_EDITABLE_FIELD_TYPES: EditableFieldTypeDescriptor[] = [
  { value: 'varchar', label: 'Varchar', typeSchema: 'sys', typeName: 'varchar', identityGenerationSupported: false, defaultExpressions: [{ value: "''", label: 'Empty text' }] },
  { value: 'nvarchar', label: 'Nvarchar', typeSchema: 'sys', typeName: 'nvarchar', identityGenerationSupported: false, defaultExpressions: [{ value: "N''", label: 'Empty text' }] },
  { value: 'char', label: 'Char', typeSchema: 'sys', typeName: 'char', identityGenerationSupported: false, defaultExpressions: [{ value: "''", label: 'Empty text' }] },
  { value: 'nchar', label: 'Nchar', typeSchema: 'sys', typeName: 'nchar', identityGenerationSupported: false, defaultExpressions: [{ value: "N''", label: 'Empty text' }] },
  { value: 'varbinary', label: 'Varbinary', typeSchema: 'sys', typeName: 'varbinary', identityGenerationSupported: false, defaultExpressions: [{ value: '0x', label: 'Empty binary' }] },
  { value: 'binary', label: 'Binary', typeSchema: 'sys', typeName: 'binary', identityGenerationSupported: false, defaultExpressions: [{ value: '0x', label: 'Empty binary' }] },
  { value: 'tinyint', label: 'Tiny integer', typeSchema: 'sys', typeName: 'tinyint', identityGenerationSupported: true, defaultExpressions: [{ value: '0', label: 'Zero' }] },
  { value: 'smallint', label: 'Small integer', typeSchema: 'sys', typeName: 'smallint', identityGenerationSupported: true, defaultExpressions: [{ value: '0', label: 'Zero' }] },
  { value: 'integer', label: 'Integer', typeSchema: 'sys', typeName: 'int', identityGenerationSupported: true, defaultExpressions: [{ value: '0', label: 'Zero' }] },
  { value: 'bigint', label: 'Big integer', typeSchema: 'sys', typeName: 'bigint', identityGenerationSupported: true, defaultExpressions: [{ value: '0', label: 'Zero' }] },
  { value: 'numeric', label: 'Numeric', typeSchema: 'sys', typeName: 'decimal', identityGenerationSupported: true, defaultExpressions: [{ value: '0', label: 'Zero' }] },
  { value: 'float', label: 'Float', typeSchema: 'sys', typeName: 'float', identityGenerationSupported: false, defaultExpressions: [{ value: '0', label: 'Zero' }] },
  { value: 'real', label: 'Real', typeSchema: 'sys', typeName: 'real', identityGenerationSupported: false, defaultExpressions: [{ value: '0', label: 'Zero' }] },
  { value: 'money', label: 'Money', typeSchema: 'sys', typeName: 'money', identityGenerationSupported: false, defaultExpressions: [{ value: '0', label: 'Zero' }] },
  { value: 'smallmoney', label: 'Small money', typeSchema: 'sys', typeName: 'smallmoney', identityGenerationSupported: false, defaultExpressions: [{ value: '0', label: 'Zero' }] },
  { value: 'boolean', label: 'Boolean', typeSchema: 'sys', typeName: 'bit', identityGenerationSupported: false, defaultExpressions: [{ value: '0', label: 'False' }, { value: '1', label: 'True' }] },
  { value: 'uuid', label: 'UUID', typeSchema: 'sys', typeName: 'uniqueidentifier', identityGenerationSupported: false, defaultExpressions: [{ value: 'NEWID()', label: 'Random UUID' }] },
  { value: 'date', label: 'Date', typeSchema: 'sys', typeName: 'date', identityGenerationSupported: false, defaultExpressions: [{ value: 'CONVERT(date, GETDATE())', label: 'Current date' }] },
  { value: 'datetime', label: 'Date and time', typeSchema: 'sys', typeName: 'datetime', identityGenerationSupported: false, defaultExpressions: [{ value: 'GETDATE()', label: 'Current local time' }] },
  { value: 'smalldatetime', label: 'Small date and time', typeSchema: 'sys', typeName: 'smalldatetime', identityGenerationSupported: false, defaultExpressions: [{ value: 'GETDATE()', label: 'Current local time' }] },
  { value: 'datetime2', label: 'Date and time', typeSchema: 'sys', typeName: 'datetime2', identityGenerationSupported: false, defaultExpressions: [{ value: 'SYSUTCDATETIME()', label: 'Current UTC time' }] },
  { value: 'datetimeoffset', label: 'Date and time with offset', typeSchema: 'sys', typeName: 'datetimeoffset', identityGenerationSupported: false, defaultExpressions: [{ value: 'SYSDATETIMEOFFSET()', label: 'Current time with offset' }] },
  { value: 'time', label: 'Time', typeSchema: 'sys', typeName: 'time', identityGenerationSupported: false, defaultExpressions: [{ value: 'CONVERT(time, SYSUTCDATETIME())', label: 'Current UTC time' }] },
];

const SQLSERVER_EDITABLE_IDENTITY_GENERATIONS = [
  { value: 'none', label: 'None' },
  { value: 'byDefault', label: 'IDENTITY (1, 1)' },
] as const;

/** Implements SQL Server discovery, schema inspection, bounded reads, and guarded data writes. */
export class SqlServerAdapter {
  private readonly logger = new Logger(SqlServerAdapter.name);

  /** SQL Server field, key, relationship, and table operations are advertised per object permission. */
  schemaCapabilities(): SchemaCapabilities {
    return { createTableIfNotExists: false };
  }

  /** Returns a defensive copy of the SQL Server field types supported by schema drafts. */
  editableFieldTypes(): EditableFieldTypeDescriptor[] {
    return SQLSERVER_EDITABLE_FIELD_TYPES.map((fieldType) => ({
      ...fieldType,
      defaultExpressions: fieldType.defaultExpressions.map((expression) => ({ ...expression })),
    }));
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
        schema: string; canSelect: boolean; canInsert: boolean; canUpdate: boolean; canReference: boolean;
        canDelete: boolean; canExecute: boolean; canAlter: boolean; canControl: boolean;
      }>(`
        SELECT name AS [schema],
          CONVERT(bit, COALESCE(HAS_PERMS_BY_NAME(QUOTENAME(name), 'SCHEMA', 'SELECT'), 0)) AS canSelect,
          CONVERT(bit, COALESCE(HAS_PERMS_BY_NAME(QUOTENAME(name), 'SCHEMA', 'INSERT'), 0)) AS canInsert,
          CONVERT(bit, COALESCE(HAS_PERMS_BY_NAME(QUOTENAME(name), 'SCHEMA', 'UPDATE'), 0)) AS canUpdate,
          CONVERT(bit, COALESCE(HAS_PERMS_BY_NAME(QUOTENAME(name), 'SCHEMA', 'DELETE'), 0)) AS canDelete,
          CONVERT(bit, COALESCE(HAS_PERMS_BY_NAME(QUOTENAME(name), 'SCHEMA', 'REFERENCES'), 0)) AS canReference,
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
        canAlter: boolean; canViewDefinition: boolean; canControl: boolean; canReference: boolean;
      }>(`
        SELECT s.name AS [schema], o.name,
          CASE WHEN o.type = 'V' THEN 'view' ELSE 'table' END AS kind,
          CONVERT(bit, COALESCE(HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(o.name), 'OBJECT', 'SELECT'), 0)) AS canSelect,
          CONVERT(bit, COALESCE(HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(o.name), 'OBJECT', 'INSERT'), 0)) AS canInsert,
          CONVERT(bit, COALESCE(HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(o.name), 'OBJECT', 'UPDATE'), 0)) AS canUpdate,
          CONVERT(bit, COALESCE(HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(o.name), 'OBJECT', 'DELETE'), 0)) AS canDelete,
          CONVERT(bit, COALESCE(HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(o.name), 'OBJECT', 'REFERENCES'), 0)) AS canReference,
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
            { name: 'REFERENCES', granted: schema.canReference },
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
              { name: 'REFERENCES', granted: object.canReference },
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
        schema: string; name: string; kind: 'table' | 'view'; isUpdatable: boolean; canSelect: boolean;
      }>(`
        SELECT s.name AS [schema], o.name AS name,
          CASE WHEN o.type = 'V' THEN 'view' ELSE 'table' END AS kind,
          CONVERT(bit, CASE WHEN o.type = 'U' AND
            (HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(o.name), 'OBJECT', 'UPDATE') = 1
             OR HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(o.name), 'OBJECT', 'INSERT') = 1
             OR HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(o.name), 'OBJECT', 'DELETE') = 1)
            THEN 1 ELSE 0 END) AS isUpdatable,
          CONVERT(bit, CASE WHEN HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(o.name), 'OBJECT', 'SELECT') = 1 THEN 1 ELSE 0 END) AS canSelect
        FROM sys.objects o
        JOIN sys.schemas s ON s.schema_id = o.schema_id
        WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0
          AND (HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(o.name), 'OBJECT', 'SELECT') = 1
            OR HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(o.name), 'OBJECT', 'REFERENCES') = 1
            OR HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(o.name), 'OBJECT', 'ALTER') = 1
            OR HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(o.name), 'OBJECT', 'VIEW DEFINITION') = 1)
        ORDER BY s.name, o.name;
      `);
      return result.recordset.map(({ canSelect, ...row }) => ({ ...row, canBrowseData: canSelect, canCreateTable: false }));
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

  /** Returns primary and unique target keys with SQL Server type compatibility results. */
  async foreignKeyFieldChoices(
    configuration: SqlServerConnectRequest,
    schema: string,
    table: string,
    targetSchema: string,
    targetTable: string,
    localFieldNames: string[],
  ): Promise<ForeignKeyFieldChoices> {
    validateIdentifier(schema, 'schema');
    validateIdentifier(table, 'table');
    validateIdentifier(targetSchema, 'target schema');
    validateIdentifier(targetTable, 'target table');
    return this.withPool(configuration, async (pool) => {
      const source = await this.inspectWithPool(pool, schema, table);
      const target = await this.inspectWithPool(pool, targetSchema, targetTable);
      if (!source || source.kind !== 'table') throw new MigrationPlanError('not-found', 'The foreign-key source table was not found or is not visible.');
      if (!target || target.kind !== 'table') throw new MigrationPlanError('not-found', 'The referenced table was not found or is not visible.');
      if (!source.canEditConstraints) throw new MigrationPlanError('invalid', `This account needs ALTER permission on ${schema}.${table} to add a foreign key.`);
      if (new Set(localFieldNames).size !== localFieldNames.length) throw new MigrationPlanError('invalid', 'Choose each local field only once.');
      const localFields = localFieldNames.map((name) => source.fields.find((field) => field.name === name));
      if (localFields.some((field) => !field)) throw new MigrationPlanError('invalid', 'One or more selected local fields are no longer part of this table. Refresh and try again.');

      const keySets = target.constraints.filter(({ kind }) => kind === 'primaryKey' || kind === 'unique');
      const referencePermission = await pool.request()
        .input('schema', sql.NVarChar(128), targetSchema)
        .input('table', sql.NVarChar(128), targetTable)
        .query<{ canReference: boolean }>(`
          SELECT CONVERT(bit, COALESCE(HAS_PERMS_BY_NAME(QUOTENAME(@schema) + N'.' + QUOTENAME(@table), 'OBJECT', 'REFERENCES'), 0)) AS canReference;
        `);
      const canReference = Boolean(referencePermission.recordset[0]?.canReference);
      return {
        fieldSets: keySets.map((key) => {
          const targetFields = key.fieldNames.map((name) => target.fields.find((field) => field.name === name));
          let reason: string | null = null;
          if (!canReference) reason = `This account needs REFERENCES permission on ${targetSchema}.${targetTable}.`;
          else if (localFields.length !== targetFields.length) reason = 'The selected key has a different number of fields.';
          else if (localFields.some((field, index) => !field || !targetFields[index]
            || !sqlServerTypesCompatible(field, targetFields[index]!))) {
            reason = 'SQL Server requires each local field to use a compatible type and size with its referenced field.';
          }
          return {
            fieldNames: key.fieldNames,
            label: `${key.kind === 'primaryKey' ? 'Primary key' : 'Unique key'} (${key.fieldNames.join(', ')})`,
            compatible: reason === null,
            reason,
          };
        }),
      };
    });
  }

  /** Resolves one SQL Server field-editor draft through the same validated schema planner used by apply. */
  async previewSchemaFieldDraft(
    configuration: SqlServerConnectRequest,
    request: SchemaFieldDraftRequest,
  ): Promise<SchemaFieldDraftResponse> {
    validateIdentifier(request.schema, 'schema');
    validateIdentifier(request.table, 'table');
    return this.withPool(configuration, async (pool) => {
      const snapshot = await this.inspectWithPool(pool, request.schema, request.table);
      if (!snapshot) throw new MigrationPlanError('not-found', 'The requested table was not found or is not visible.');
      if (snapshot.fingerprint !== request.baselineFingerprint) {
        throw new MigrationPlanError('drift', 'The table changed since it was loaded. Refresh the schema and review the draft again.');
      }
      if (!snapshot.canEditFields) {
        throw new MigrationPlanError('invalid', `This account needs ALTER permission on ${request.schema}.${request.table} to edit its fields.`);
      }
      const draftOperation = normalizeSqlServerFieldDraft(snapshot, request.draft);
      const operations = draftOperation ? [...request.operations, draftOperation] : request.operations;
      const preview = operations.length
        ? await this.buildSchemaMigrationPreview(pool, [{
          schema: request.schema,
          table: request.table,
          baselineFingerprint: request.baselineFingerprint,
          operations,
        }])
        : { statements: [], warnings: [] };
      return { baselineFingerprint: snapshot.fingerprint, ...preview, operations };
    });
  }

  /** Generates SQL preview for data-only runbook operations. */
  async previewDataRunbook(configuration: SqlServerConnectRequest, schema: string, table: string, operations: SqlDataOperation[]): Promise<DataRunbookPreviewResponse> {
    const snapshot = await this.inspectTable(configuration, schema, table);
    if (!snapshot) throw new MigrationPlanError('not-found', 'The requested table was not found or is not visible.');
    const statements = operations.map((operation) => previewStatement(snapshot, operation));
    return { snapshot, preview: { baselineFingerprint: snapshot.fingerprint, statements, warnings: [] } };
  }

  /** Previews SQL Server data edits or the supported FK and table-drop schema operations. */
  async previewMigration(configuration: SqlServerConnectRequest, request: MigrationPreviewRequest): Promise<MigrationPreviewResponse> {
    if (request.tablePlans?.length) return this.previewSchemaMigration(configuration, request.tablePlans);
    const operations = request.operations.filter(isDataOperation);
    if (operations.length === request.operations.length) {
      const result = await this.previewDataRunbook(configuration, request.schema, request.table, operations);
      if (request.baselineFingerprint !== result.snapshot.fingerprint) {
        throw new MigrationPlanError('drift', 'The table changed since this preview was generated. Refresh the schema and review the draft again.');
      }
      return result.preview;
    }
    if (operations.length) throw new MigrationPlanError('invalid', 'Keep SQL Server data edits and schema changes in separate Runbook batches.');
    return this.previewSchemaMigration(configuration, [{
      schema: request.schema, table: request.table, baselineFingerprint: request.baselineFingerprint, operations: request.operations,
    }]);
  }

  /** Applies reviewed data edits or supported schema changes atomically. */
  async applyMigration(configuration: SqlServerConnectRequest, request: MigrationApplyRequest): Promise<MigrationApplyResponse> {
    if (request.tablePlans?.length) return this.applySchemaMigration(configuration, request, request.tablePlans);
    validateIdentifier(request.schema, 'schema');
    validateIdentifier(request.table, 'table');
    const operations = request.operations.filter(isDataOperation);
    if (operations.length !== request.operations.length) {
      if (operations.length) throw new MigrationPlanError('invalid', 'Keep SQL Server data edits and schema changes in separate Runbook batches.');
      return this.applySchemaMigration(configuration, request, [{
        schema: request.schema, table: request.table, baselineFingerprint: request.baselineFingerprint, operations: request.operations,
      }]);
    }
    if (!request.baselineFingerprint) {
      throw new MigrationPlanError('invalid', 'SQL Server data edits require a current table snapshot.');
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

  /** Generates one dependency ordered preview for one or more SQL Server table plans. */
  private async previewSchemaMigration(
    configuration: SqlServerConnectRequest,
    plans: MigrationTablePlan[],
  ): Promise<MigrationPreviewResponse> {
    return this.withPool(configuration, async (pool) => {
      const preview = await this.buildSchemaMigrationPreview(pool, plans);
      return { baselineFingerprint: plans[0]?.baselineFingerprint ?? null, ...preview };
    });
  }

  /** Revalidates and applies a cross-table SQL Server migration in one serializable transaction. */
  private async applySchemaMigration(
    configuration: SqlServerConnectRequest,
    request: MigrationApplyRequest,
    plans: MigrationTablePlan[],
  ): Promise<MigrationApplyResponse> {
    return this.withPool(configuration, async (pool) => {
      const tx = await beginTransaction(pool);
      let commitStarted = false;
      try {
        const generated = await this.buildSchemaMigrationPreview(pool, plans, tx);
        if (!sameStrings(generated.statements, request.reviewedStatements)) {
          throw new MigrationPlanError('review-mismatch', 'The reviewed SQL no longer matches these schema changes. Generate a new preview before applying.');
        }
        if (!sameStrings(generated.warnings, request.acknowledgedWarnings)) {
          throw new MigrationPlanError('review-mismatch', 'Review and acknowledge the current table-drop warnings before applying.');
        }
        for (const statement of generated.statements) await new sql.Request(tx).query(statement);

        const tableResults: NonNullable<MigrationApplyResponse['tableResults']> = [];
        for (const plan of plans) {
          const dropped = plan.operations.some(({ kind }) => kind === 'dropTable');
          const snapshot = dropped ? null : await this.inspectWithPool(tx, plan.schema, plan.table) ?? null;
          if (!dropped && !snapshot) throw new MigrationPlanError('unknown', `The migration ran, but ${plan.schema}.${plan.table} could not be confirmed.`);
          tableResults.push({ schema: plan.schema, table: plan.table, resultingTable: dropped ? null : plan.table, snapshot });
        }
        commitStarted = true;
        await tx.commit();
        return {
          appliedStatements: generated.statements,
          snapshots: tableResults.flatMap(({ snapshot }) => snapshot ? [snapshot] : []),
          tableResults,
        };
      } catch (error) {
        let rollbackConfirmed = false;
        console.log(error);
        try { await tx.rollback(); rollbackConfirmed = true; } catch { /* A lost connection can leave the transaction outcome uncertain. */ }
        if (error instanceof MigrationPlanError) throw error;
        const message = (error as any).message;
        if (commitStarted || !rollbackConfirmed) throw new MigrationPlanError('unknown', message ?? 'The SQL Server transaction outcome could not be confirmed. Inspect the database before retrying.');
        throw new MigrationPlanError('invalid', sqlServerMigrationMessage(error));
      }
    });
  }

  /** Validates capabilities, fingerprints, FK types and dependencies before producing SQL Server DDL. */
  private async buildSchemaMigrationPreview(
    pool: sql.ConnectionPool,
    plans: MigrationTablePlan[],
    tx?: sql.Transaction,
  ): Promise<{ statements: string[]; warnings: string[] }> {
    if (!plans.length || plans.length > 50) throw new MigrationPlanError('invalid', 'A schema batch must contain between 1 and 50 table plans.');
    if (plans.reduce((total, plan) => total + plan.operations.length, 0) > 150) throw new MigrationPlanError('invalid', 'A schema batch cannot contain more than 150 operations. Split it into smaller reviewed batches.');
    const planKeys = new Set<string>();
    const snapshots = new Map<string, TableSnapshot>();
    const ordered: { statement: string; phase: number; order: number }[] = [];
    const warnings: string[] = [];
    let order = 0;
    for (const plan of plans) {
      validateIdentifier(plan.schema, 'schema');
      validateIdentifier(plan.table, 'table');
      const key = JSON.stringify([plan.schema, plan.table]);
      if (planKeys.has(key)) throw new MigrationPlanError('invalid', `The table ${plan.schema}.${plan.table} appears more than once in this Runbook.`);
      planKeys.add(key);
      if (!plan.baselineFingerprint) throw new MigrationPlanError('invalid', 'SQL Server schema changes require a current table snapshot.');
      const supportedOperationKinds = new Set(['addNullableField', 'alterField', 'addConstraint', 'dropConstraint', 'dropTable']);
      if (!plan.operations.length || plan.operations.some(({ kind }) => !supportedOperationKinds.has(kind))) {
        throw new MigrationPlanError('invalid', 'SQL Server supports field changes, primary and unique key additions, foreign-key changes, and table drops.');
      }
      if (plan.operations.filter((operation) => operation.kind === 'addConstraint' && operation.constraintKind === 'primaryKey').length > 1) {
        throw new MigrationPlanError('invalid', 'A SQL Server table can have only one primary key.');
      }
      if (plan.operations.some(({ kind }) => kind === 'dropTable')
        && plan.operations.some(({ kind }) => kind !== 'dropTable' && kind !== 'dropConstraint')) {
        throw new MigrationPlanError('invalid', 'A table drop can include foreign-key removals, but no field changes or additions.');
      }
      const snapshot = await this.inspectWithPool(tx ?? pool, plan.schema, plan.table);
      if (!snapshot || snapshot.kind !== 'table') throw new MigrationPlanError('not-found', `The table ${plan.schema}.${plan.table} was not found or is not visible.`);
      if (snapshot.fingerprint !== plan.baselineFingerprint) throw new MigrationPlanError('drift', `The table ${plan.schema}.${plan.table} changed since it was loaded. Refresh its schema before applying.`);
      snapshots.set(key, snapshot);
      const fieldOperations = plan.operations.filter(isSqlServerFieldOperation);
      if (fieldOperations.length) {
        if (!snapshot.canEditFields) throw new MigrationPlanError('invalid', `This account needs ALTER permission on ${plan.schema}.${plan.table} to edit its fields.`);
        const fieldPlan = createSqlServerFieldPlan(snapshot, fieldOperations);
        for (const statement of fieldPlan.statements) ordered.push({ statement, phase: 30, order: order++ });
        warnings.push(...fieldPlan.warnings);
      }
      const plannedConstraintNames = new Set<string>();
      for (const operation of plan.operations) {
        if (operation.kind === 'addNullableField' || operation.kind === 'alterField') continue;
        if (operation.kind === 'dropTable') {
          if (!snapshot.canDropTable) throw new MigrationPlanError('invalid', `This account needs ALTER on schema ${plan.schema}, CONTROL on ${plan.schema}.${plan.table}, or membership in db_ddladmin to drop this table.`);
          ordered.push({ statement: dropTableStatement(plan.schema, plan.table), phase: 70, order: order++ });
          warnings.push(`Dropping ${plan.schema}.${plan.table} permanently removes the table and its data.`);
          continue;
        }
        if (operation.kind === 'dropConstraint') {
          const constraint = snapshot.constraints.find(({ name }) => name === operation.name);
          if (!constraint || constraint.kind !== 'foreignKey') throw new MigrationPlanError('invalid', `Constraint "${operation.name}" is not an existing foreign key on ${plan.schema}.${plan.table}.`);
          if (!snapshot.canEditConstraints) throw new MigrationPlanError('invalid', `This account needs ALTER permission on ${plan.schema}.${plan.table} to remove a foreign key.`);
          ordered.push({ statement: dropForeignKeyStatement(plan.schema, plan.table, operation.name), phase: 0, order: order++ });
          continue;
        }
        if (operation.kind !== 'addConstraint') throw new MigrationPlanError('invalid', 'Unsupported SQL Server schema operation.');
        validateIdentifier(operation.name, 'constraint');
        if (!snapshot.canEditConstraints) throw new MigrationPlanError('invalid', `This account needs ALTER permission on ${plan.schema}.${plan.table} to add a constraint.`);
        if (snapshot.constraints.some(({ name }) => name === operation.name) || plannedConstraintNames.has(operation.name)) {
          throw new MigrationPlanError('invalid', `Constraint "${operation.name}" already exists or is already being added on ${plan.schema}.${plan.table}.`);
        }
        plannedConstraintNames.add(operation.name);
        if (operation.constraintKind === 'primaryKey' || operation.constraintKind === 'unique') {
          if (operation.constraintKind === 'primaryKey' && snapshot.constraints.some(({ kind }) => kind === 'primaryKey')) {
            throw new MigrationPlanError('invalid', `SQL Server table ${plan.schema}.${plan.table} already has a primary key.`);
          }
          if (new Set(operation.fieldNames).size !== operation.fieldNames.length) {
            throw new MigrationPlanError('invalid', 'A primary or unique key cannot contain the same field more than once.');
          }
          if (!operation.fieldNames.length) throw new MigrationPlanError('invalid', 'Select at least one field for the primary or unique key.');
          const keyFields = operation.fieldNames.map((fieldName) => {
            const field = snapshot.fields.find(({ name }) => name === fieldName);
            if (!field) throw new MigrationPlanError('invalid', `Key field "${fieldName}" no longer exists on ${plan.schema}.${plan.table}. Refresh the schema and try again.`);
            const alteration = fieldOperations.find((candidate) => candidate.kind === 'alterField' && candidate.name === fieldName);
            const nullable = alteration?.kind === 'alterField' ? alteration.nullable ?? field.nullable : field.nullable;
            const finalName = alteration?.kind === 'alterField' ? alteration.newName : field.name;
            const typeName = alteration?.kind === 'alterField'
              ? SQLSERVER_EDITABLE_FIELD_TYPES.find(({ value }) => value === alteration.type)?.typeName ?? field.typeName
              : field.typeName;
            const maximumLength = alteration?.kind === 'alterField'
              ? alteration.characterMaximumLength ?? null
              : field.characterMaximumLength;
            if (sqlServerKeyTypeIsUnsupported(typeName, maximumLength)) {
              throw new MigrationPlanError('invalid', `Field "${fieldName}" uses ${typeName}${maximumLength === null ? '(max)' : ''}, which SQL Server cannot use in a primary or unique key.`);
            }
            if (operation.constraintKind === 'primaryKey' && nullable) {
              throw new MigrationPlanError('invalid', `Primary-key field "${fieldName}" must be NOT NULL. Turn off Nullable for this field and make sure existing rows contain no NULL values, then stage the key again.`);
            }
            return finalName;
          });
          const keyVerb = operation.constraintKind === 'primaryKey' ? 'PRIMARY KEY' : 'UNIQUE';
          ordered.push({
            statement: addKeyConstraintStatement(plan.schema, plan.table, operation.name, keyVerb, keyFields),
            phase: 40,
            order: order++,
          });
          continue;
        }
        if (operation.constraintKind !== 'foreignKey') throw new MigrationPlanError('invalid', 'SQL Server currently supports primary keys, unique keys, and foreign-key constraints in this schema workflow.');
        const targetSchema = operation.referencedSchema;
        const targetTable = operation.referencedTable;
        validateIdentifier(targetSchema, 'referenced schema');
        validateIdentifier(targetTable, 'referenced table');
        const target = await this.inspectWithPool(tx ?? pool, targetSchema, targetTable);
        if (!target || target.kind !== 'table') throw new MigrationPlanError('not-found', `Referenced table ${targetSchema}.${targetTable} was not found or is not visible.`);
        const referencedPermission = await readObjectPermission(tx ?? pool, targetSchema, targetTable, 'REFERENCES');
        if (!referencedPermission) throw new MigrationPlanError('invalid', `This account needs REFERENCES permission on ${targetSchema}.${targetTable} to add a foreign key.`);
        if (operation.fieldNames.length !== operation.referencedFieldNames.length) throw new MigrationPlanError('invalid', 'A foreign key must map the same number of local and referenced fields.');
        const sourceFields = operation.fieldNames.map((name) => snapshot.fields.find((field) => field.name === name));
        const targetFields = operation.referencedFieldNames.map((name) => target.fields.find((field) => field.name === name));
        if (sourceFields.some((field) => !field) || targetFields.some((field) => !field)) throw new MigrationPlanError('invalid', 'One or more selected foreign-key fields no longer exist. Refresh both tables and try again.');
        const candidateKey = target.constraints.some(({ kind, fieldNames }) =>
          (kind === 'primaryKey' || kind === 'unique') && sameStrings(fieldNames, operation.referencedFieldNames));
        if (!candidateKey) throw new MigrationPlanError('invalid', `Referenced fields on ${targetSchema}.${targetTable} must match a primary or unique key in key order.`);
        if (sourceFields.some((field, index) => !sqlServerTypesCompatible(field!, targetFields[index]!))) {
          throw new MigrationPlanError('invalid', 'The local and referenced foreign-key fields must use compatible SQL Server types and sizes.');
        }
        ordered.push({
          statement: addForeignKeyStatement(plan.schema, plan.table, operation.name, operation.fieldNames,
            targetSchema, targetTable, operation.referencedFieldNames),
          phase: 50,
          order: order++,
        });
      }
    }

    const plannedDrops = new Set(plans.flatMap((plan) => plan.operations.flatMap((operation) =>
      operation.kind === 'dropConstraint' ? [JSON.stringify([plan.schema, plan.table, operation.name])] : [])));
    for (const plan of plans) {
      for (const operation of plan.operations) {
        if (operation.kind === 'dropTable') {
          const inbound = await readInboundForeignKeys(tx ?? pool, plan.schema, plan.table);
          const unresolved = unresolvedInboundForeignKeys(inbound, plannedDrops);
          if (unresolved.length) {
            const refs = unresolved.slice(0, 5).map(({ schema, table, name }) => `${schema}.${table} (constraint "${name}")`).join(', ');
            throw new MigrationPlanError('invalid', `Cannot drop ${plan.schema}.${plan.table} because it is referenced by ${refs}. Stage those foreign-key removals in the same Runbook, then apply the batch.`);
          }
        }
        if (operation.kind === 'addConstraint' && operation.constraintKind === 'foreignKey'
          && plans.some((candidate) => candidate.schema === operation.referencedSchema && candidate.table === operation.referencedTable
            && candidate.operations.some(({ kind }) => kind === 'dropTable'))) {
          throw new MigrationPlanError('invalid', `The foreign key "${operation.name}" references ${operation.referencedSchema}.${operation.referencedTable}, which this batch drops.`);
        }
      }
    }
    ordered.sort((left, right) => left.phase - right.phase || left.order - right.order);
    return { statements: ordered.map(({ statement }) => statement), warnings: [...new Set(warnings)] };
  }

  /** Introspects columns and supported key/foreign-key/check metadata on an existing object. */
  private async inspectWithPool(executor: sql.ConnectionPool | sql.Transaction, schema: string, table: string): Promise<TableSnapshot | undefined> {
    const objectResult = await createRequest(executor)
      .input('schema', sql.NVarChar(128), schema)
      .input('table', sql.NVarChar(128), table)
      .query<{
        kind: 'table' | 'view'; definitionSql: string | null;
        canAlter: boolean; canDropTable: boolean; canSelect: boolean;
      }>(`
        SELECT CASE WHEN o.type = 'V' THEN 'view' ELSE 'table' END AS kind,
          CASE WHEN o.type = 'V' THEN OBJECT_DEFINITION(o.object_id) ELSE NULL END AS definitionSql,
          CONVERT(bit, COALESCE(HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(o.name), 'OBJECT', 'ALTER'), 0)) AS canAlter,
          CONVERT(bit, CASE WHEN HAS_PERMS_BY_NAME(QUOTENAME(s.name), 'SCHEMA', 'ALTER') = 1
            OR HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(o.name), 'OBJECT', 'CONTROL') = 1
            OR IS_ROLEMEMBER('db_ddladmin') = 1 THEN 1 ELSE 0 END) AS canDropTable,
          CONVERT(bit, COALESCE(HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(o.name), 'OBJECT', 'SELECT'), 0)) AS canSelect
        FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
        WHERE s.name = @schema AND o.name = @table AND o.type IN ('U', 'V') AND o.is_ms_shipped = 0
          AND (HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(o.name), 'OBJECT', 'SELECT') = 1
            OR HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(o.name), 'OBJECT', 'REFERENCES') = 1
            OR HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(o.name), 'OBJECT', 'ALTER') = 1
            OR HAS_PERMS_BY_NAME(QUOTENAME(s.name) + N'.' + QUOTENAME(o.name), 'OBJECT', 'VIEW DEFINITION') = 1);
      `);
    const kind = objectResult.recordset[0]?.kind;
    if (!kind) return undefined;
    const fieldResult = await createRequest(executor)
      .input('schema', sql.NVarChar(128), schema)
      .input('table', sql.NVarChar(128), table)
      .query<SqlColumn>(`
        SELECT c.column_id AS ordinalPosition, c.name,
          SCHEMA_NAME(ty.schema_id) AS typeSchema, ty.name AS typeName,
          CASE WHEN ty.name IN ('nvarchar','nchar') AND c.max_length <> -1 THEN CONCAT(ty.name, '(', c.max_length / 2, ')')
               WHEN ty.name IN ('varchar','char','varbinary','binary') AND c.max_length <> -1 THEN CONCAT(ty.name, '(', c.max_length, ')')
               WHEN c.max_length = -1 AND ty.name IN ('nvarchar','nchar','varchar','char','varbinary','binary') THEN CONCAT(ty.name, '(max)')
               WHEN ty.name IN ('decimal','numeric') THEN CONCAT(ty.name, '(', c.precision, ',', c.scale, ')')
               WHEN ty.name = 'float' THEN CONCAT(ty.name, '(', c.precision, ')')
               WHEN ty.name IN ('datetime2','datetimeoffset','time') THEN CONCAT(ty.name, '(', c.scale, ')')
               ELSE ty.name END AS dataType,
          CASE WHEN c.max_length = -1 THEN NULL
               WHEN ty.name IN ('nvarchar','nchar') THEN c.max_length / 2
               WHEN ty.name IN ('varchar','char','varbinary','binary') THEN c.max_length ELSE NULL END AS characterMaximumLength,
          CASE WHEN ty.name IN ('decimal','numeric','float') THEN c.precision ELSE NULL END AS numericPrecision,
          CASE WHEN ty.name IN ('decimal','numeric','datetime2','datetimeoffset','time') THEN c.scale ELSE NULL END AS numericScale,
          CONVERT(bit, c.is_nullable) AS nullable, dc.definition AS defaultExpression, dc.name AS defaultConstraintName,
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
    const object = objectResult.recordset[0]!;
    const fields = fieldResult.recordset.map((column) => mapField(column, object.canAlter));
    const constraintResult = await createRequest(executor)
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
        SELECT i.name, 'UQ', c.name, ic.key_ordinal, NULL, NULL, NULL, NULL
        FROM sys.indexes i
        JOIN sys.objects o ON o.object_id = i.object_id
        JOIN sys.schemas s ON s.schema_id = o.schema_id
        JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
        WHERE s.name = @schema AND o.name = @table AND i.is_unique = 1
          AND i.is_primary_key = 0 AND i.is_unique_constraint = 0 AND i.has_filter = 0
          AND ic.is_included_column = 0 AND ic.key_ordinal > 0
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
    const constraints = mapConstraints(constraintResult.recordset, object.canAlter);
    const definitionSql = object.definitionSql ?? null;
    const fingerprint = createHash('sha256').update(JSON.stringify({ schema, table, kind, definitionSql, fields, constraints })).digest('hex');
    return {
      // `canAlter` reports the database permission. Feature-specific flags below
      // still control which schema operations this adapter currently supports.
      schema, name: table, kind, definitionSql, canAlter: object.canAlter,
      canBrowseData: object.canSelect,
      canEditFields: kind === 'table' && object.canAlter,
      canEditConstraints: kind === 'table' && object.canAlter,
      canRenameTable: false,
      canDropTable: kind === 'table' && object.canDropTable,
      fingerprint,
      editableFieldTypes: sqlServerEditableFieldTypes(),
      editableConstraintKinds: object.canAlter && kind === 'table'
        ? [
          { value: 'primaryKey', label: 'Primary key' },
          { value: 'unique', label: 'Unique key' },
          { value: 'foreignKey', label: 'Foreign key' },
        ]
        : [],
      editableIdentityGenerations: object.canAlter && kind === 'table'
        ? SQLSERVER_EDITABLE_IDENTITY_GENERATIONS.map((option) => ({ ...option }))
        : [],
      fields, constraints,
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
function mapField(column: SqlColumn, canAlter: boolean): TableFieldDescriptor {
  const editableType = sqlServerEditableTypeFor(column.typeSchema, column.typeName);
  return {
    ordinalPosition: column.ordinalPosition,
    name: column.name,
    typeSchema: column.typeSchema,
    typeName: column.typeName,
    dataType: column.dataType,
    editableType,
    editable: canAlter && editableType !== null && !column.generated && !column.identityGeneration,
    identityEditable: false,
    characterMaximumLength: column.characterMaximumLength,
    numericPrecision: column.numericPrecision,
    numericScale: column.numericScale,
    nullable: column.nullable,
    defaultExpression: column.defaultExpression,
    identityGeneration: column.identityGeneration,
    generated: column.generated,
    generationExpression: column.generationExpression,
    defaultConstraintName: column.defaultConstraintName,
  };
}

/** Maps only supported SQL Server system types to the field editor's type vocabulary. */
function sqlServerEditableTypeFor(typeSchema: string, typeName: string): NullableFieldType | null {
  if (typeSchema.toLowerCase() !== 'sys') return null;
  const typeMap: Record<string, NullableFieldType> = {
    varchar: 'varchar',
    nvarchar: 'nvarchar',
    char: 'char',
    nchar: 'nchar',
    varbinary: 'varbinary',
    binary: 'binary',
    tinyint: 'tinyint',
    smallint: 'smallint',
    int: 'integer',
    bigint: 'bigint',
    decimal: 'numeric',
    numeric: 'numeric',
    float: 'float',
    real: 'real',
    money: 'money',
    smallmoney: 'smallmoney',
    bit: 'boolean',
    uniqueidentifier: 'uuid',
    date: 'date',
    datetime: 'datetime',
    smalldatetime: 'smalldatetime',
    datetime2: 'datetime2',
    datetimeoffset: 'datetimeoffset',
    time: 'time',
  };
  return typeMap[typeName.toLowerCase()] ?? null;
}

/** Reports whether the SQL Server IDENTITY property accepts the selected field type and dimensions. */
function supportsSqlServerIdentity(type: string, numericScale: number | null | undefined): boolean {
  if (['tinyint', 'smallint', 'integer', 'bigint'].includes(type)) return true;
  return type === 'numeric' && (numericScale ?? 0) === 0;
}

/** Returns fresh editor descriptors for inclusion in table snapshots. */
function sqlServerEditableFieldTypes(): EditableFieldTypeDescriptor[] {
  return SQLSERVER_EDITABLE_FIELD_TYPES.map((fieldType) => ({
    ...fieldType,
    defaultExpressions: fieldType.defaultExpressions.map((expression) => ({ ...expression })),
  }));
}

/** Groups catalog rows into shared key, foreign-key, and check-constraint descriptors. */
function mapConstraints(rows: SqlKeyColumn[], canEditForeignKeys = false): TableConstraintDescriptor[] {
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
      editable: kind === 'foreignKey' && canEditForeignKeys,
      fieldNames: ordered.map(({ fieldName }) => fieldName!),
      definition: first.definition ?? '',
      referencedSchema: first.referencedSchema,
      referencedTable: first.referencedTable,
      referencedFieldNames: ordered.flatMap(({ referencedFieldName }) => referencedFieldName ? [referencedFieldName] : []),
    };
  });
}

/** Checks the conservative SQL Server FK compatibility subset supported by the schema helper. */
function sqlServerTypesCompatible(local: TableFieldDescriptor, referenced: TableFieldDescriptor): boolean {
  const localType = local.typeName.toLowerCase();
  const referencedType = referenced.typeName.toLowerCase();
  const nonKeyTypes = new Set(['text', 'ntext', 'image', 'xml', 'timestamp', 'rowversion', 'sql_variant', 'geography', 'geometry', 'hierarchyid']);
  if (nonKeyTypes.has(localType) || nonKeyTypes.has(referencedType)) return false;
  const allowedPair = localType === referencedType
    || (localType === 'char' && referencedType === 'varchar')
    || (localType === 'nchar' && referencedType === 'nvarchar')
    || (localType === 'binary' && referencedType === 'varbinary');
  if (!allowedPair) return false;
  if (local.typeSchema.toLowerCase() !== referenced.typeSchema.toLowerCase()
    && localType === referencedType && local.typeSchema.toLowerCase() !== 'sys') return false;
  const characterTypes = new Set(['char', 'varchar', 'nchar', 'nvarchar']);
  const binaryTypes = new Set(['binary', 'varbinary']);
  if ([localType, referencedType].every((typeName) => characterTypes.has(typeName))
    && local.characterMaximumLength !== referenced.characterMaximumLength) return false;
  if ([localType, referencedType].every((typeName) => binaryTypes.has(typeName))
    && typeSize(local.dataType) !== typeSize(referenced.dataType)) return false;
  if (local.numericPrecision !== referenced.numericPrecision || local.numericScale !== referenced.numericScale) return false;
  if (localType === referencedType && local.dataType.toLowerCase() !== referenced.dataType.toLowerCase()) return false;
  return true;
}

/** Extracts the SQL Server type parameter used by sized binary types. */
function typeSize(dataType: string): string | null {
  return dataType.match(/\(([^)]*)\)/)?.[1]?.toLowerCase() ?? null;
}

/** Builds a checked SQL Server primary-key or unique-key statement from validated identifiers. */
function addKeyConstraintStatement(
  schema: string,
  table: string,
  name: string,
  kind: 'PRIMARY KEY' | 'UNIQUE',
  fields: string[],
): string {
  const keyFields = fields.map(quoteIdentifier).join(', ');
  return `ALTER TABLE ${quoteIdentifier(schema)}.${quoteIdentifier(table)} ADD CONSTRAINT ${quoteIdentifier(name)} ${kind} NONCLUSTERED (${keyFields});`;
}

/** Reports SQL Server data types that cannot be used as primary or unique index key columns. */
function sqlServerKeyTypeIsUnsupported(typeName: string, maximumLength: number | null): boolean {
  const normalized = typeName.toLowerCase();
  if (['text', 'ntext', 'image', 'xml', 'timestamp', 'rowversion', 'sql_variant', 'geography', 'geometry', 'hierarchyid'].includes(normalized)) return true;
  return maximumLength === null && ['varchar', 'nvarchar', 'varbinary'].includes(normalized);
}

/** Builds a checked SQL Server foreign-key statement from validated identifiers. */
function addForeignKeyStatement(
  schema: string,
  table: string,
  name: string,
  fields: string[],
  referencedSchema: string,
  referencedTable: string,
  referencedFields: string[],
): string {
  const localFields = fields.map(quoteIdentifier).join(', ');
  const remoteFields = referencedFields.map(quoteIdentifier).join(', ');
  return `ALTER TABLE ${quoteIdentifier(schema)}.${quoteIdentifier(table)} WITH CHECK ADD CONSTRAINT ${quoteIdentifier(name)} FOREIGN KEY (${localFields}) REFERENCES ${quoteIdentifier(referencedSchema)}.${quoteIdentifier(referencedTable)} (${remoteFields});`;
}

/** Builds a SQL Server foreign-key removal statement. */
function dropForeignKeyStatement(schema: string, table: string, name: string): string {
  return `ALTER TABLE ${quoteIdentifier(schema)}.${quoteIdentifier(table)} DROP CONSTRAINT ${quoteIdentifier(name)};`;
}

/** Builds a SQL Server table-drop statement. */
function dropTableStatement(schema: string, table: string): string {
  return `DROP TABLE ${quoteIdentifier(schema)}.${quoteIdentifier(table)};`;
}

/** Identifies field operations supported by the SQL Server schema editor. */
function isSqlServerFieldOperation(operation: SchemaOperation): operation is SqlServerFieldOperation {
  return operation.kind === 'addNullableField' || operation.kind === 'alterField';
}

/** Validates SQL Server field edits and produces their dependency-safe DDL and warnings. */
function createSqlServerFieldPlan(
  snapshot: TableSnapshot,
  operations: SqlServerFieldOperation[],
): { statements: string[]; warnings: string[] } {
  const currentNames = new Set(snapshot.fields.map(({ name }) => name));
  const sourceNames = new Set<string>();
  const finalNames = new Set<string>();
  const statements: string[] = [];
  const warnings: string[] = [];

  for (const operation of operations) {
    if (operation.kind === 'addNullableField') {
      const name = operation.name.trim();
      validateIdentifier(name, 'field');
      if (currentNames.has(name) || finalNames.has(name)) {
        throw new MigrationPlanError('invalid', `A field named "${name}" already exists or is already in this plan.`);
      }
      finalNames.add(name);
      const typeSql = formatSqlServerFieldType(operation);
      const defaultExpression = operation.defaultExpression === null || operation.defaultExpression === undefined
        ? null
        : validateSqlServerDefaultExpression(operation.defaultExpression);
      const identity = operation.identityGeneration ?? null;
      if (identity && !supportsSqlServerIdentity(operation.type, operation.numericScale)) {
        throw new MigrationPlanError('invalid', `SQL Server IDENTITY supports tinyint, smallint, integer, bigint, and Numeric with scale 0; "${name}" uses an incompatible type or scale.`);
      }
      if (identity === 'always') throw new MigrationPlanError('invalid', 'SQL Server uses IDENTITY generation and does not distinguish GENERATED ALWAYS from BY DEFAULT.');
      if (identity && defaultExpression) {
        throw new MigrationPlanError('invalid', `The identity field "${name}" cannot also have a default expression.`);
      }
      if (identity && snapshot.fields.some(({ identityGeneration }) => identityGeneration !== null)) {
        throw new MigrationPlanError('invalid', 'A SQL Server table can have only one IDENTITY field. Remove the existing identity field in a separate table rebuild before adding another.');
      }
      if (identity) {
        statements.push(`ALTER TABLE ${quoteIdentifier(snapshot.schema)}.${quoteIdentifier(snapshot.name)} ADD ${quoteIdentifier(name)} ${typeSql} IDENTITY(1, 1) NOT NULL;`);
        warnings.push(`Adding "${name}" as an IDENTITY column generates values for existing rows and may lock or rewrite the table. Review the migration duration before applying.`);
      } else if (defaultExpression) {
        statements.push(`ALTER TABLE ${quoteIdentifier(snapshot.schema)}.${quoteIdentifier(snapshot.name)} ADD ${quoteIdentifier(name)} ${typeSql} NULL DEFAULT (${defaultExpression}) WITH VALUES;`);
        warnings.push(`Adding "${name}" with a default populates existing rows through WITH VALUES. Review the expression and resulting SQL.`);
      } else {
        statements.push(`ALTER TABLE ${quoteIdentifier(snapshot.schema)}.${quoteIdentifier(snapshot.name)} ADD ${quoteIdentifier(name)} ${typeSql} NULL;`);
      }
      continue;
    }

    validateIdentifier(operation.name, 'field');
    const field = snapshot.fields.find(({ name }) => name === operation.name);
    if (!field) throw new MigrationPlanError('invalid', `The field "${operation.name}" no longer exists. Refresh the table and try again.`);
    if (sourceNames.has(operation.name)) throw new MigrationPlanError('invalid', `More than one field change targets "${operation.name}".`);
    sourceNames.add(operation.name);
    if (!field.editable) {
      throw new MigrationPlanError('invalid', `The field "${operation.name}" uses a generated, identity, or unsupported SQL Server type and cannot be edited by this migration.`);
    }
    const newName = operation.newName.trim();
    validateIdentifier(newName, 'field');
    if (newName !== operation.name && currentNames.has(newName)) {
      throw new MigrationPlanError('invalid', `A field named "${newName}" already exists on this table.`);
    }
    if (finalNames.has(newName)) throw new MigrationPlanError('invalid', `More than one field change produces the name "${newName}".`);
    finalNames.add(newName);
    if (operation.identityGeneration) {
      throw new MigrationPlanError('invalid', 'SQL Server cannot add or change IDENTITY on an existing field. Choose IDENTITY when adding a new field.');
    }
    const typeSql = formatSqlServerFieldType(operation);
    const defaultExpression = operation.defaultExpression === null
      ? null
      : validateSqlServerDefaultExpression(operation.defaultExpression);
    const typeChanged = !sameSqlServerFieldType(field, operation);
    const defaultChanged = (field.defaultExpression?.trim() ?? null) !== (defaultExpression?.trim() ?? null);
    const nullable = operation.nullable ?? field.nullable;
    const needsDefaultDrop = field.defaultExpression !== null && (typeChanged || defaultChanged);
    const needsDefaultAdd = defaultExpression !== null && (typeChanged || defaultChanged);
    const table = `${quoteIdentifier(snapshot.schema)}.${quoteIdentifier(snapshot.name)}`;

    if (needsDefaultDrop) {
      if (!field.defaultConstraintName) {
        throw new MigrationPlanError('invalid', `The current default for "${field.name}" could not be identified. Refresh the table with VIEW DEFINITION permission, then try again.`);
      }
      statements.push(`ALTER TABLE ${table} DROP CONSTRAINT ${quoteIdentifier(field.defaultConstraintName)};`);
    }
    if (newName !== operation.name) {
      const oldColumnPath = `${quoteIdentifier(snapshot.schema)}.${quoteIdentifier(snapshot.name)}.${quoteIdentifier(operation.name)}`;
      statements.push(`EXEC sys.sp_rename N'${escapeSqlServerString(oldColumnPath)}', N'${escapeSqlServerString(newName)}', N'COLUMN';`);
      warnings.push(`Renaming "${operation.name}" to "${newName}" may require updating SQL modules or application queries that refer to the old field name.`);
    }
    if (typeChanged || nullable !== field.nullable) {
      statements.push(`ALTER TABLE ${table} ALTER COLUMN ${quoteIdentifier(newName)} ${typeSql} ${nullable ? 'NULL' : 'NOT NULL'};`);
    }
    if (needsDefaultAdd) {
      statements.push(`ALTER TABLE ${table} ADD DEFAULT (${defaultExpression}) FOR ${quoteIdentifier(newName)};`);
    }
    if (typeChanged) warnings.push(`Changing the type of "${field.name}" may fail or convert existing values. Review the conversion before applying.`);
    if (field.nullable && !nullable) warnings.push(`Making "${field.name}" NOT NULL may fail while existing rows contain NULL values.`);
  }

  const resultingNames = new Set([...currentNames].filter((name) => !sourceNames.has(name)));
  for (const operation of operations) {
    const name = operation.kind === 'addNullableField' ? operation.name.trim() : operation.newName.trim();
    if (resultingNames.has(name)) throw new MigrationPlanError('invalid', `A field named "${name}" already exists or is already in this plan.`);
    resultingNames.add(name);
  }
  return { statements, warnings };
}

/** Converts a field form draft to one typed SQL Server migration operation. */
function normalizeSqlServerFieldDraft(
  snapshot: TableSnapshot,
  draft: SchemaFieldDraftRequest['draft'],
): SqlServerFieldOperation | null {
  const name = draft.name.trim();
  if (!name) throw new MigrationPlanError('invalid', 'Enter a field name.');
  validateIdentifier(name, 'field');
  const descriptor = SQLSERVER_EDITABLE_FIELD_TYPES.find(({ value }) => value === draft.type);
  if (!descriptor) throw new MigrationPlanError('invalid', 'Choose a field type supported by the connected SQL Server adapter.');
  const details = normalizeSqlServerTypeDetails(descriptor.value, draft.typeDetails.trim());
  const defaultValue = draft.defaultValue.trim();
  const defaultExpression = defaultValue && defaultValue !== '—'
    ? validateSqlServerDefaultExpression(defaultValue)
    : null;
  const requestedIdentity = draft.identityGeneration === undefined || draft.identityGeneration === 'none'
    ? null
    : draft.identityGeneration;

  if (draft.sourceName === null) {
    if (requestedIdentity && !supportsSqlServerIdentity(descriptor.value, details.numericScale)) {
      throw new MigrationPlanError('invalid', `SQL Server IDENTITY supports tinyint, smallint, integer, bigint, and Numeric with scale 0, not ${descriptor.label} with these parameters.`);
    }
    if (requestedIdentity === 'always') throw new MigrationPlanError('invalid', 'SQL Server uses IDENTITY generation and does not distinguish GENERATED ALWAYS from BY DEFAULT.');
    if (requestedIdentity && defaultExpression) {
      throw new MigrationPlanError('invalid', 'An IDENTITY field cannot also have a default. Clear the default before staging this field.');
    }
    return {
      kind: 'addNullableField', name, type: descriptor.value, typeDetails: draft.typeDetails.trim(),
      ...details, defaultExpression, identityGeneration: requestedIdentity,
    };
  }

  const field = snapshot.fields.find(({ name: fieldName }) => fieldName === draft.sourceName);
  if (!field) throw new MigrationPlanError('invalid', `The field "${draft.sourceName}" no longer exists. Refresh the table and try again.`);
  if (field.generated || field.identityGeneration) {
    throw new MigrationPlanError('invalid', `Generated or IDENTITY field "${draft.sourceName}" cannot be edited by this SQL Server migration.`);
  }
  if (!field.editable) throw new MigrationPlanError('invalid', `The SQL Server type for "${draft.sourceName}" is not supported by the field editor.`);
  if (requestedIdentity) {
    throw new MigrationPlanError('invalid', 'SQL Server cannot add IDENTITY to an existing field. Add a new IDENTITY field instead.');
  }
  const nullable = draft.nullable ?? field.nullable;
  if (name === field.name && sameSqlServerFieldType(field, { type: descriptor.value, ...details })
    && (field.defaultExpression?.trim() ?? null) === (defaultExpression?.trim() ?? null)
    && field.nullable === nullable) return null;
  return {
    kind: 'alterField', name: field.name, newName: name, type: descriptor.value,
    typeDetails: draft.typeDetails.trim(), ...details, defaultExpression, nullable, identityGeneration: null,
  };
}

/** Validates and normalizes size, precision, or temporal scale for an SQL Server field type. */
function normalizeSqlServerTypeDetails(
  type: string,
  details: string,
): { characterMaximumLength: number | null; numericPrecision: number | null; numericScale: number | null } {
  if (['varchar', 'nvarchar', 'varbinary'].includes(type)) {
    if (!details || details.toLowerCase() === 'max') return { characterMaximumLength: null, numericPrecision: null, numericScale: null };
    if (!/^\d+$/.test(details)) throw new MigrationPlanError('invalid', `For ${type}, enter a whole-number length or leave it blank for MAX.`);
    const length = Number(details);
    const maximum = type === 'nvarchar' ? 4000 : 8000;
    if (length < 1 || length > maximum) throw new MigrationPlanError('invalid', `${type} length must be between 1 and ${maximum}, or blank for MAX.`);
    return { characterMaximumLength: length, numericPrecision: null, numericScale: null };
  }
  if (['char', 'nchar', 'binary'].includes(type)) {
    if (!/^\d+$/.test(details)) throw new MigrationPlanError('invalid', `For ${type}, enter a whole-number length; this type does not support MAX.`);
    const length = Number(details);
    const maximum = type === 'nchar' ? 4000 : 8000;
    if (length < 1 || length > maximum) throw new MigrationPlanError('invalid', `${type} length must be between 1 and ${maximum}.`);
    return { characterMaximumLength: length, numericPrecision: null, numericScale: null };
  }
  if (type === 'numeric') {
    const match = details ? /^(\d+)(?:\s*,\s*(\d+))?$/.exec(details) : null;
    if (details && !match) throw new MigrationPlanError('invalid', 'For Numeric, enter precision and optional scale, such as 12, 2.');
    const precision = match ? Number(match[1]) : 18;
    const scale = match?.[2] === undefined ? 0 : Number(match[2]);
    if (precision < 1 || precision > 38 || scale < 0 || scale > precision) {
      throw new MigrationPlanError('invalid', 'SQL Server Numeric precision must be 1–38 and scale must be 0–precision.');
    }
    return { characterMaximumLength: null, numericPrecision: precision, numericScale: scale };
  }
  if (type === 'float') {
    if (details && !/^\d+$/.test(details)) throw new MigrationPlanError('invalid', 'For Float, enter a precision from 1 to 53.');
    const precision = details ? Number(details) : 53;
    if (precision < 1 || precision > 53) throw new MigrationPlanError('invalid', 'Float precision must be from 1 to 53.');
    return { characterMaximumLength: null, numericPrecision: precision, numericScale: null };
  }
  if (['datetime2', 'datetimeoffset', 'time'].includes(type)) {
    if (details && !/^\d+$/.test(details)) throw new MigrationPlanError('invalid', `For ${type}, enter a fractional-second scale from 0 to 7.`);
    const scale = details ? Number(details) : 7;
    if (scale < 0 || scale > 7) throw new MigrationPlanError('invalid', `${type} scale must be from 0 to 7.`);
    return { characterMaximumLength: null, numericPrecision: null, numericScale: scale };
  }
  if (details) throw new MigrationPlanError('invalid', `${SQLSERVER_EDITABLE_FIELD_TYPES.find(({ value }) => value === type)?.label ?? type} fields do not accept size or precision parameters.`);
  return { characterMaximumLength: null, numericPrecision: null, numericScale: null };
}

/** Formats a whitelisted SQL Server field type after validating its parameters. */
function formatSqlServerFieldType(
  operation: Pick<SqlServerFieldOperation, 'type' | 'characterMaximumLength' | 'numericPrecision' | 'numericScale'>,
): string {
  switch (operation.type) {
    case 'varchar': case 'nvarchar': case 'varbinary': {
      const length = operation.characterMaximumLength;
      const maximum = operation.type === 'nvarchar' ? 4000 : 8000;
      if (length !== null && length !== undefined && (!Number.isInteger(length) || length < 1 || length > maximum)) {
        throw new MigrationPlanError('invalid', `${operation.type} length must be between 1 and ${maximum}, or blank for MAX.`);
      }
      if (operation.numericPrecision != null || operation.numericScale != null) {
        throw new MigrationPlanError('invalid', `${operation.type} fields do not accept numeric precision or scale.`);
      }
      return `${operation.type}(${length ?? 'max'})`;
    }
    case 'char': case 'nchar': case 'binary': {
      const length = operation.characterMaximumLength;
      const maximum = operation.type === 'nchar' ? 4000 : 8000;
      if (length == null || !Number.isInteger(length) || length < 1 || length > maximum) {
        throw new MigrationPlanError('invalid', `${operation.type} length must be between 1 and ${maximum}.`);
      }
      if (operation.numericPrecision != null || operation.numericScale != null) {
        throw new MigrationPlanError('invalid', `${operation.type} fields do not accept numeric precision or scale.`);
      }
      return `${operation.type}(${length})`;
    }
    case 'numeric': {
      const precision = operation.numericPrecision ?? 18;
      const scale = operation.numericScale ?? 0;
      if (!Number.isInteger(precision) || precision < 1 || precision > 38
        || !Number.isInteger(scale) || scale < 0 || scale > precision) {
        throw new MigrationPlanError('invalid', 'SQL Server Numeric precision must be 1–38 and scale must be 0–precision.');
      }
      if (operation.characterMaximumLength != null) throw new MigrationPlanError('invalid', 'Numeric fields do not accept a character length.');
      return `decimal(${precision}, ${scale})`;
    }
    case 'float': {
      const precision = operation.numericPrecision ?? 53;
      if (!Number.isInteger(precision) || precision < 1 || precision > 53
        || operation.characterMaximumLength != null || operation.numericScale != null) {
        throw new MigrationPlanError('invalid', 'Float precision must be from 1 to 53.');
      }
      return `float(${precision})`;
    }
    case 'datetime2': case 'datetimeoffset': case 'time': {
      const scale = operation.numericScale ?? 7;
      if (!Number.isInteger(scale) || scale < 0 || scale > 7) throw new MigrationPlanError('invalid', `${operation.type} scale must be from 0 to 7.`);
      if (operation.characterMaximumLength != null || operation.numericPrecision != null) {
        throw new MigrationPlanError('invalid', `${operation.type} fields accept only a fractional-second scale.`);
      }
      return `${operation.type}(${scale})`;
    }
    case 'tinyint': case 'smallint': case 'integer': case 'bigint':
    case 'boolean': case 'uuid': case 'date': case 'real': case 'money': case 'smallmoney':
    case 'datetime': case 'smalldatetime': {
      if (operation.characterMaximumLength != null || operation.numericPrecision != null || operation.numericScale != null) {
        throw new MigrationPlanError('invalid', `${operation.type} fields do not accept size or precision parameters.`);
      }
      return ({ tinyint: 'tinyint', smallint: 'smallint', integer: 'int', bigint: 'bigint',
        boolean: 'bit', uuid: 'uniqueidentifier', date: 'date', real: 'real', money: 'money', smallmoney: 'smallmoney',
        datetime: 'datetime', smalldatetime: 'smalldatetime' } as const)[operation.type];
    }
    default: throw new MigrationPlanError('invalid', `The SQL Server field type "${operation.type}" is not supported by this migration.`);
  }
}

/** Compares a SQL Server field type and its dimensions to an edit operation. */
function sameSqlServerFieldType(
  field: TableFieldDescriptor,
  operation: Pick<SqlServerFieldOperation, 'type' | 'characterMaximumLength' | 'numericPrecision' | 'numericScale'>,
): boolean {
  if (field.editableType !== operation.type) return false;
  if (['varchar', 'nvarchar', 'char', 'nchar', 'varbinary', 'binary'].includes(operation.type)) {
    return field.characterMaximumLength === (operation.characterMaximumLength ?? null);
  }
  if (operation.type === 'numeric') {
    return field.numericPrecision === (operation.numericPrecision ?? 18)
      && field.numericScale === (operation.numericScale ?? 0);
  }
  if (operation.type === 'float') return field.numericPrecision === (operation.numericPrecision ?? 53);
  if (['datetime2', 'datetimeoffset', 'time'].includes(operation.type)) {
    return field.numericScale === (operation.numericScale ?? 7);
  }
  return true;
}

/** Rejects empty, overlong, multi-statement, or commented SQL Server default expressions. */
function validateSqlServerDefaultExpression(expression: string): string {
  const trimmed = expression.trim();
  if (!trimmed || trimmed.length > 2048 || /[;\u0000]|--|\/\*/.test(trimmed)) {
    throw new MigrationPlanError('invalid', 'Enter a single SQL Server default expression without statement separators or comments.');
  }
  return trimmed;
}

/** Escapes a value embedded as a Unicode SQL Server string literal. */
function escapeSqlServerString(value: string): string {
  return value.replaceAll("'", "''");
}

/** Removes inbound dependencies already scheduled for removal in the same batch. */
function unresolvedInboundForeignKeys(
  inbound: { schema: string; table: string; name: string }[],
  plannedDrops: Set<string>,
): { schema: string; table: string; name: string }[] {
  return inbound.filter(({ schema, table, name }) => !plannedDrops.has(JSON.stringify([schema, table, name])));
}

/** Creates a driver request bound to the active pool or transaction. */
function createRequest(executor: sql.ConnectionPool | sql.Transaction): sql.Request {
  return executor instanceof sql.Transaction ? new sql.Request(executor) : executor.request();
}

/** Checks one effective object permission through SQL Server's permission evaluator. */
async function readObjectPermission(
  executor: sql.ConnectionPool | sql.Transaction,
  schema: string,
  table: string,
  permission: 'REFERENCES' | 'ALTER',
): Promise<boolean> {
  const result = await createRequest(executor)
    .input('schema', sql.NVarChar(128), schema)
    .input('table', sql.NVarChar(128), table)
    .query<{ granted: boolean }>(`
      SELECT CONVERT(bit, COALESCE(HAS_PERMS_BY_NAME(QUOTENAME(@schema) + N'.' + QUOTENAME(@table), 'OBJECT', '${permission}'), 0)) AS granted;
    `);
  return Boolean(result.recordset[0]?.granted);
}

/** Lists catalog foreign keys that prevent dropping a table. */
async function readInboundForeignKeys(
  executor: sql.ConnectionPool | sql.Transaction,
  schema: string,
  table: string,
): Promise<{ schema: string; table: string; name: string }[]> {
  const result = await createRequest(executor)
    .input('schema', sql.NVarChar(128), schema)
    .input('table', sql.NVarChar(128), table)
    .query<{ schema: string; table: string; name: string }>(`
      SELECT sourceSchema.name AS [schema], sourceTable.name AS [table], fk.name
      FROM sys.foreign_keys fk
      JOIN sys.tables sourceTable ON sourceTable.object_id = fk.parent_object_id
      JOIN sys.schemas sourceSchema ON sourceSchema.schema_id = sourceTable.schema_id
      JOIN sys.tables targetTable ON targetTable.object_id = fk.referenced_object_id
      JOIN sys.schemas targetSchema ON targetSchema.schema_id = targetTable.schema_id
      WHERE targetSchema.name = @schema AND targetTable.name = @table;
    `);
  return result.recordset;
}

/** Converts common SQL Server DDL failures to actionable, safe Runbook messages. */
function sqlServerMigrationMessage(error: unknown): string {
  const candidate = typeof error === 'object' && error !== null ? error as { number?: number; message?: string } : {};
  if (candidate.number === 547) return 'SQL Server rejected the foreign-key change because existing rows violate the relationship or a referenced key is in use. Check the related data and try again.';
  if (candidate.number === 8111) return 'SQL Server cannot add the primary key because one or more selected fields are nullable. Make them NOT NULL and remove existing NULL values first.';
  if ([1505, 2601, 2627].includes(candidate.number ?? 0)) return 'SQL Server cannot add the key because existing rows contain duplicate key values. Remove or correct the duplicates, then apply again.';
  if (candidate.number === 1919) return 'SQL Server cannot use one of the selected field types in a primary or unique key. Choose indexable fields such as integer, UUID, or bounded text fields.';
  if (candidate.number === 1946) return 'SQL Server cannot add this key because the combined key fields exceed the database engine’s maximum index-key size. Use fewer or narrower fields.';
  if (candidate.number === 3726) return 'SQL Server cannot drop this table while another object still references it. Stage every referencing foreign key removal in the same Runbook.';
  if (candidate.number === 229) return 'SQL Server denied this schema operation. Check ALTER permission on the source table and REFERENCES permission on the target table.';
  if (candidate.number === 515) return 'SQL Server could not make the field NOT NULL because existing rows contain NULL values. Update those rows or keep the field nullable, then apply again.';
  if ([245, 8114, 8115].includes(candidate.number ?? 0)) return 'SQL Server could not convert the existing field values to the requested type. Choose a compatible type or update the data before applying.';
  if ([2628, 8152].includes(candidate.number ?? 0)) return 'SQL Server could not reduce the field size because one or more existing values would be truncated. Increase the size or update those values first.';
  if ([5074, 4922].includes(candidate.number ?? 0)) return 'SQL Server could not alter this field because an index, constraint, or other dependent object uses it. Review and remove or update the dependency before applying.';
  const detail = candidate.message?.replace(/\s+/g, ' ').trim();
  return detail ? `SQL Server rejected the reviewed schema change: ${detail}` : 'SQL Server rejected the reviewed schema change. Check the selected objects and database permissions.';
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
export const sqlServerInternals = {
  mapConstraints,
  rowVersion,
  quoteIdentifier,
  previewStatement,
  supportsTextRoundTrip,
  sqlServerTypesCompatible,
  addForeignKeyStatement,
  dropForeignKeyStatement,
  dropTableStatement,
  unresolvedInboundForeignKeys,
};
