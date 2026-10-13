import { Module } from '@nestjs/common';
import { HealthController } from './feature/health/health.controller.js';

@Module({
  controllers: [HealthController],
})
export class AppModule {}
