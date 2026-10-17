/** A classified database-plan failure used for consistent API status mapping. */
export class MigrationPlanError extends Error {
  constructor(
    readonly kind: 'not-found' | 'drift' | 'review-mismatch' | 'invalid' | 'unknown',
    message: string,
  ) {
    super(message);
    this.name = 'MigrationPlanError';
  }
}
