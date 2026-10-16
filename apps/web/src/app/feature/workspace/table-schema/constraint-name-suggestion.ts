/** Builds a PostgreSQL-friendly suggested constraint identifier from a field name. */
export function suggestConstraintName(prefix: 'pk' | 'chk', fieldName: string): string {
  const normalized = fieldName.trim().toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized ? `${prefix}_${normalized}` : '';
}
