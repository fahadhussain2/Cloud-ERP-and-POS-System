// Pipeline steps from docs/05-LEGACY-MIGRATION.md §2 and the importer spec (W0-12 parse and stage, W0-13 the rest).
export const steps = ['parse', 'stage', 'transform', 'report', 'load'] as const;
export type Step = (typeof steps)[number];

export interface Args {
  step: Step;
  label: string;
  /** The dump folder; null = sql_dump/ at the repo root. */
  dump: string | null;
  /** The shop code to load into; its decisions are mapping/<tenant>.json. */
  tenant: string;
  dryRun: boolean;
}

export function usage(): string {
  return [
    'Usage: legacy-import <step> --label <label> [--dump <folder>] [--tenant <shop>] [--dry-run]',
    '',
    `Steps: ${steps.join(', ')}`,
    '  stage      parse every .sql file of the dump into legacy_<label> (erp_legacy database);',
    '             parsing runs as part of staging',
    '  transform  apply the mapping rules and write the cleanup reports; nothing is loaded',
    '  report     the same as transform',
    '  load       transform, load the masters into the shop (local erp_dev) and write the reports;',
    '             with --dry-run, compare only',
    '',
    'The label names the dump copy, e.g. dec2025. The default folder is sql_dump/ at the repo root,',
    'and the default shop is delux.',
  ].join('\n');
}

const OPTIONS = new Set(['--label', '--dump', '--tenant']);

export function parseArgs(argv: string[]): Args | { error: string } {
  const [step, ...rest] = argv;
  if (!step) return { error: 'which step?' };
  if (!(steps as readonly string[]).includes(step)) return { error: `unknown step ${step}` };
  const options: Record<string, string> = {};
  let dryRun = false;
  for (let i = 0; i < rest.length; i++) {
    const [flag, inline] = rest[i]!.split(/=(.*)/s, 2) as [string, string | undefined];
    if (flag === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (!OPTIONS.has(flag)) return { error: `unknown option ${flag}` };
    const value = inline ?? rest[++i];
    if (value === undefined) return { error: `${flag} needs a value` };
    options[flag] = value;
  }
  const label = options['--label'];
  if (label === undefined) return { error: '--label is required' };
  return {
    step: step as Step,
    label,
    dump: options['--dump'] ?? null,
    tenant: options['--tenant'] ?? 'delux',
    dryRun,
  };
}
