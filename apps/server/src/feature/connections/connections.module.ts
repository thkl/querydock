import { Module } from '@nestjs/common';
import { ConnectionsController } from './connections.controller.js';
import { ConnectionSessionsService } from './connection-sessions.service.js';
import { PostgresAdapter } from '../postgres/postgres.adapter.js';
import { SqlServerAdapter } from '../sqlserver/sqlserver.adapter.js';

@Module({
  controllers: [ConnectionsController],
  providers: [ConnectionSessionsService, PostgresAdapter, SqlServerAdapter],
  exports: [ConnectionSessionsService],
})
export class ConnectionsModule {}
