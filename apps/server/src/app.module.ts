import { Module } from '@nestjs/common';
import { HealthController } from './feature/health/health.controller.js';
import { ConnectionsModule } from './feature/connections/connections.module.js';

@Module({
  controllers: [HealthController],
  imports: [ConnectionsModule],
})
export class AppModule {}
