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
  postgresConnectRequestSchema,
  tableDataQueryRequestSchema,
  type ConnectResponse,
} from '@querydock/contracts';
import { ConnectionSessionsService } from './connection-sessions.service.js';
import { MigrationPlanError, PostgresAdapter, PostgresConnectionError } from '../postgres/postgres.adapter.js';

const postgresCapabilities = {
  discoverResources: true,
  inspectTables: true,
  browseData: true,
  mutateData: false,
  editSchema: true,
  executeSql: false,
} as const;

@Controller('connections')
export class ConnectionsController {
  constructor(
    private readonly sessions: ConnectionSessionsService,
    private readonly postgres: PostgresAdapter,
  ) {}

  @Post()
  async connect(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ConnectResponse> {
    const parsed = postgresConnectRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid PostgreSQL connection settings.');

    let verified;
    try {
      verified = await this.postgres.verifyConnection(parsed.data);
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
      capabilities: postgresCapabilities,
      schemaCapabilities: this.postgres.schemaCapabilities(),
    });
  }

  @Get()
  listConnections(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): ConnectResponse[] {
    return this.sessions.listConnections(request, response);
  }

  @Get(':connectionId/resources')
  async listResources(
    @Param('connectionId') connectionId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const configuration = this.sessions.requireConnection(request, response, connectionId);
    try {
      return await this.postgres.listResources(configuration);
    } catch (error) {
      throw this.asSafeDatabaseException(error);
    }
  }

  @Get(':connectionId/schema/field-types')
  editableFieldTypes(
    @Param('connectionId') connectionId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.sessions.requireConnection(request, response, connectionId);
    return this.postgres.editableFieldTypes();
  }

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
      const snapshot = await this.postgres.inspectTable(configuration, schema, table);
      if (!snapshot) throw new NotFoundException('The requested table was not found or is not visible to this user.');
      return snapshot;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      if (error instanceof MigrationPlanError) throw this.asMigrationException(error);
      throw this.asSafeDatabaseException(error);
    }
  }

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
      return await this.postgres.queryTableData(configuration, schema, table, parsed.data);
    } catch (error) {
      if (error instanceof MigrationPlanError) throw this.asMigrationException(error);
      throw this.asSafeDatabaseException(error);
    }
  }

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
    try {
      return await this.postgres.foreignKeyFieldChoices(
        configuration, schema, table, targetSchema, targetTable, parsed.data.localFieldNames,
      );
    } catch (error) {
      if (error instanceof MigrationPlanError) throw this.asMigrationException(error);
      throw this.asSafeDatabaseException(error);
    }
  }

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
      return await this.postgres.previewMigration(configuration, parsed.data);
    } catch (error) {
      throw this.asMigrationException(error);
    }
  }

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
    try {
      return await this.postgres.previewSchemaFieldDraft(configuration, parsed.data);
    } catch (error) {
      throw this.asMigrationException(error);
    }
  }

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
      return await this.postgres.applyMigration(configuration, parsed.data);
    } catch (error) {
      throw this.asMigrationException(error);
    }
  }

  @Delete(':connectionId')
  @HttpCode(204)
  disconnect(
    @Param('connectionId') connectionId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): void {
    this.sessions.removeConnection(request, response, connectionId);
  }

  private asSafeDatabaseException(error: unknown): BadGatewayException {
    const message = error instanceof PostgresConnectionError
      ? error.safeMessage
      : 'The PostgreSQL request failed. Check the connection and database permissions.';
    return new BadGatewayException(message);
  }

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
