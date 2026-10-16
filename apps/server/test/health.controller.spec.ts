import { describe, expect, it } from 'vitest';
import { HealthController } from '../src/feature/health/health.controller.ts';

describe('HealthController', () => {
  it('reports the service liveness status', () => {
    expect(new HealthController().getHealth()).toEqual({ status: 'ok' });
  });
});
