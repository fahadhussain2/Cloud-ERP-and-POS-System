// Pipeline steps from docs/05-LEGACY-MIGRATION.md; implemented in W0-12 and W0-13.
export const steps = ['parse', 'stage', 'transform', 'report', 'load'] as const;

export function usage(): string {
  return [
    'Usage: legacy-import <step> [--dry-run]',
    '',
    `Steps: ${steps.join(', ')}`,
    'Not implemented yet (W0-12, W0-13).',
  ].join('\n');
}
