// Pipeline steps from docs/05-LEGACY-MIGRATION.md §2 and the importer spec (W0-12 parse and stage, W0-13 the rest,
// W1-14 the opening balances).
export const steps = ['parse', 'stage', 'transform', 'report', 'load', 'opening'] as const;
export type Step = (typeof steps)[number];

export interface Args {
  step: Step;
  label: string;
  /** The dump folder; null = sql_dump/ at the repo root. */
  dump: string | null;
  /** The shop code to load into; its decisions are mapping/<tenant>.json. */
  tenant: string;
  dryRun: boolean;
  /** The opening step only (W1-14): the legacy cutoff, the date it posts on, and whether to post the draft. */
  opening?: { asOf: string; date: string; post: boolean };
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
    '  opening    --as-of <YYYY-MM-DD> --date <YYYY-MM-DD> [--post]: work out the opening balances as of the',
    '             legacy cutoff, write them as a draft dated --date, and the reconciliation report; --post posts',
    '             the draft (once); --dry-run writes the reports only',
    '',
    'The label names the dump copy, e.g. dec2025. The default folder is sql_dump/ at the repo root,',
    'and the default shop is delux.',
  ].join('\n');
}

const OPTIONS = new Set(['--label', '--dump', '--tenant', '--as-of', '--date']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseArgs(argv: string[]): Args | { error: string } {
  const [step, ...rest] = argv;
  if (!step) return { error: 'which step?' };
  if (!(steps as readonly string[]).includes(step)) return { error: `unknown step ${step}` };
  const options: Record<string, string> = {};
  let dryRun = false;
  let post = false;
  for (let i = 0; i < rest.length; i++) {
    const [flag, inline] = rest[i]!.split(/=(.*)/s, 2) as [string, string | undefined];
    if (flag === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (flag === '--post' && step === 'opening') {
      post = true;
      continue;
    }
    if (!OPTIONS.has(flag)) return { error: `unknown option ${flag}` };
    const value = inline ?? rest[++i];
    if (value === undefined) return { error: `${flag} needs a value` };
    options[flag] = value;
  }
  const label = options['--label'];
  if (label === undefined) return { error: '--label is required' };
  const args: Args = {
    step: step as Step,
    label,
    dump: options['--dump'] ?? null,
    tenant: options['--tenant'] ?? 'delux',
    dryRun,
  };
  if (step !== 'opening') {
    if (options['--as-of'] !== undefined || options['--date'] !== undefined)
      return { error: '--as-of and --date are for the opening step' };
    return args;
  }
  const asOf = options['--as-of'];
  const date = options['--date'];
  if (asOf === undefined || !DATE.test(asOf)) return { error: '--as-of YYYY-MM-DD is required' };
  if (date === undefined || !DATE.test(date)) return { error: '--date YYYY-MM-DD is required' };
  if (post && dryRun) return { error: '--post and --dry-run exclude each other' };
  return { ...args, opening: { asOf, date, post } };
}
