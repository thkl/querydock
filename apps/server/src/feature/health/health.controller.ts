import { Controller, Get } from '@nestjs/common';

@Controller()
export class HealthController {
  /** Returns the liveness status used by container and proxy health checks. */
  @Get('health')
  getHealth(): { status: string } {
    return { status: 'ok' };
  }
}
