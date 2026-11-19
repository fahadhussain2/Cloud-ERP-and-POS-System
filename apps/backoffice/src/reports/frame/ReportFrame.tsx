import { PERIOD_PRESETS } from '@erp/domain';
import {
  Alert,
  AlertDescription,
  Button,
  cn,
  formatMoney,
  Input,
  LABEL_CLASS,
  PageHeader,
  Panel,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
  type MoneyFormat,
} from '@erp/ui';
import { ArrowDown, ArrowUp, Download, Printer } from 'lucide-react';
import { createContext, useContext, useEffect, useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../../api';

// The report frame (W2-01 plan; D-116): every report from here on is drawn with it. Filters at the top with date
// presets, key figures, the list (sortable and searchable, or a statement with its groups and subtotals), drill-down
// to the lines and documents behind a figure, Download CSV and a print layout. Strings are i18n keys (rule 10), money in
// the shop's locale, CSS logical properties throughout.

// ---- Who prints, and for which shop ----

export interface PrintInfo {
  shopName: string;
  userName: string;
}

const PrintContext = createContext<PrintInfo>({ shopName: '', userName: '' });
export const PrintProvider = PrintContext.Provider;

// ---- Fetching ----

/** Fetches a report whenever its address changes; null while loading or after a refusal (with the words for it). */
export function useReport<T>(api: Api, url: string | null): { report: T | null; error: string | null } {
  const { t } = useTranslation();
  const [state, setState] = useState<{ url: string | null; report: T | null; error: string | null }>({
    url: null,
    report: null,
    error: null,
  });
  useEffect(() => {
    if (url === null) return;
    let live = true;
    void api('GET', url).then((r) => {
      if (!live) return;
      const error = (r.body as { error?: string } | null)?.error;
      setState(
        r.status === 200
          ? { url, report: r.body as T, error: null }
          : {
              url,
              report: null,
              error: error === 'range_too_long' ? t('reports.frame.tooLong') : t('reports.failed'),
            },
      );
    });
    return () => {
      live = false;
    };
  }, [api, url, t]);
  return state.url === url ? { report: state.report, error: state.error } : { report: null, error: null };
}

// ---- The page ----

export interface Figure {
  key: string;
  label: string;
  value: ReactNode;
  tone?: 'good' | 'bad';
}

/**
 * A report's page: its title and help, the filters, the key figures and the list. On paper (the browser's print or
 * Save as PDF, D-116 answer 5) the menu and filters go and a header names the shop, the report, its filters and who
 * printed it when.
 */
export function ReportPage({
  title,
  help,
  eyebrow,
  filters,
  printFilters,
  figures = [],
  csv,
  error,
  loading,
  children,
}: {
  title: string;
  help: string;
  eyebrow?: ReactNode;
  filters: ReactNode;
  /** The filters in words, for the printed header. */
  printFilters: string;
  figures?: Figure[];
  /** The CSV's address, once the report has loaded. */
  csv: string | null;
  error: string | null;
  loading: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const who = useContext(PrintContext);
  // The time on paper is when it was printed, not when the screen opened.
  const [printedAt, setPrintedAt] = useState(() => new Date());
  useEffect(() => {
    const stamp = () => setPrintedAt(new Date());
    window.addEventListener('beforeprint', stamp);
    return () => window.removeEventListener('beforeprint', stamp);
  }, []);
  return (
    <>
      <div data-slot="print-header" className="hidden print:block">
        <p className="m-0 text-lg font-bold">{who.shopName}</p>
        <p className="m-0 text-base font-semibold">{title}</p>
        <p className="m-0 text-sm">{printFilters}</p>
        <p className="m-0 text-xs">
          {t('reports.frame.printedBy', { name: who.userName, at: printedAt.toLocaleString() })}
        </p>
      </div>
      <div className="print:hidden">
        <PageHeader
          eyebrow={eyebrow}
          title={title}
          help={help}
          actions={
            <>
              {csv && (
                <Button asChild variant="outline">
                  <a href={csv}>
                    <Download aria-hidden="true" className="size-4" />
                    {t('reports.csv')}
                  </a>
                </Button>
              )}
              <Button variant="outline" onClick={() => window.print()}>
                <Printer aria-hidden="true" className="size-4" />
                {t('reports.frame.print')}
              </Button>
            </>
          }
        />
      </div>
      <Panel
        aria-label={t('reports.frame.filters')}
        className="flex flex-wrap items-end gap-4 p-3.5 print:hidden"
      >
        {filters}
      </Panel>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {loading && !error && <p className="text-muted-foreground">{t('app.loading')}</p>}
      {figures.length > 0 && (
        <Panel aria-label={t('reports.frame.figures')} className="flex flex-wrap gap-x-8 gap-y-2 p-3.5">
          {figures.map((f) => (
            <span key={f.key} className="flex flex-col">
              <span className={LABEL_CLASS}>{f.label}</span>
              <span
                className={cn(
                  'text-lg font-semibold tabular-nums',
                  f.tone === 'bad' && 'text-bad',
                  f.tone === 'good' && 'text-ok',
                )}
              >
                {f.value}
              </span>
            </span>
          ))}
        </Panel>
      )}
      {children}
    </>
  );
}

// ---- Filters ----

function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className={LABEL_CLASS}>
        {label}
      </label>
      {children(id)}
    </div>
  );
}

const SELECT = 'h-9 rounded-md border border-input bg-surface-2 px-2 text-base';

/** A choice from a short list. */
export function ChoiceFilter({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <Field label={label}>
      {(id) => (
        <select id={id} className={SELECT} value={value} onChange={(e) => onChange(e.target.value)}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

export function DateFilter({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Field label={label}>
      {(id) => (
        <Input
          id={id}
          type="date"
          className="h-9 w-44"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

export type PeriodValue = { preset: string } | { from: string; to: string };

/** The period's filters in the address: a preset (relative, "this month"), or two dates. */
export function periodOf(f: Record<string, string>, fallback: string): PeriodValue {
  return f['from'] && f['to'] ? { from: f['from'], to: f['to'] } : { preset: f['preset'] || fallback };
}
export const periodQuery = (p: PeriodValue): Record<string, string> =>
  'preset' in p ? { preset: p.preset } : { from: p.from, to: p.to };

/**
 * The period: a preset (today, this month, last quarter…, on the shop's fiscal year, worked out by the API) or any two
 * dates. `shown` is the period the report answered for, so a preset's dates are always in view.
 */
export function PeriodFilter({
  value,
  shown,
  onChange,
}: {
  value: PeriodValue;
  shown: { from: string; to: string } | null;
  onChange: (v: PeriodValue) => void;
}) {
  const { t } = useTranslation();
  const preset = 'preset' in value ? value.preset : 'custom';
  const from = 'from' in value ? value.from : (shown?.from ?? '');
  const to = 'to' in value ? value.to : (shown?.to ?? '');
  return (
    <>
      <ChoiceFilter
        label={t('reports.frame.period')}
        value={preset}
        options={[
          ...PERIOD_PRESETS.map((p) => ({ value: p, label: t(`reports.frame.presets.${p}`) })),
          { value: 'custom', label: t('reports.frame.presets.custom') },
        ]}
        onChange={(v) => onChange(v === 'custom' ? { from, to } : { preset: v })}
      />
      <DateFilter label={t('reports.frame.from')} value={from} onChange={(v) => onChange({ from: v, to })} />
      <DateFilter label={t('reports.frame.to')} value={to} onChange={(v) => onChange({ from, to: v })} />
    </>
  );
}

/** The period in words, for the printed header. */
export const periodWords = (p: { from: string; to: string } | null) => (p ? `${p.from} – ${p.to}` : '');

// ---- Money ----

/** Money in the shop's locale; blank for a zero where a column has many (a debit or credit side). */
export const moneyText = (v: number | null, m: MoneyFormat, blankZero = false) =>
  v === null ? '—' : blankZero && v === 0 ? '' : formatMoney(v, m);

/** Basis points as a percentage in the shop's locale, one decimal. */
export const percentText = (bp: number | null, locale: string) =>
  bp === null
    ? '—'
    : new Intl.NumberFormat(locale, {
        style: 'percent',
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }).format(bp / 10000);

// ---- A statement: rows down a chart's tree, with headings and totals ----

export interface StatementLine {
  key: string;
  kind: 'heading' | 'group' | 'account' | 'total';
  depth: number;
  code?: string;
  name: string;
  /** One cell per column: money, or text (a margin). */
  cells: (number | string | null)[];
  /** The ledger or list behind the row. */
  href?: string | null;
}

/**
 * A statement's table (the trial balance, the profit and loss, the balance sheet, the expenses): the rows keep the
 * chart's order with their groups and subtotals, so they aren't sorted; the search narrows them to matching accounts.
 * On paper, a group's rows stay together.
 */
export function StatementTable({
  label,
  first,
  columns,
  lines,
  money,
  blankZero = false,
}: {
  label: string;
  /** The first column's heading: Account unless said (Item for the stock lists, W2-02). */
  first?: string;
  columns: string[];
  lines: StatementLine[];
  money: MoneyFormat;
  /** Leave zeros blank (the debit and credit sides of a trial balance). */
  blankZero?: boolean;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const q = search.trim().toLocaleLowerCase();
  const shown =
    q === ''
      ? lines
      : lines.filter(
          (l) =>
            (l.kind === 'account' || l.kind === 'group') &&
            `${l.code ?? ''} ${l.name}`.toLocaleLowerCase().includes(q),
        );
  return (
    <Panel className="px-1.5 pb-2.5">
      <div className="flex justify-end p-2 print:hidden">
        <Input
          type="search"
          aria-label={t('reports.frame.search')}
          placeholder={t('reports.frame.search')}
          className="h-9 w-64"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <Table aria-label={label}>
        <TableHeader className="sticky top-0 bg-surface print:static">
          <TableRow>
            <TableHead>{first ?? t('reports.frame.account')}</TableHead>
            {columns.map((c, i) => (
              <TableHead key={i} className="text-end">
                {c}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((l) => (
            <TableRow
              key={l.key}
              data-kind={l.kind}
              className={cn(
                'break-inside-avoid',
                l.kind === 'heading' && 'bg-surface-2',
                (l.kind === 'group' || l.kind === 'total' || l.kind === 'heading') && 'font-semibold',
                l.kind === 'total' && 'border-t-2 border-line',
              )}
            >
              <TableCell style={{ paddingInlineStart: `${0.75 + l.depth * 1.25}rem` }}>
                {l.code && <span className="me-2 font-mono text-muted-foreground">{l.code}</span>}
                {l.href ? (
                  <a href={l.href} className="underline-offset-4 hover:underline">
                    {l.name}
                  </a>
                ) : (
                  l.name
                )}
              </TableCell>
              {columns.map((c, i) => {
                const v = l.cells[i] ?? null;
                return (
                  <TableCell key={i} className="text-end tabular-nums">
                    {l.kind === 'heading' ? '' : typeof v === 'string' ? v : moneyText(v, money, blankZero)}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
          {shown.length === 0 && (
            <TableRow>
              <TableCell colSpan={columns.length + 1} className="text-muted-foreground">
                {t('reports.none')}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </Panel>
  );
}

// ---- A list: documents or lines, sortable and searchable ----

export interface ListColumn<R> {
  key: string;
  label: string;
  /** Money columns line up on the end side. */
  end?: boolean;
  /** The value to sort by; a column without one doesn't sort. */
  sort?: (r: R) => string | number;
  cell: (r: R) => ReactNode;
}

/** A list of documents or lines (the day book, a ledger, the cash book): sort by a column, search by text. */
export function ListTable<R>({
  label,
  columns,
  rows,
  rowKey,
  text,
  footer,
  details,
}: {
  label: string;
  columns: ListColumn<R>[];
  rows: R[];
  rowKey: (r: R) => string;
  /** What the search looks in. */
  text: (r: R) => string;
  /** Cells under the list (a closing balance, totals), one per column. */
  footer?: ReactNode[];
  /** Rows shown under a row (a journal entry's lines). */
  details?: (r: R) => ReactNode;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ key: string; up: boolean } | null>(null);
  const q = search.trim().toLocaleLowerCase();
  const found = q === '' ? rows : rows.filter((r) => text(r).toLocaleLowerCase().includes(q));
  const by = columns.find((c) => c.key === sort?.key)?.sort;
  const shown =
    by && sort
      ? [...found].sort((a, b) => {
          const x = by(a);
          const y = by(b);
          return (x < y ? -1 : x > y ? 1 : 0) * (sort.up ? 1 : -1);
        })
      : found;
  return (
    <Panel className="px-1.5 pb-2.5">
      <div className="flex justify-end p-2 print:hidden">
        <Input
          type="search"
          aria-label={t('reports.frame.search')}
          placeholder={t('reports.frame.search')}
          className="h-9 w-64"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <Table aria-label={label}>
        <TableHeader className="sticky top-0 bg-surface print:static">
          <TableRow>
            {columns.map((c) => (
              <TableHead
                key={c.key}
                className={cn(c.end && 'text-end')}
                aria-sort={sort?.key === c.key ? (sort.up ? 'ascending' : 'descending') : undefined}
              >
                {c.sort ? (
                  <button
                    type="button"
                    className="inline-flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 font-[inherit]"
                    onClick={() => setSort((s) => ({ key: c.key, up: s?.key === c.key ? !s.up : true }))}
                  >
                    {c.label}
                    {sort?.key === c.key &&
                      (sort.up ? (
                        <ArrowUp aria-hidden="true" className="size-3.5" />
                      ) : (
                        <ArrowDown aria-hidden="true" className="size-3.5" />
                      ))}
                  </button>
                ) : (
                  c.label
                )}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((r) => (
            <ListRow key={rowKey(r)} columns={columns} row={r} details={details} />
          ))}
          {shown.length === 0 && (
            <TableRow>
              <TableCell colSpan={columns.length} className="text-muted-foreground">
                {t('reports.none')}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
        {footer && (
          <TableFooter>
            <TableRow className="font-semibold">
              {footer.map((cell, i) => (
                <TableCell
                  key={columns[i]?.key ?? i}
                  className={cn(columns[i]?.end && 'text-end tabular-nums')}
                >
                  {cell}
                </TableCell>
              ))}
            </TableRow>
          </TableFooter>
        )}
      </Table>
    </Panel>
  );
}

function ListRow<R>({
  columns,
  row,
  details,
}: {
  columns: ListColumn<R>[];
  row: R;
  details?: ((r: R) => ReactNode) | undefined;
}) {
  return (
    <>
      <TableRow className="break-inside-avoid">
        {columns.map((c) => (
          <TableCell key={c.key} className={cn(c.end && 'text-end tabular-nums')}>
            {c.cell(row)}
          </TableCell>
        ))}
      </TableRow>
      {details?.(row)}
    </>
  );
}
