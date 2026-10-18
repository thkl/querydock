import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import type {
  DatabasePermissionReport,
  MysqlConnectRequest,
  ResourceDescriptor,
  TableDataQueryRequest,
  TableDataQueryResponse,
  TableConstraintDescriptor,
  TableSnapshot,
} from '@querydock/contracts';
import { MigrationPlanError } from '../database/database-errors.js';

interface MysqlRow extends RowDataPacket {
  [key: string]: unknown;
}

/** Safe connection error used by the API without exposing credentials or SQL. */
export class MysqlConnectionError extends Error {
  constructor(message: string, readonly safeMessage: string) {
    super(message);
    this.name = 'MysqlConnectionError';
  }
}

/** Initial MySQL adapter: connection, discovery, schema inspection, and read-only browsing. */
export class MysqlAdapter {
  private readonly logger = new Logger(MysqlAdapter.name);

  schemaCapabilities() { return { createTableIfNotExists: false }; }
  editableFieldTypes() { return []; }

  async verifyConnection(configuration: MysqlConnectRequest): Promise<{ serverVersion: string }> {
    return this.withConnection(configuration, async (connection) => {
      const [rows] = await connection.query<MysqlRow[]>('SELECT VERSION() AS serverVersion');
      return { serverVersion: String(rows[0]?.['serverVersion'] ?? 'unknown') };
    });
  }

  async inspectPermissions(configuration: MysqlConnectRequest): Promise<DatabasePermissionReport> {
    return this.withConnection(configuration, async (connection) => {
      const [identity] = await connection.query<MysqlRow[]>('SELECT DATABASE() AS databaseName, CURRENT_USER() AS currentUser');
      const database = String(identity[0]?.['databaseName'] ?? configuration.database);
      const currentUser = String(identity[0]?.['currentUser'] ?? configuration.username);
      const resources = await this.listResourcesWithConnection(connection, database);
      const schemas = [{
        name: database,
        privileges: [{ name: 'DATABASE ACCESS', granted: true }],
        objects: resources.map((resource) => ({
          name: resource.name,
          kind: resource.kind === 'view' ? 'view' as const : 'table' as const,
          privileges: [
            { name: 'SELECT', granted: resource.canBrowseData === true },
            { name: 'INSERT', granted: false },
            { name: 'UPDATE', granted: false },
            { name: 'DELETE', granted: false },
            { name: 'ALTER', granted: false },
          ],
        })),
      }];
      return {
        adapter: 'mysql', database, currentUser, serverUser: null,
        databasePrivileges: [{ name: 'CONNECT', granted: true }], schemas,
      };
    });
  }

  async listResources(configuration: MysqlConnectRequest): Promise<ResourceDescriptor[]> {
    return this.withConnection(configuration, (connection) => this.listResourcesWithConnection(connection, configuration.database));
  }

  async inspectTable(configuration: MysqlConnectRequest, schema: string, table: string): Promise<TableSnapshot | undefined> {
    assertIdentifier(schema, 'database');
    assertIdentifier(table, 'table');
    if (schema !== configuration.database) return undefined;
    return this.withConnection(configuration, (connection) => this.inspectWithConnection(connection, schema, table));
  }

  async queryTableData(configuration: MysqlConnectRequest, schema: string, table: string, query: TableDataQueryRequest): Promise<TableDataQueryResponse> {
    assertIdentifier(schema, 'database');
    assertIdentifier(table, 'table');
    return this.withConnection(configuration, async (connection) => {
      const snapshot = await this.inspectWithConnection(connection, schema, table);
      if (!snapshot) throw new MigrationPlanError('not-found', 'The requested table was not found or is not visible to this user.');
      const names = new Set(snapshot.fields.map(({ name }) => name));
      for (const item of [...query.sort, ...query.filters]) {
        if (!names.has(item.field)) throw new MigrationPlanError('invalid', `The field "${item.field}" is not part of this table.`);
      }
      const values: unknown[] = [];
      const predicates = query.filters.map((filter) => {
        const field = quoteIdentifier(filter.field);
        switch (filter.operator) {
          case 'isNull': return `${field} IS NULL`;
          case 'isNotNull': return `${field} IS NOT NULL`;
          case 'between': values.push(filter.value ?? '', filter.secondValue ?? ''); return `${field} BETWEEN ? AND ?`;
          case 'in': {
            const set = filter.values ?? [];
            if (!set.length) return '1 = 0';
            values.push(...set);
            return `${field} IN (${set.map(() => '?').join(', ')})`;
          }
          case 'contains': case 'notContains': case 'startsWith': case 'endsWith': {
            const raw = filter.value ?? '';
            const escaped = raw.replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_');
            const pattern = filter.operator === 'startsWith' ? `${escaped}%` : filter.operator === 'endsWith' ? `%${escaped}` : `%${escaped}%`;
            values.push(pattern);
            return `${field} ${filter.operator === 'notContains' ? 'NOT LIKE' : 'LIKE'} ? ESCAPE '!'`;
          }
          default: {
            const operator = ({ eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' } as const)[filter.operator];
            if (!operator) throw new MigrationPlanError('invalid', 'This filter is not supported by MySQL.');
            values.push(filter.value ?? '');
            return `${field} ${operator} ?`;
          }
        }
      });
      const quick = query.quickFilter.trim();
      if (quick && snapshot.fields.length) {
        const like = `%${quick.replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_')}%`;
        predicates.push(`(${snapshot.fields.map(({ name }) => { values.push(like); return `CAST(${quoteIdentifier(name)} AS CHAR) LIKE ? ESCAPE '!'`; }).join(' OR ')})`);
      }
      const where = predicates.length ? ` WHERE ${predicates.join(' AND ')}` : '';
      const [counts] = await connection.query<MysqlRow[]>(`SELECT COUNT(*) AS total FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)}${where}`, values);
      const totalRows = Number(counts[0]?.['total'] ?? 0);
      if (!Number.isSafeInteger(totalRows)) throw new MigrationPlanError('invalid', 'This table has too many rows to browse safely in the current grid.');
      const order = new Map<string, 'ASC' | 'DESC'>();
      for (const sort of query.sort) order.set(sort.field, sort.direction === 'desc' ? 'DESC' : 'ASC');
      const primaryKey = snapshot.constraints.find(({ kind }) => kind === 'primaryKey')?.fieldNames ?? [];
      for (const field of primaryKey.length ? primaryKey : snapshot.fields.map(({ name }) => name)) if (!order.has(field)) order.set(field, 'ASC');
      const orderSql = order.size ? ` ORDER BY ${[...order].map(([name, dir]) => `${quoteIdentifier(name)} ${dir}`).join(', ')}` : '';
      const pageValues = [...values, query.limit, query.offset];
      const [rows] = await connection.query<MysqlRow[]>(`SELECT * FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)}${where}${orderSql} LIMIT ? OFFSET ?`, pageValues);
      return {
        columns: snapshot.fields.map((field) => ({ ordinalPosition: field.ordinalPosition, name: field.name, dataType: field.dataType, nullable: field.nullable, editable: false, insertable: false })),
        rows: rows.map((row) => Object.fromEntries(snapshot.fields.map(({ name }) => [name, normalizeValue(row[name])]))),
        keyFields: [], rowVersions: [], canUpdateRows: false, canInsertRows: false, canDeleteRows: false, totalRows,
      };
    });
  }

  async foreignKeyFieldChoices(): Promise<{ fieldSets: [] }> { return { fieldSets: [] }; }
  async previewSchemaFieldDraft(): Promise<never> { return this.unsupported(); }
  async previewMigration(): Promise<never> { return this.unsupported(); }
  async applyMigration(): Promise<never> { return this.unsupported(); }
  async updateTableDataRow(..._args: unknown[]): Promise<never> { return this.unsupported(); }
  async insertTableDataRow(..._args: unknown[]): Promise<never> { return this.unsupported(); }
  async deleteTableDataRow(..._args: unknown[]): Promise<never> { return this.unsupported(); }
  async previewDataRunbook(..._args: unknown[]): Promise<never> { return this.unsupported(); }

  private unsupported(): never {
    throw new MigrationPlanError('invalid', 'MySQL schema changes and data writes are not supported by this adapter yet.');
  }

  private async listResourcesWithConnection(connection: mysql.Connection, database: string): Promise<ResourceDescriptor[]> {
    const [rows] = await connection.query<MysqlRow[]>(`
      SELECT TABLE_SCHEMA AS schemaName, TABLE_NAME AS name, TABLE_TYPE AS tableType
      FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME
    `, [database]);
    return rows.map((row) => ({ schema: String(row['schemaName']), name: String(row['name']), kind: row['tableType'] === 'VIEW' ? 'view' : 'table', isUpdatable: false, canBrowseData: true, canCreateTable: false }));
  }

  private async inspectWithConnection(connection: mysql.Connection, schema: string, table: string): Promise<TableSnapshot | undefined> {
    const [rows] = await connection.query<MysqlRow[]>(`
      SELECT COLUMN_NAME AS name, ORDINAL_POSITION AS ordinalPosition, DATA_TYPE AS typeName,
        COLUMN_TYPE AS columnType, IS_NULLABLE AS isNullable, COLUMN_DEFAULT AS defaultValue,
        EXTRA AS extra, GENERATION_EXPRESSION AS generationExpression,
        CHARACTER_MAXIMUM_LENGTH AS characterMaximumLength, NUMERIC_PRECISION AS numericPrecision,
        NUMERIC_SCALE AS numericScale
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION
    `, [schema, table]);
    if (!rows.length) return undefined;
    const fields = rows.map((row) => {
      const typeName = String(row['typeName']);
      const extra = String(row['extra'] ?? '').toLowerCase();
      const generated = Boolean(row['generationExpression']);
      return {
        ordinalPosition: Number(row['ordinalPosition']), name: String(row['name']), typeSchema: schema,
        typeName, dataType: String(row['columnType']), editableType: null, editable: false, identityEditable: false,
        characterMaximumLength: row['characterMaximumLength'] === null ? null : Number(row['characterMaximumLength']),
        numericPrecision: row['numericPrecision'] === null ? null : Number(row['numericPrecision']),
        numericScale: row['numericScale'] === null ? null : Number(row['numericScale']),
        nullable: row['isNullable'] === 'YES', defaultExpression: row['defaultValue'] === null ? null : String(row['defaultValue']),
        identityGeneration: extra.includes('auto_increment') ? 'byDefault' as const : null, generated,
        generationExpression: generated ? String(row['generationExpression']) : null,
      };
    });
    const [constraintsRows] = await connection.query<MysqlRow[]>(`
      SELECT tc.CONSTRAINT_NAME AS constraintName, tc.CONSTRAINT_TYPE AS constraintType,
        kcu.COLUMN_NAME AS fieldName, kcu.ORDINAL_POSITION AS ordinalPosition,
        kcu.REFERENCED_TABLE_SCHEMA AS referencedSchema, kcu.REFERENCED_TABLE_NAME AS referencedTable,
        kcu.REFERENCED_COLUMN_NAME AS referencedField
      FROM information_schema.TABLE_CONSTRAINTS tc
      LEFT JOIN information_schema.KEY_COLUMN_USAGE kcu ON kcu.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
        AND kcu.TABLE_NAME = tc.TABLE_NAME AND kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
      WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ? ORDER BY tc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION
    `, [schema, table]);
    const grouped = new Map<string, MysqlRow[]>();
    for (const row of constraintsRows) {
      const key = String(row['constraintName']);
      grouped.set(key, [...(grouped.get(key) ?? []), row]);
    }
    const constraints: TableConstraintDescriptor[] = [...grouped].flatMap(([name, items]) => {
      const rawType = String(items[0]?.['constraintType'] ?? '');
      const kind: TableConstraintDescriptor['kind'] | null = rawType === 'PRIMARY KEY' ? 'primaryKey' : rawType === 'UNIQUE' ? 'unique' : rawType === 'FOREIGN KEY' ? 'foreignKey' : null;
      if (!kind) return [];
      return [{ name, kind, editable: false, fieldNames: items.map((row) => String(row['fieldName'] ?? '')).filter(Boolean), definition: '', referencedSchema: items[0]?.['referencedSchema'] ? String(items[0]['referencedSchema']) : null, referencedTable: items[0]?.['referencedTable'] ? String(items[0]['referencedTable']) : null, referencedFieldNames: items.map((row) => row['referencedField'] ? String(row['referencedField']) : '').filter(Boolean) }];
    });
    const kind = await this.resourceKind(connection, schema, table);
    const fingerprint = createHash('sha256').update(JSON.stringify({ schema, table, fields, constraints })).digest('hex');
    return { schema, name: table, kind, canAlter: false, canBrowseData: true, canEditFields: false, canEditConstraints: false, canRenameTable: false, canDropTable: false, fingerprint, editableFieldTypes: [], editableConstraintKinds: [], editableIdentityGenerations: [], fields, constraints };
  }

  private async resourceKind(connection: mysql.Connection, schema: string, table: string): Promise<'table' | 'view'> {
    const [rows] = await connection.query<MysqlRow[]>('SELECT TABLE_TYPE AS tableType FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [schema, table]);
    return rows[0]?.['tableType'] === 'VIEW' ? 'view' : 'table';
  }

  private async withConnection<T>(configuration: MysqlConnectRequest, operation: (connection: mysql.Connection) => Promise<T>): Promise<T> {
    assertAllowedHost(configuration.host);
    let connection: mysql.Connection | undefined;
    try {
      connection = await mysql.createConnection({ host: configuration.host, port: configuration.port, database: configuration.database, user: configuration.username, password: configuration.password, connectTimeout: 8000, charset: 'utf8mb4', supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, ...(configuration.ssl ? { ssl: {} } : {}) });
      return await operation(connection);
    } catch (error) {
      if (error instanceof MigrationPlanError) throw error;
      this.logger.debug(`MySQL request failed: ${driverCode(error)}`);
      throw new MysqlConnectionError(driverCode(error), safeMysqlMessage(error));
    } finally {
      await connection?.end().catch(() => undefined);
    }
  }
}

function quoteIdentifier(value: string): string { return `\`${value.replaceAll('`', '``')}\``; }
function assertIdentifier(value: string, label: string): void {
  if (!value || value.length > 64 || value.includes('\0')) throw new MigrationPlanError('invalid', `Invalid MySQL ${label} name.`);
}
function normalizeValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value.toString('hex');
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
function driverCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : 'unknown';
}
function safeMysqlMessage(error: unknown): string {
  const code = driverCode(error);
  if (code === 'ER_ACCESS_DENIED_ERROR') return 'MySQL authentication failed. Check the username and password.';
  if (['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'PROTOCOL_CONNECTION_LOST'].includes(code)) return 'Could not reach MySQL. Check the host, port, and network settings.';
  if (code === 'ER_BAD_DB_ERROR') return 'MySQL could not select that database. Check its name and this account’s permissions.';
  return 'The MySQL request failed. Check the connection and database permissions.';
}
function assertAllowedHost(host: string): void {
  const configured = process.env['QUERYDOCK_ALLOWED_DATABASE_HOSTS']?.trim();
  if (!configured) return;
  const normalize = (value: string) => value.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!new Set(configured.split(',').map(normalize)).has(normalize(host))) throw new MysqlConnectionError('Host denied by server allow list', 'This database host is not allowed by the server configuration.');
}
