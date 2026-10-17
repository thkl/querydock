import {
  BadRequestException,
  BadGatewayException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  migrationApplyRequestSchema,
  migrationPreviewRequestSchema,
  foreignKeyFieldChoicesRequestSchema,
  schemaFieldDraftRequestSchema,
  databaseConnectRequestSchema,
  tableDataQueryRequestSchema,
  tableDataRowUpdateSchema,
  tableDataRowInsertSchema,
  tableDataRowDeleteSchema,
  dataRunbookPreviewRequestSchema,
  type ConnectResponse,
} from '@querydock/contracts';
import { ConnectionSessionsService } from './connection-sessions.service.js';
import { MigrationPlanError } from '../database/database-errors.js';
import { PostgresAdapter, PostgresConnectionError } from '../postgres/postgres.adapter.js';
import { SqlServerAdapter, SqlServerConnectionError } from '../sqlserver/sqlserver.adapter.js';

@Controller('connections')
export class ConnectionsController {
  constructor(
    private readonly sessions: ConnectionSessionsService,
    private readonly postgres: PostgresAdapter,
    private readonly sqlserver: SqlServerAdapter,
  ) {}

  /** Validates settings, verifies database access, and creates a session-scoped connection. */
  @Post()
  async connect(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ConnectResponse> {
    const parsed = databaseConnectRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid database connection settings.');

    let verified;
    try {
      verified = parsed.data.adapter === 'postgresql'
        ? await this.postgres.verifyConnection(parsed.data)
        : await this.sqlserver.verifyConnection(parsed.data);
    } catch (error) {
      throw this.asSafeDatabaseException(error);
    }
    return this.sessions.addConnection(request, response, parsed.data, {
      target: {
        adapter: parsed.data.adapter,
        host: parsed.data.host,
        port: parsed.data.port,
        database: parsed.data.database,
        username: parsed.data.username,
      },
      serverVersion: verified.serverVersion,
      capabilities: parsed.data.adapter === 'postgresql' ? {
        discoverResources: true, inspectTables: true, browseData: true, mutateData: true, editSchema: true, executeSql: false,
      } : {
        discoverResources: true, inspectTables: true, browseData: true, mutateData: true, editSchema: false, executeSql: false,
      },
      schemaCapabilities: parsed.data.adapter === 'postgresql' ? this.postgres.schemaCapabilities() : this.sqlserver.schemaCapabilities(),
    });
  }

  /** Returns the active connection summaries for the browser session. */
  @Get()
  listConnections(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): ConnectResponse[] {
    return this.sessions.listConnections(request, response);
  }

  /** Lists visible tables and views through the configured database adapter. */
  @Get(':connectionId/resources')
  async listResources(
    @Param('connectionId') connectionId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const configuration = this.sessions.requireConnection(request, response, connectionId);
    try {
      return configuration.adapter === 'postgresql'
        ? await this.postgres.listResources(configuration)
        : await this.sqlserver.listResources(configuration);
    } catch (error) {
      throw this.asSafeDatabaseException(error);
    }
  }

  /** Returns server-defined field types for schema editing after checking session ownership. */
  @Get(':connectionId/schema/field-types')
  editableFieldTypes(
    @Param('connectionId') connectionId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const configuration = this.sessions.requireConnection(request, response, connectionId);
    return configuration.adapter === 'postgresql'
      ? this.postgres.editableFieldTypes()
      : this.sqlserver.editableFieldTypes();
  }

  /** Inspects a visible table and maps absence or database failures to safe HTTP errors. */
  @Get(':connectionId/tables')
  async inspectTable(
    @Param('connectionId') connectionId: string,
    @Query('schema') schema: unknown,
    @Query('table') table: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (typeof schema !== 'string' || typeof table !== 'string') {
      throw new BadRequestException('Provide a schema and table name.');
    }

    const configuration = this.sessions.requireConnection(request, response, connectionId);
    try {
      const snapshot = configuration.adapter === 'postgresql'
        ? await this.postgres.inspectTable(configuration, schema, table)
        : await this.sqlserver.inspectTable(configuration, schema, table);
      if (!snapshot) throw new NotFoundException('The requested table was not found or is not visible to this user.');
      return snapshot;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      if (error instanceof MigrationPlanError) throw this.asMigrationException(error);
      throw this.asSafeDatabaseException(error);
    }
  }

  /** Reads one bounded, filtered page of table rows through a read-only adapter operation. */
  @Post(':connectionId/tables/:schema/:table/data/query')
  @HttpCode(200)
  async queryTableData(
    @Param('connectionId') connectionId: string,
    @Param('schema') schema: string,
    @Param('table') table: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const parsed = tableDataQueryRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid table data query. Choose a page size up to 100 rows and valid filters.');
    const configuration = this.sessions.requireConnection(request, response, connectionId);
    try {
      return configuration.adapter === 'postgresql'
        ? await this.postgres.queryTableData(configuration, schema, table, parsed.data)
        : await this.sqlserver.queryTableData(configuration, schema, table, parsed.data);
    } catch (error) {
      if (error instanceof MigrationPlanError) throw this.asMigrationException(error);
      throw this.asSafeDatabaseException(error);
    }
  }

  /** Saves one completed data-grid row edit without staging it in the schema runbook. */
  @Post(':connectionId/tables/:schema/:table/data/update-row')
  @HttpCode(204)
  async updateTableDataRow(
    @Param('connectionId') connectionId: string,
    @Param('schema') schema: string,
    @Param('table') table: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const parsed = tableDataRowUpdateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid table row update. Refresh the row and submit a completed row edit.');
    const configuration = this.sessions.requireConnection(request, response, connectionId);
    try {
      if (configuration.adapter === 'postgresql') await this.postgres.updateTableDataRow(configuration, schema, table, parsed.data);
      else await this.sqlserver.updateTableDataRow(configuration, schema, table, parsed.data);
    } catch (error) {
      if (error instanceof MigrationPlanError) throw this.asMigrationException(error);
      throw this.asSafeDatabaseException(error);
    }
  }

  /** Deletes one existing row through the active database adapter. */
  @Post(':connectionId/tables/:schema/:table/data/delete-row')
  @HttpCode(204)
  async deleteTableDataRow(
    @Param('connectionId') connectionId: string,
    @Param('schema') schema: string,
    @Param('table') table: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const parsed = tableDataRowDeleteSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid table row delete. Refresh the row and submit its current primary key and version.');
    const configuration = this.sessions.requireConnection(request, response, connectionId);
    try {
      if (configuration.adapter === 'postgresql') await this.postgres.deleteTableDataRow(configuration, schema, table, parsed.data);
      else await this.sqlserver.deleteTableDataRow(configuration, schema, table, parsed.data);
    } catch (error) {
      if (error instanceof MigrationPlanError) throw this.asMigrationException(error);
      throw this.asSafeDatabaseException(error);
    }
  }

  /** Generates SQL for staged row operations without changing database data. */
  @Post(':connectionId/tables/:schema/:table/data/runbook-preview')
  async previewDataRunbook(
    @Param('connectionId') connectionId: string,
    @Param('schema') schema: string,
    @Param('table') table: string,
    @Query('dryRun') dryRun: string | undefined,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (dryRun !== 'true') throw new BadRequestException('Set dryRun=true to generate a non-mutating data Runbook preview.');
    const parsed = dataRunbookPreviewRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid data Runbook preview. Refresh the table and submit valid row operations.');
    const configuration = this.sessions.requireConnection(request, response, connectionId);
    try {
      return configuration.adapter === 'postgresql'
        ? await this.postgres.previewDataRunbook(configuration, schema, table, parsed.data.operations)
        : await this.sqlserver.previewDataRunbook(configuration, schema, table, parsed.data.operations);
    } catch (error) {
      if (error instanceof MigrationPlanError) throw this.asMigrationException(error);
      throw this.asSafeDatabaseException(error);
    }
  }

  /** Inserts one completed grid row through the active database role. */
  @Post(':connectionId/tables/:schema/:table/data/insert-row')
  @HttpCode(204)
  async insertTableDataRow(
    @Param('connectionId') connectionId: string,
    @Param('schema') schema: string,
    @Param('table') table: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const parsed = tableDataRowInsertSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid new table row. Enter valid values and submit the completed row.');
    const configuration = this.sessions.requireConnection(request, response, connectionId);
    try {
      if (configuration.adapter === 'postgresql') await this.postgres.insertTableDataRow(configuration, schema, table, parsed.data);
      else await this.sqlserver.insertTableDataRow(configuration, schema, table, parsed.data);
    } catch (error) {
      if (error instanceof MigrationPlanError) throw this.asMigrationException(error);
      throw this.asSafeDatabaseException(error);
    }
  }

  /** Returns compatible and incompatible unique-key targets for a proposed foreign key. */
  @Post(':connectionId/tables/:schema/:table/foreign-key-targets/:targetSchema/:targetTable/fields')
  async foreignKeyFieldChoices(
    @Param('connectionId') connectionId: string,
    @Param('schema') schema: string,
    @Param('table') table: string,
    @Param('targetSchema') targetSchema: string,
    @Param('targetTable') targetTable: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const parsed = foreignKeyFieldChoicesRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Choose one or more local fields for the foreign key.');
    const configuration = this.sessions.requireConnection(request, response, connectionId);
    if (configuration.adapter !== 'postgresql') {
      throw new BadRequestException('SQL Server schema and relationship editing is not enabled yet.');
    }
    try {
      return await this.postgres.foreignKeyFieldChoices(configuration, schema, table, targetSchema, targetTable, parsed.data.localFieldNames);
    } catch (error) {
      if (error instanceof MigrationPlanError) throw this.asMigrationException(error);
      throw this.asSafeDatabaseException(error);
    }
  }

  /** Produces SQL and warnings for the submitted schema operations without applying them. */
  @Post(':connectionId/migrations/preview')
  @HttpCode(200)
  async previewMigration(
    @Param('connectionId') connectionId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const parsed = migrationPreviewRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid schema migration preview request.');
    const configuration = this.sessions.requireConnection(request, response, connectionId);
    try {
      return configuration.adapter === 'postgresql'
        ? await this.postgres.previewMigration(configuration, parsed.data)
        : await this.sqlserver.previewMigration(configuration, parsed.data);
    } catch (error) {
      throw this.asMigrationException(error);
    }
  }

  /** Validates a field editor draft and returns the resulting migration preview. */
  @Post(':connectionId/migrations/field-draft')
  @HttpCode(200)
  async previewSchemaFieldDraft(
    @Param('connectionId') connectionId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const parsed = schemaFieldDraftRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid schema field draft request.');
    const configuration = this.sessions.requireConnection(request, response, connectionId);
    if (configuration.adapter !== 'postgresql') throw new BadRequestException('SQL Server schema editing is not enabled yet.');
    try {
      return await this.postgres.previewSchemaFieldDraft(configuration, parsed.data);
    } catch (error) {
      throw this.asMigrationException(error);
    }
  }

  /** Applies only the exact reviewed statements and warnings accepted by the client. */
  @Post(':connectionId/migrations/apply')
  @HttpCode(200)
  async applyMigration(
    @Param('connectionId') connectionId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const parsed = migrationApplyRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid schema migration apply request.');
    const configuration = this.sessions.requireConnection(request, response, connectionId);
    try {
      return configuration.adapter === 'postgresql'
        ? await this.postgres.applyMigration(configuration, parsed.data)
        : await this.sqlserver.applyMigration(configuration, parsed.data);
    } catch (error) {
      throw this.asMigrationException(error);
    }
  }

  /** Closes a connection owned by the current session. */
  @Delete(':connectionId')
  @HttpCode(204)
  disconnect(
    @Param('connectionId') connectionId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): void {
    this.sessions.removeConnection(request, response, connectionId);
  }

  /** Converts driver failures to a generic message, exposing only adapter-approved text. */
  private asSafeDatabaseException(error: unknown): BadGatewayException {
    const message = error instanceof PostgresConnectionError || error instanceof SqlServerConnectionError
      ? error.safeMessage
      : 'The database request failed. Check the connection and database permissions.';
    return new BadGatewayException(message);
  }

  /** Maps migration validation, drift, visibility, and unexpected failures to HTTP status codes. */
  private asMigrationException(error: unknown): BadGatewayException | BadRequestException | ConflictException | NotFoundException | InternalServerErrorException {
    if (error instanceof MigrationPlanError) {
      if (error.kind === 'not-found') return new NotFoundException(error.message);
      if (error.kind === 'drift') return new ConflictException(error.message);
      if (error.kind === 'unknown') return new InternalServerErrorException(error.message);
      return new BadRequestException(error.message);
    }
    return this.asSafeDatabaseException(error);
  }
}
