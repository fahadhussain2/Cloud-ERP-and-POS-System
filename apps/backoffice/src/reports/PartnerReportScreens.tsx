import {
  ACTIVITY_KIND_VIEWS,
  OVERDUE_DAYS,
  REGISTER_SIDES,
  type ActivityRow,
  type AgeingBucketsView,
  type BalanceTrendRow,
  type BalanceTrendView,
  type CashFlowView,
  type CollectionsView,
  type LedgerLineView,
  type MoneyRegisterRow,
  type MoneyRegisterTotal,
  type OverdueRow,
  type OverdueView,
  type OverLimitRow,
  type OverLimitView,
  type PartnerLedgerBody,
  type PartnerLedgerView,
  type PartyRoleView,
  type PartyView,
  type ShopHeaderView,
  type StatementsView,
  type UserActivityView,
} from '@erp/contracts';
import {
  Badge,
  Checkbox,
  cn,
  Label,
  LABEL_CLASS,
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
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import { qtyText } from '../catalog/data';
import { ItemPicker } from '../purchasing/ItemPicker';
import { href, queryOf, withQuery } from '../router';
import { ChartPanel, TrendChart } from './frame/Charts';
import { apiQuery, useFilters, type Filters } from './frame/filters';
import { documentHref } from './frame/links';
import {
  ChoiceFilter,
  DateFilter,
  ListTable,
  moneyText,
  PeriodFilter,
  periodOf,
  periodQuery,
  periodWords,
  ReportPage,
  useReport,
  type ListColumn,
  type PeriodValue,
} from './frame/ReportFrame';

// The customer, supplier and control reports and the cash flow (W2-04 plan; RPT-16, RPT-17, ACC-07; owner answers
// 1–7; D-116), each on the report frame. Read only. The ledger, statements, trend, overdue, over-limit and the register
// need reports.view (a supplier's side cost.view too); the cash flow reports.financial; user activity admin.users (the
// API refuses anyone else).

const p = (t: TFunction, key: string, o?: Record<string, unknown>) =>
  t(`reports.partnerReports.${key}`, o ?? {});

/** The filters now: the address's (two quick changes), else the ones the screen was drawn with. */
function current(filters: Filters): Filters {
  const q = queryOf(window.location.hash);
  return q.size > 0 ? Object.fromEntries(q) : filters;
}

/** Only the filters an API takes, without empty ones. */
const only = (f: Filters, keys: readonly string[]): Filters =>
  Object.fromEntries(keys.filter((k) => f[k]).map((k) => [k, f[k]!]));

const roleOf = (f: Filters): PartyRoleView => (f['role'] === 'supplier' ? 'supplier' : 'customer');

/** A document's kind in words; an unknown one as it is. */
const kindWords = (t: TFunction, kind: string) => p(t, `kinds.${kind}`, { defaultValue: kind });

/** A balance in words (owner answer 1): who owes whom. */
function balanceWords(t: TFunction, role: PartyRoleView, amount: number): string {
  if (amount === 0) return p(t, 'balance.settled');
  return p(t, `balance.${role}.${amount > 0 ? 'owed' : 'advance'}`);
}

/** The ledger of a party for a period, as a link (the trend, overdue and over-limit rows open it). */
export const ledgerLink = (role: PartyRoleView, partyId: string, from: string, to: string) =>
  withQuery(href.partnerLedger, { role, partyId, from, to });

/** A document's link, or its number alone when it has no screen (a counter's collection or cash-out). */
function DocumentLink({ kind, id, number }: { kind: string; id: string; number: string }) {
  const to = documentHref(kind, id, number);
  return to ? <a href={to}>{number}</a> : <>{number}</>;
}

// ---- The statement's parts: the shop and the party, the closing by how overdue it is ----

function StatementHeading({
  header,
  party,
  from,
  to,
}: {
  header: ShopHeaderView;
  party: PartyView;
  from: string;
  to: string;
}) {
  const { t } = useTranslation();
  return (
    <Panel className="grid gap-4 p-3.5 sm:grid-cols-2">
      <div className="flex flex-col">
        <span className="font-semibold">{header.name}</span>
        {header.address && <span>{header.address}</span>}
        {header.phone && <span>{header.phone}</span>}
        {header.lines.map((l) => (
          <span key={l} className="text-sm text-muted-foreground">
            {l}
          </span>
        ))}
      </div>
      <div className="flex flex-col sm:text-end">
        <span className={LABEL_CLASS}>{p(t, 'statement.for', { from, to })}</span>
        <span className="font-semibold">
          {party.name} ({party.code})
        </span>
        {party.address && <span>{party.address}</span>}
        {party.city && <span>{party.city}</span>}
        {party.phones.length > 0 && <span>{party.phones.join(' / ')}</span>}
      </div>
    </Panel>
  );
}

const BUCKETS = ['notDue', 'days1to30', 'days31to60', 'days61to90', 'over90'] as const;

function AgeingStrip({ ageing, money }: { ageing: AgeingBucketsView; money: MoneyFormat }) {
  const { t } = useTranslation();
  return (
    <Panel className="px-1.5 pb-1.5">
      <Table aria-label={p(t, 'statement.ageing')}>
        <TableHeader>
          <TableRow>
            {BUCKETS.map((b) => (
              <TableHead key={b} className="text-end">
                {p(t, `buckets.${b}`)}
              </TableHead>
            ))}
            <TableHead className="text-end">{p(t, 'closing')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            {BUCKETS.map((b) => (
              <TableCell key={b} className="text-end tabular-nums">
                {moneyText(ageing[b], money)}
              </TableCell>
            ))}
            <TableCell className="text-end font-semibold tabular-nums">
              {moneyText(ageing.balance, money)}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </Panel>
  );
}

/** A bill's or receipt's items, under its line (a statement "with items", owner answer 2). */
function ItemRows({ line, columns, money }: { line: LedgerLineView; columns: number; money: MoneyFormat }) {
  if (!line.items?.length) return null;
  return (
    <>
      {line.items.map((i, n) => (
        <TableRow key={`${line.sourceId}-${n}`} className="break-inside-avoid text-sm text-muted-foreground">
          <TableCell />
          <TableCell colSpan={Math.max(1, columns - 2)}>
            {i.code} {i.name} · {qtyText(i.qty)} × {moneyText(i.price, money)}
          </TableCell>
          <TableCell className="text-end tabular-nums">{moneyText(i.total, money)}</TableCell>
        </TableRow>
      ))}
    </>
  );
}

// ---- The partner ledger and the statement (RPT-16, owner answers 1 and 2) ----

const LEDGER_QUERY = ['role', 'partyId', 'preset', 'from', 'to', 'statement', 'items'];

export function PartnerLedgerScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const [filters, setFilters] = useFilters('partnerLedger');
  const role = roleOf(filters);
  const period = periodOf(filters, 'thisMonth');
  const statement = filters['statement'] === '1';
  const withItems = filters['items'] === '1';
  const url = filters['partyId']
    ? `/api/reports/partner-ledger?${apiQuery(only({ ...filters, role, ...periodQuery(period) }, LEDGER_QUERY))}`
    : null;
  const { report, error } = useReport<PartnerLedgerView>(api, url);
  const m = report?.money;
  const set = (next: Filters) =>
    setFilters(only({ ...periodQuery(period), ...current(filters), ...next }, LEDGER_QUERY));
  const setPeriod = (v: PeriodValue) =>
    setFilters(only({ ...current(filters), from: '', to: '', preset: '', ...periodQuery(v) }, LEDGER_QUERY));
  const columns: ListColumn<LedgerLineView>[] = m
    ? [
        { key: 'date', label: p(t, 'date'), sort: (l) => l.date, cell: (l) => l.date },
        {
          key: 'number',
          label: t('reports.frame.document'),
          sort: (l) => l.number,
          cell: (l) => <DocumentLink kind={l.kind} id={l.sourceId} number={l.number} />,
        },
        {
          key: 'kind',
          label: p(t, 'kind'),
          sort: (l) => l.kind,
          cell: (l) => (
            <span className="inline-flex items-center gap-2">
              {kindWords(t, l.kind)}
              {l.voided && <Badge variant="outline">{p(t, 'voided')}</Badge>}
            </span>
          ),
        },
        { key: 'memo', label: p(t, 'memo'), cell: (l) => l.memo ?? '' },
        { key: 'due', label: p(t, 'due'), sort: (l) => l.dueDate, cell: (l) => l.dueDate },
        {
          key: 'debit',
          label: p(t, 'debit'),
          end: true,
          sort: (l) => l.debit,
          cell: (l) => moneyText(l.debit, m, true),
        },
        {
          key: 'credit',
          label: p(t, 'credit'),
          end: true,
          sort: (l) => l.credit,
          cell: (l) => moneyText(l.credit, m, true),
        },
        { key: 'balance', label: p(t, 'balance.label'), end: true, cell: (l) => moneyText(l.balance, m) },
      ]
    : [];
  return (
    <ReportPage
      title={report ? `${report.party.name} (${report.party.code})` : t('nav.partnerLedger')}
      eyebrow={report ? t(statement ? 'nav.statement' : 'nav.partnerLedger') : undefined}
      help={p(t, 'help.partnerLedger')}
      filters={
        <>
          <ChoiceFilter
            label={p(t, 'role')}
            value={role}
            options={(['customer', 'supplier'] as const).map((r) => ({
              value: r,
              label: p(t, `roles.${r}`),
            }))}
            onChange={(v) => set({ role: v, partyId: '' })}
          />
          <div className="flex w-80 max-w-full flex-col gap-1">
            <span className={LABEL_CLASS}>{p(t, `roles.${role}`)}</span>
            <ItemPicker
              api={api}
              url={role === 'customer' ? '/api/reports/customers' : '/api/reports/suppliers'}
              label={p(t, `roles.${role}`)}
              picked={report?.party ?? null}
              onPick={(x) => set({ partyId: x.id })}
            />
          </div>
          <PeriodFilter value={period} shown={report} onChange={setPeriod} />
          {(['statement', 'items'] as const).map((k) => (
            <div key={k} className="flex h-9 items-center gap-2">
              <Checkbox
                id={`ledger-${k}`}
                checked={k === 'statement' ? statement : withItems}
                onCheckedChange={(c) => set({ [k]: c === true ? '1' : '' })}
              />
              <Label htmlFor={`ledger-${k}`}>{p(t, `ledger.${k}`)}</Label>
            </div>
          ))}
        </>
      }
      printFilters={report ? `${report.party.name} · ${periodWords(report)}` : ''}
      csv={report && `${url}&format=csv`}
      error={error}
      loading={url !== null && report === null}
      figures={
        report && m
          ? [
              { key: 'opening', label: p(t, 'opening'), value: moneyText(report.opening, m) },
              { key: 'debit', label: p(t, 'debit'), value: moneyText(report.debit, m) },
              { key: 'credit', label: p(t, 'credit'), value: moneyText(report.credit, m) },
              {
                key: 'closing',
                label: p(t, 'closing'),
                value: `${moneyText(report.closing, m)} · ${balanceWords(t, role, report.closing)}`,
              },
            ]
          : []
      }
    >
      {!filters['partyId'] && <p className="text-muted-foreground">{p(t, `ledger.pick.${role}`)}</p>}
      {report && m && (
        <>
          {statement && (
            <StatementHeading header={report.header} party={report.party} from={report.from} to={report.to} />
          )}
          <ListTable
            label={t('nav.partnerLedger')}
            columns={columns}
            rows={report.lines}
            rowKey={(l) => `${l.kind}-${l.sourceId}`}
            text={(l) => `${l.number} ${l.memo ?? ''} ${kindWords(t, l.kind)}`}
            footer={[
              '',
              '',
              p(t, 'closing'),
              '',
              '',
              moneyText(report.debit, m),
              moneyText(report.credit, m),
              moneyText(report.closing, m),
            ]}
            {...(withItems
              ? { details: (l: LedgerLineView) => <ItemRows line={l} columns={8} money={m} /> }
              : {})}
          />
          {report.byKind.length > 0 && <KindTotals body={report} money={m} />}
          <AgeingStrip ageing={report.ageing} money={m} />
        </>
      )}
    </ReportPage>
  );
}

/** The totals by kind of document (the legacy Business Partner Activity). */
function KindTotals({ body, money }: { body: PartnerLedgerBody; money: MoneyFormat }) {
  const { t } = useTranslation();
  return (
    <Panel className="px-1.5 pb-1.5">
      <Table aria-label={p(t, 'byKind')}>
        <TableHeader>
          <TableRow>
            <TableHead>{p(t, 'kind')}</TableHead>
            <TableHead className="text-end">{p(t, 'count')}</TableHead>
            <TableHead className="text-end">{p(t, 'debit')}</TableHead>
            <TableHead className="text-end">{p(t, 'credit')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {body.byKind.map((k) => (
            <TableRow key={k.kind}>
              <TableCell>{kindWords(t, k.kind)}</TableCell>
              <TableCell className="text-end tabular-nums">{k.count}</TableCell>
              <TableCell className="text-end tabular-nums">{moneyText(k.debit, money, true)}</TableCell>
              <TableCell className="text-end tabular-nums">{moneyText(k.credit, money, true)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Panel>
  );
}

// ---- Statements for every customer with a balance (owner answer 2) ----

/** One customer's statement on its own page: a plain table, no search (it is for paper). */
function StatementPage({ report, body }: { report: StatementsView; body: PartnerLedgerBody }) {
  const { t } = useTranslation();
  const m = report.money;
  return (
    <section
      aria-label={body.party.name}
      className="flex flex-col gap-3 border-t border-line pt-4 first:border-t-0 first:pt-0 print:break-before-page print:border-t-0 print:first:break-before-auto"
    >
      <StatementHeading header={report.header} party={body.party} from={report.from} to={report.to} />
      <Panel className="px-1.5 pb-1.5">
        <Table aria-label={p(t, 'statement.lines', { name: body.party.name })}>
          <TableHeader>
            <TableRow>
              <TableHead>{p(t, 'date')}</TableHead>
              <TableHead>{t('reports.frame.document')}</TableHead>
              <TableHead>{p(t, 'kind')}</TableHead>
              <TableHead className="text-end">{p(t, 'debit')}</TableHead>
              <TableHead className="text-end">{p(t, 'credit')}</TableHead>
              <TableHead className="text-end">{p(t, 'balance.label')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>{report.from}</TableCell>
              <TableCell colSpan={4}>{p(t, 'opening')}</TableCell>
              <TableCell className="text-end tabular-nums">{moneyText(body.opening, m)}</TableCell>
            </TableRow>
            {body.lines.map((l) => (
              <StatementLine key={`${l.kind}-${l.sourceId}`} line={l} money={m} />
            ))}
          </TableBody>
          <TableFooter>
            <TableRow className="font-semibold">
              <TableCell colSpan={3}>{p(t, 'closing')}</TableCell>
              <TableCell className="text-end tabular-nums">{moneyText(body.debit, m)}</TableCell>
              <TableCell className="text-end tabular-nums">{moneyText(body.credit, m)}</TableCell>
              <TableCell className="text-end tabular-nums">{moneyText(body.closing, m)}</TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </Panel>
      <AgeingStrip ageing={body.ageing} money={m} />
    </section>
  );
}

function StatementLine({ line, money }: { line: LedgerLineView; money: MoneyFormat }) {
  const { t } = useTranslation();
  return (
    <>
      <TableRow className="break-inside-avoid">
        <TableCell>{line.date}</TableCell>
        <TableCell>{line.number}</TableCell>
        <TableCell>{kindWords(t, line.kind)}</TableCell>
        <TableCell className="text-end tabular-nums">{moneyText(line.debit, money, true)}</TableCell>
        <TableCell className="text-end tabular-nums">{moneyText(line.credit, money, true)}</TableCell>
        <TableCell className="text-end tabular-nums">{moneyText(line.balance, money)}</TableCell>
      </TableRow>
      <ItemRows line={line} columns={6} money={money} />
    </>
  );
}

const STATEMENTS_QUERY = ['preset', 'from', 'to', 'items'];

export function StatementsScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const [filters, setFilters] = useFilters('statements');
  const period = periodOf(filters, 'lastMonth');
  const withItems = filters['items'] === '1';
  const url = `/api/reports/statements?${apiQuery(only({ ...filters, ...periodQuery(period) }, STATEMENTS_QUERY))}`;
  const { report, error } = useReport<StatementsView>(api, url);
  const set = (next: Filters) =>
    setFilters(only({ ...periodQuery(period), ...current(filters), ...next }, STATEMENTS_QUERY));
  const setPeriod = (v: PeriodValue) =>
    setFilters(
      only({ ...current(filters), from: '', to: '', preset: '', ...periodQuery(v) }, STATEMENTS_QUERY),
    );
  return (
    <ReportPage
      title={t('nav.statements')}
      help={p(t, 'help.statements')}
      filters={
        <>
          <PeriodFilter value={period} shown={report} onChange={setPeriod} />
          <div className="flex h-9 items-center gap-2">
            <Checkbox
              id="statements-items"
              checked={withItems}
              onCheckedChange={(c) => set({ items: c === true ? '1' : '' })}
            />
            <Label htmlFor="statements-items">{p(t, 'ledger.items')}</Label>
          </div>
        </>
      }
      printFilters={periodWords(report)}
      csv={report && `${url}&format=csv`}
      error={error}
      loading={report === null && error === null}
      figures={
        report
          ? [
              { key: 'customers', label: p(t, 'statement.count'), value: report.statements.length },
              {
                key: 'owed',
                label: p(t, 'statement.owed'),
                value: moneyText(
                  report.statements.reduce((s, x) => s + x.closing, 0),
                  report.money,
                ),
              },
            ]
          : []
      }
    >
      {report && report.statements.length === 0 && (
        <p className="text-muted-foreground">{t('reports.none')}</p>
      )}
      {report?.statements.map((b) => (
        <StatementPage key={b.party.id} report={report} body={b} />
      ))}
    </ReportPage>
  );
}

// ---- The balance trend (RPT-16, owner answer 3) ----

const POINTS = ['asOn', 'days15', 'month1', 'months2', 'months3', 'months6'] as const;

export function BalanceTrendScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const [filters, setFilters] = useFilters('balanceTrend');
  const role = roleOf(filters);
  const url = `/api/reports/balance-trend?${apiQuery(only({ ...filters, role }, ['role', 'asOf']))}`;
  const { report, error } = useReport<BalanceTrendView>(api, url);
  const m = report?.money;
  const set = (next: Filters) => setFilters(only({ ...current(filters), ...next }, ['role', 'asOf']));
  const amount = (v: number | null) => (v === null || !m ? p(t, 'beforeGoLive') : moneyText(v, m));
  const columns: ListColumn<BalanceTrendRow>[] =
    report && m
      ? [
          {
            key: 'party',
            label: p(t, `roles.${role}`),
            sort: (r) => r.name,
            cell: (r) => (
              <a href={ledgerLink(role, r.partyId, report.dates[4]!, report.asOf)}>
                {r.name} <span className="text-muted-foreground">{r.code}</span>
              </a>
            ),
          },
          ...POINTS.map((k, i): ListColumn<BalanceTrendRow> => ({
            key: k,
            label: `${p(t, `points.${k}`)} · ${report.dates[i]}`,
            end: true,
            sort: (r) => r.balances[i] ?? Number.MIN_SAFE_INTEGER,
            cell: (r) => amount(r.balances[i] ?? null),
          })),
          {
            key: 'change',
            label: p(t, 'changeMonth'),
            end: true,
            sort: (r) => r.change ?? 0,
            cell: (r) => (r.change === null ? '—' : moneyText(r.change, m)),
          },
        ]
      : [];
  const chronological = report ? [...report.dates].reverse() : [];
  return (
    <ReportPage
      title={t('nav.balanceTrend')}
      help={p(t, 'help.balanceTrend')}
      filters={
        <>
          <ChoiceFilter
            label={p(t, 'role')}
            value={role}
            options={(['customer', 'supplier'] as const).map((r) => ({
              value: r,
              label: p(t, `rolesMany.${r}`),
            }))}
            onChange={(v) => set({ role: v })}
          />
          <DateFilter
            label={p(t, 'asOf')}
            value={filters['asOf'] ?? report?.asOf ?? ''}
            onChange={(v) => set({ asOf: v })}
          />
        </>
      }
      printFilters={report ? `${p(t, `rolesMany.${role}`)} · ${report.asOf}` : ''}
      csv={report && `${url}&format=csv`}
      error={error}
      loading={report === null && error === null}
      figures={
        report && m
          ? [
              { key: 'parties', label: p(t, `rolesMany.${role}`), value: report.rows.length },
              { key: 'total', label: p(t, 'total'), value: amount(report.totals[0] ?? null) },
              {
                key: 'month',
                label: p(t, 'changeMonth'),
                value:
                  report.totals[0] == null || report.totals[2] == null
                    ? '—'
                    : moneyText(report.totals[0] - report.totals[2], m),
              },
            ]
          : []
      }
    >
      {report && m && (
        <>
          <ChartPanel title={p(t, 'trendChart', { role: p(t, `rolesMany.${role}`) })}>
            <TrendChart
              label={p(t, 'trendChart', { role: p(t, `rolesMany.${role}`) })}
              points={chronological}
              series={[
                {
                  label: p(t, 'total'),
                  tone: 1,
                  values: [...report.totals].reverse(),
                },
              ]}
              format={(v) => moneyText(v, m)}
              tick={(i) => chronological[i] ?? ''}
            />
          </ChartPanel>
          <ListTable
            label={t('nav.balanceTrend')}
            columns={columns}
            rows={report.rows}
            rowKey={(r) => r.partyId}
            text={(r) => `${r.code} ${r.name}`}
            footer={[p(t, 'total'), ...report.totals.map((v) => amount(v)), '']}
          />
        </>
      )}
    </ReportPage>
  );
}

// ---- Overdue and over the limit (RPT-17, owner answer 4) ----

export function OverdueScreen({ api }: { api: Api }) {
  const { t, i18n } = useTranslation();
  const [filters, setFilters] = useFilters('overdue');
  const url = `/api/reports/overdue?${apiQuery(only(filters, ['asOf', 'days']))}`;
  const { report, error } = useReport<OverdueView>(api, url);
  const m = report?.money;
  const set = (next: Filters) => setFilters(only({ ...current(filters), ...next }, ['asOf', 'days']));
  const columns: ListColumn<OverdueRow>[] =
    report && m
      ? [
          {
            key: 'customer',
            label: p(t, 'roles.customer'),
            sort: (r) => r.name,
            cell: (r) => (
              <a href={ledgerLink('customer', r.partyId, monthsBefore(report.asOf, 3), report.asOf)}>
                {r.name} <span className="text-muted-foreground">{r.code}</span>
              </a>
            ),
          },
          { key: 'phone', label: p(t, 'phone'), cell: (r) => r.phones.join(' / ') },
          {
            key: 'overdue',
            label: p(t, 'overdue.amount', { days: report.days }),
            end: true,
            sort: (r) => r.overdue,
            cell: (r) => moneyText(r.overdue, m),
          },
          {
            key: 'balance',
            label: p(t, 'balance.label'),
            end: true,
            sort: (r) => r.balance,
            cell: (r) => moneyText(r.balance, m),
          },
          {
            key: 'oldest',
            label: p(t, 'overdue.oldest'),
            sort: (r) => r.oldestDate ?? '',
            cell: (r) => r.oldestDate ?? '',
          },
          {
            key: 'late',
            label: p(t, 'overdue.late'),
            end: true,
            sort: (r) => r.oldestLate ?? 0,
            cell: (r) =>
              r.oldestLate === null ? '' : new Intl.NumberFormat(i18n.language).format(r.oldestLate),
          },
          {
            key: 'paid',
            label: p(t, 'overdue.lastPayment'),
            sort: (r) => r.lastPayment?.date ?? '',
            cell: (r) =>
              r.lastPayment
                ? `${r.lastPayment.date} · ${moneyText(r.lastPayment.amount, m)}`
                : p(t, 'overdue.never'),
          },
          {
            key: 'limit',
            label: p(t, 'limit'),
            end: true,
            cell: (r) => (r.limit === null ? p(t, 'noLimit') : moneyText(r.limit, m)),
          },
          {
            key: 'terms',
            label: p(t, 'terms'),
            end: true,
            cell: (r) => (r.termsDays === null ? p(t, 'noTerms') : p(t, 'days', { count: r.termsDays })),
          },
        ]
      : [];
  return (
    <ReportPage
      title={t('nav.overdue')}
      help={p(t, 'help.overdue')}
      filters={
        <>
          <DateFilter
            label={p(t, 'asOf')}
            value={filters['asOf'] ?? report?.asOf ?? ''}
            onChange={(v) => set({ asOf: v })}
          />
          <ChoiceFilter
            label={p(t, 'overdue.by')}
            value={filters['days'] ?? String(report?.days ?? 30)}
            options={OVERDUE_DAYS.map((d) => ({
              value: String(d),
              label: p(t, 'overdue.more', { count: d }),
            }))}
            onChange={(v) => set({ days: v })}
          />
        </>
      }
      printFilters={report ? `${report.asOf} · ${p(t, 'overdue.more', { count: report.days })}` : ''}
      csv={report && `${url}${url.endsWith('?') ? '' : '&'}format=csv`}
      error={error}
      loading={report === null && error === null}
      figures={
        report && m
          ? [
              { key: 'customers', label: p(t, 'rolesMany.customer'), value: report.rows.length },
              {
                key: 'overdue',
                label: p(t, 'overdue.total'),
                value: moneyText(report.totals.overdue, m),
                tone: 'bad',
              },
              { key: 'balance', label: p(t, 'balance.label'), value: moneyText(report.totals.balance, m) },
            ]
          : []
      }
    >
      {report && m && (
        <ListTable
          label={t('nav.overdue')}
          columns={columns}
          rows={report.rows}
          rowKey={(r) => r.partyId}
          text={(r) => `${r.code} ${r.name} ${r.phones.join(' ')}`}
        />
      )}
    </ReportPage>
  );
}

/** `n` months before a date, the day cut to the month's end (as the trend's dates). */
function monthsBefore(date: string, n: number): string {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const last = new Date(Date.UTC(y, mo - 1 - n + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, mo - 1 - n, Math.min(d, last))).toISOString().slice(0, 10);
}

export function OverLimitScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const url = '/api/reports/over-limit';
  const { report, error } = useReport<OverLimitView>(api, url);
  const m = report?.money;
  const columns: ListColumn<OverLimitRow>[] =
    report && m
      ? [
          {
            key: 'customer',
            label: p(t, 'roles.customer'),
            sort: (r) => r.name,
            cell: (r) => (
              <a href={ledgerLink('customer', r.partyId, monthsBefore(report.asOf, 3), report.asOf)}>
                {r.name} <span className="text-muted-foreground">{r.code}</span>
              </a>
            ),
          },
          { key: 'phone', label: p(t, 'phone'), cell: (r) => r.phones.join(' / ') },
          {
            key: 'state',
            label: p(t, 'limits.state'),
            sort: (r) => r.state,
            cell: (r) => (
              <Badge variant={r.state === 'over' ? 'destructive' : 'outline'}>
                {p(t, `limits.${r.state}`)}
              </Badge>
            ),
          },
          {
            key: 'limit',
            label: p(t, 'limit'),
            end: true,
            sort: (r) => r.limit,
            cell: (r) => moneyText(r.limit, m),
          },
          {
            key: 'balance',
            label: p(t, 'balance.label'),
            end: true,
            sort: (r) => r.balance,
            cell: (r) => moneyText(r.balance, m),
          },
          {
            key: 'left',
            label: p(t, 'limits.left'),
            end: true,
            sort: (r) => r.left,
            cell: (r) => moneyText(r.left, m),
          },
          {
            key: 'approval',
            label: p(t, 'limits.lastApproval'),
            sort: (r) => r.lastApproval ?? '',
            cell: (r) => r.lastApproval ?? '',
          },
        ]
      : [];
  return (
    <ReportPage
      title={t('nav.overLimit')}
      help={p(t, 'help.overLimit')}
      filters={
        <span className="text-muted-foreground">{report ? p(t, 'asOfDate', { date: report.asOf }) : ''}</span>
      }
      printFilters={report ? p(t, 'asOfDate', { date: report.asOf }) : ''}
      csv={report && `${url}?format=csv`}
      error={error}
      loading={report === null && error === null}
      figures={
        report
          ? [
              { key: 'with', label: p(t, 'limits.withLimit'), value: report.withLimit },
              {
                key: 'over',
                label: p(t, 'limits.over'),
                value: report.rows.filter((r) => r.state === 'over').length,
                tone: 'bad',
              },
              {
                key: 'near',
                label: p(t, 'limits.near'),
                value: report.rows.filter((r) => r.state === 'near').length,
              },
            ]
          : []
      }
    >
      {report?.withLimit === 0 && (
        <p className="text-muted-foreground">
          {p(t, 'limits.noneSet')} <a href={href.customers}>{t('nav.customers')}</a>
        </p>
      )}
      {report && m && (
        <ListTable
          label={t('nav.overLimit')}
          columns={columns}
          rows={report.rows}
          rowKey={(r) => r.partyId}
          text={(r) => `${r.code} ${r.name} ${r.phones.join(' ')}`}
        />
      )}
    </ReportPage>
  );
}

// ---- Collections and payments (RPT-17, owner answer 5) ----

const REGISTER_QUERY = ['side', 'preset', 'from', 'to'];

function Totals({ title, rows, money }: { title: string; rows: MoneyRegisterTotal[]; money: MoneyFormat }) {
  const { t } = useTranslation();
  return (
    <Panel className="min-w-64 flex-1 px-1.5 pb-1.5">
      <Table aria-label={title}>
        <TableHeader>
          <TableRow>
            <TableHead>{title}</TableHead>
            <TableHead className="text-end">{p(t, 'count')}</TableHead>
            <TableHead className="text-end">{p(t, 'amount')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.name}>
              <TableCell>{r.name || '—'}</TableCell>
              <TableCell className="text-end tabular-nums">{r.count}</TableCell>
              <TableCell className="text-end tabular-nums">{moneyText(r.amount, money)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Panel>
  );
}

export function CollectionsScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const [filters, setFilters] = useFilters('collections');
  const side = filters['side'] === 'paid' ? 'paid' : 'received';
  const period = periodOf(filters, 'today');
  const url = `/api/reports/collections?${apiQuery(only({ ...filters, side, ...periodQuery(period) }, REGISTER_QUERY))}`;
  const { report, error } = useReport<CollectionsView>(api, url);
  const m = report?.money;
  const set = (next: Filters) =>
    setFilters(only({ ...periodQuery(period), ...current(filters), ...next }, REGISTER_QUERY));
  const setPeriod = (v: PeriodValue) =>
    setFilters(
      only({ ...current(filters), from: '', to: '', preset: '', ...periodQuery(v) }, REGISTER_QUERY),
    );
  const columns: ListColumn<MoneyRegisterRow>[] = m
    ? [
        { key: 'date', label: p(t, 'date'), sort: (r) => `${r.date}${r.number}`, cell: (r) => r.date },
        {
          key: 'number',
          label: t('reports.frame.document'),
          sort: (r) => r.number,
          cell: (r) => <DocumentLink kind={r.kind} id={r.sourceId} number={r.number} />,
        },
        { key: 'kind', label: p(t, 'kind'), sort: (r) => r.kind, cell: (r) => kindWords(t, r.kind) },
        {
          key: 'party',
          label: p(t, side === 'received' ? 'roles.customer' : 'roles.supplier'),
          sort: (r) => r.partyName,
          cell: (r) => `${r.partyName} (${r.partyCode})`,
        },
        { key: 'how', label: p(t, 'register.how'), sort: (r) => r.how, cell: (r) => r.how },
        {
          key: 'where',
          label: p(t, 'register.where'),
          cell: (r) => r.counter ?? p(t, 'backOffice'),
        },
        { key: 'by', label: p(t, 'register.by'), sort: (r) => r.by ?? '', cell: (r) => r.by ?? '' },
        { key: 'reference', label: p(t, 'register.reference'), cell: (r) => r.reference ?? '' },
        {
          key: 'amount',
          label: p(t, 'amount'),
          end: true,
          sort: (r) => r.amount,
          cell: (r) => moneyText(r.amount, m),
        },
      ]
    : [];
  return (
    <ReportPage
      title={p(t, `register.title.${side}`)}
      help={p(t, 'help.collections')}
      filters={
        <>
          <ChoiceFilter
            label={p(t, 'register.side')}
            value={side}
            options={REGISTER_SIDES.map((v) => ({ value: v, label: p(t, `register.${v}`) }))}
            onChange={(v) => set({ side: v })}
          />
          <PeriodFilter value={period} shown={report} onChange={setPeriod} />
        </>
      }
      printFilters={periodWords(report)}
      csv={report && `${url}&format=csv`}
      error={error}
      loading={report === null && error === null}
      figures={
        report && m
          ? [
              { key: 'count', label: p(t, 'count'), value: report.rows.length },
              { key: 'total', label: p(t, 'total'), value: moneyText(report.total, m) },
            ]
          : []
      }
    >
      {report && m && (
        <>
          <ListTable
            label={p(t, `register.title.${side}`)}
            columns={columns}
            rows={report.rows}
            rowKey={(r) => `${r.kind}-${r.sourceId}`}
            text={(r) =>
              `${r.number} ${r.partyCode} ${r.partyName} ${r.reference ?? ''} ${r.how} ${r.by ?? ''}`
            }
            footer={['', '', '', '', '', '', '', p(t, 'total'), moneyText(report.total, m)]}
          />
          <div className="flex flex-wrap gap-3">
            <Totals title={p(t, 'register.byMethod')} rows={report.byMethod} money={m} />
            <Totals title={p(t, 'register.byPerson')} rows={report.byPerson} money={m} />
          </div>
        </>
      )}
    </ReportPage>
  );
}

// ---- User activity (RPT-17, owner answer 6) ----

const ACTIVITY_QUERY = ['preset', 'from', 'to', 'userId', 'kind'];

/** A changed value in words: as it is when it's text or a number, else its JSON. */
const valueText = (v: unknown) =>
  v === null || v === undefined
    ? '—'
    : typeof v === 'string' || typeof v === 'number'
      ? String(v)
      : JSON.stringify(v);

export function UserActivityScreen({ api }: { api: Api }) {
  const { t, i18n } = useTranslation();
  const [filters, setFilters] = useFilters('userActivity');
  const period = periodOf(filters, 'today');
  const url = `/api/reports/user-activity?${apiQuery(only({ ...filters, ...periodQuery(period) }, ACTIVITY_QUERY))}`;
  const { report, error } = useReport<UserActivityView>(api, url);
  const set = (next: Filters) =>
    setFilters(only({ ...periodQuery(period), ...current(filters), ...next }, ACTIVITY_QUERY));
  const setPeriod = (v: PeriodValue) =>
    setFilters(
      only({ ...current(filters), from: '', to: '', preset: '', ...periodQuery(v) }, ACTIVITY_QUERY),
    );
  const when = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });
  const columns: ListColumn<ActivityRow>[] = [
    { key: 'at', label: p(t, 'activity.at'), sort: (r) => r.at, cell: (r) => when.format(new Date(r.at)) },
    { key: 'who', label: p(t, 'activity.who'), sort: (r) => r.userName, cell: (r) => r.userName },
    { key: 'where', label: p(t, 'register.where'), cell: (r) => r.device ?? p(t, 'backOffice') },
    { key: 'kind', label: p(t, 'kind'), sort: (r) => r.kind, cell: (r) => p(t, `activity.kinds.${r.kind}`) },
    {
      key: 'what',
      label: p(t, 'activity.what'),
      sort: (r) => r.action,
      cell: (r) => p(t, `activity.actions.${r.action}`, { defaultValue: r.action }),
    },
    {
      key: 'record',
      label: p(t, 'activity.record'),
      cell: (r) => (
        <>
          {p(t, `activity.records.${r.entity}`, { defaultValue: r.entity })}
          {r.label && <span className="text-muted-foreground"> {r.label}</span>}
        </>
      ),
    },
    {
      key: 'changes',
      label: p(t, 'activity.changes'),
      cell: (r) =>
        r.changes.length === 0 ? (
          ''
        ) : (
          <ul className="m-0 list-none p-0 text-sm">
            {r.changes.map((c) => (
              <li key={c.field}>
                <span className="text-muted-foreground">{c.field}:</span> {valueText(c.before)} →{' '}
                {valueText(c.after)}
              </li>
            ))}
          </ul>
        ),
    },
  ];
  return (
    <ReportPage
      title={t('nav.userActivity')}
      help={p(t, 'help.userActivity')}
      filters={
        <>
          <PeriodFilter value={period} shown={report} onChange={setPeriod} />
          <ChoiceFilter
            label={p(t, 'activity.who')}
            value={filters['userId'] ?? ''}
            options={[
              { value: '', label: p(t, 'activity.everyone') },
              ...(report?.users ?? []).map((u) => ({ value: u.id, label: u.name })),
            ]}
            onChange={(v) => set({ userId: v })}
          />
          <ChoiceFilter
            label={p(t, 'kind')}
            value={filters['kind'] ?? ''}
            options={[
              { value: '', label: p(t, 'activity.everything') },
              ...ACTIVITY_KIND_VIEWS.map((k) => ({ value: k, label: p(t, `activity.kinds.${k}`) })),
            ]}
            onChange={(v) => set({ kind: v })}
          />
        </>
      }
      printFilters={periodWords(report)}
      csv={report && `${url}&format=csv`}
      error={error}
      loading={report === null && error === null}
      figures={report ? [{ key: 'count', label: p(t, 'activity.count'), value: report.count }] : []}
    >
      {report && report.count > report.rows.length && (
        <p className="text-muted-foreground">
          {p(t, 'activity.newest', { shown: report.rows.length, count: report.count })}
        </p>
      )}
      {report && (
        <ListTable
          label={t('nav.userActivity')}
          columns={columns}
          rows={report.rows}
          rowKey={(r) => `${r.at}-${r.entity}-${r.entityId ?? ''}-${r.action}`}
          text={(r) => `${r.userName} ${r.action} ${r.entity} ${r.label ?? ''} ${r.device ?? ''}`}
        />
      )}
    </ReportPage>
  );
}

// ---- The cash flow (ACC-07, owner answer 7) ----

export function CashFlowScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const [filters, setFilters] = useFilters('cashFlow');
  const period = periodOf(filters, 'thisMonth');
  const url = `/api/reports/cash-flow?${apiQuery(only({ ...filters, ...periodQuery(period) }, ['preset', 'from', 'to']))}`;
  const { report, error } = useReport<CashFlowView>(api, url);
  const m = report?.money;
  const setPeriod = (v: PeriodValue) =>
    setFilters(
      only({ ...current(filters), from: '', to: '', preset: '', ...periodQuery(v) }, [
        'preset',
        'from',
        'to',
      ]),
    );
  const many = (report?.columns.length ?? 0) > 1;
  const cells = (values: number[], total: number, money: MoneyFormat, strong = false) => (
    <>
      {values.map((v, i) => (
        <TableCell key={i} className={cn('text-end tabular-nums', strong && 'font-semibold')}>
          {moneyText(v, money, !strong)}
        </TableCell>
      ))}
      {many && (
        <TableCell className={cn('text-end tabular-nums', strong ? 'font-semibold' : 'font-medium')}>
          {moneyText(total, money)}
        </TableCell>
      )}
    </>
  );
  return (
    <ReportPage
      title={t('nav.cashFlow')}
      help={p(t, 'help.cashFlow')}
      filters={<PeriodFilter value={period} shown={report} onChange={setPeriod} />}
      printFilters={periodWords(report)}
      csv={report && `${url}&format=csv`}
      error={error}
      loading={report === null && error === null}
      figures={
        report && m
          ? [
              { key: 'opening', label: p(t, 'flow.opening'), value: moneyText(report.total.opening, m) },
              {
                key: 'net',
                label: p(t, 'flow.net'),
                value: moneyText(report.total.net, m),
                tone: report.total.net < 0 ? 'bad' : 'good',
              },
              { key: 'closing', label: p(t, 'flow.closing'), value: moneyText(report.total.closing, m) },
            ]
          : []
      }
    >
      {report && m && (
        <Panel className="overflow-x-auto px-1.5 pb-1.5">
          <Table aria-label={t('nav.cashFlow')}>
            <TableHeader>
              <TableRow>
                <TableHead />
                {report.columns.map((c) => (
                  <TableHead key={c.from} className="text-end">
                    <a href={withQuery(href.cashBook, { from: c.from, to: c.to })}>
                      {many ? c.from.slice(0, 7) : periodWords(c)}
                    </a>
                  </TableHead>
                ))}
                {many && <TableHead className="text-end">{p(t, 'total')}</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell className="font-semibold">{p(t, 'flow.opening')}</TableCell>
                {cells(
                  report.columns.map((c) => c.opening),
                  report.total.opening,
                  m,
                  true,
                )}
              </TableRow>
              {report.rows.map((r) => (
                <TableRow key={`${r.cls}-${r.account?.id ?? ''}`}>
                  <TableCell className={cn(r.account && 'ps-6')}>
                    {r.account ? `${r.account.code} ${r.account.name}` : p(t, `flow.classes.${r.cls}`)}
                  </TableCell>
                  {cells(r.amounts, r.total, m)}
                </TableRow>
              ))}
              {report.rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={report.columns.length + 2} className="text-muted-foreground">
                    {t('reports.none')}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell className="font-semibold">{p(t, 'flow.net')}</TableCell>
                {cells(
                  report.columns.map((c) => c.net),
                  report.total.net,
                  m,
                  true,
                )}
              </TableRow>
              <TableRow>
                <TableCell className="font-semibold">{p(t, 'flow.closing')}</TableCell>
                {cells(
                  report.columns.map((c) => c.closing),
                  report.total.closing,
                  m,
                  true,
                )}
              </TableRow>
            </TableFooter>
          </Table>
        </Panel>
      )}
      {report && <p className="text-sm text-muted-foreground">{p(t, 'flow.note')}</p>}
    </ReportPage>
  );
}
