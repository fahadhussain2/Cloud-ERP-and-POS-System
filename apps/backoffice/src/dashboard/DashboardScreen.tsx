import {
  DASHBOARD_PERIOD_VIEWS,
  type DashboardChipView,
  type DashboardCountView,
  type DashboardPeriodView,
  type DashboardView,
} from '@erp/contracts';
import { cn, PageHeader, Panel, type MoneyFormat } from '@erp/ui';
import type { TFunction } from 'i18next';
import {
  AlertTriangle,
  Banknote,
  Info,
  Landmark,
  Receipt,
  TrendingUp,
  Users,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import { qtyText } from '../catalog/data';
import { href, withQuery } from '../router';
import {
  BarList,
  ChartPanel,
  DonutChart,
  HourGridChart,
  StatCard,
  Swatch,
  TrendChart,
  type ChipValue,
  type SeriesTone,
} from '../reports/frame/Charts';
import { moneyText, percentText, useReport } from '../reports/frame/ReportFrame';

// The owner's dashboard (W2-06 plan; RPT-18; D-118): the day, the money and what needs the owner, on one screen. Every
// figure is its report's (GET /api/dashboard reads the same queries) and every card opens that report with the same
// filters. Read on open, on a period change, and every 5 minutes while the tab is visible (owner answer 6).

const REFRESH_MS = 5 * 60 * 1000;
const DEAD_DAYS = '90';

/** Monday first, in the shop's language. */
const weekdaysOf = (locale: string) =>
  Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(Date.UTC(2024, 0, 1 + i)),
  );
const hourOf = (locale: string) => (h: number) =>
  new Intl.DateTimeFormat(locale, { hour: 'numeric', timeZone: 'UTC' }).format(Date.UTC(2024, 0, 1, h));
const dayOf = (locale: string) => (date: string) =>
  new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
    Date.parse(date),
  );
const timeOf = (locale: string, iso: string) =>
  new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const longDate = (locale: string, date: string) =>
  new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(
    Date.parse(date),
  );

/** Every 5 minutes while the tab is visible, and when it becomes visible again after that. */
function useRefresh(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let last = Date.now();
    const tick = () => {
      if (document.visibilityState !== 'visible' || Date.now() - last < REFRESH_MS) return;
      last = Date.now();
      setVersion((v) => v + 1);
    };
    const timer = window.setInterval(tick, 30_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);
  return version;
}

function chipText(c: DashboardChipView, m: MoneyFormat, as: 'percent' | 'amount', suffix = ''): ChipValue {
  const sign = c.amount > 0 ? '+' : c.amount < 0 ? '−' : '';
  const body =
    as === 'percent' && c.bp !== null
      ? percentText(Math.abs(c.bp), m.locale)
      : moneyText(Math.abs(c.amount), m);
  return { text: `${sign}${body}${suffix}`, direction: c.direction, good: c.good };
}

/** A card's frame: its title, a line under it, and a link to its report. */
function Card({
  id,
  title,
  sub,
  link,
  children,
  className,
}: {
  id: string;
  title: string;
  sub?: string;
  link?: { href: string; label: string };
  children: ReactNode;
  className?: string;
}) {
  return (
    <Panel aria-labelledby={id} className={cn('flex min-w-0 flex-col gap-3 p-4', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id={id} className="m-0 text-base font-semibold">
            {title}
          </h2>
          {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
        </div>
        {link && (
          <a href={link.href} className="text-sm text-muted-foreground hover:text-ink hover:underline">
            {link.label}
          </a>
        )}
      </div>
      {children}
    </Panel>
  );
}

function Row({
  name,
  value,
  href: to,
  muted,
}: {
  name: ReactNode;
  value: string;
  href?: string;
  muted?: boolean;
}) {
  const body = (
    <>
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </>
  );
  const cls = cn(
    'flex items-center gap-3 border-t border-line py-2 text-sm',
    muted && 'text-muted-foreground',
  );
  return to ? (
    <a href={to} className={cn(cls, 'text-ink no-underline hover:bg-surface-2')}>
      {body}
    </a>
  ) : (
    <div className={cls}>{body}</div>
  );
}

const ATTENTION_ICONS: Record<string, LucideIcon> = {
  exceptions: AlertTriangle,
  negativeStock: AlertTriangle,
  counterUnseen: WifiOff,
  atMinimum: AlertTriangle,
  overLimit: Users,
  openSessions: Info,
};

function attentionHref(kind: string, today: string): string {
  switch (kind) {
    case 'exceptions':
      return withQuery(href.exceptions, { status: 'open', severity: 'high' });
    case 'negativeStock':
      return href.stockReport;
    case 'counterUnseen':
      return href.counters;
    case 'atMinimum':
      return href.reorder;
    case 'overLimit':
      return href.overLimit;
    default:
      return withQuery(href.dayReconciliation, { date: today });
  }
}

function LeakRow({
  name,
  row,
  m,
  details,
  to,
}: {
  name: string;
  row: DashboardCountView;
  m: MoneyFormat;
  details: string;
  to: string;
}) {
  const { t } = useTranslation();
  return (
    <a
      href={to}
      title={details}
      className="flex items-center gap-3 border-t border-line py-2.5 text-sm text-ink no-underline hover:bg-surface-2"
    >
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {name}
        <span className="text-muted-foreground tabular-nums">· {row.count}</span>
        {row.times !== null && (
          <span className="inline-flex items-center gap-1 rounded-full bg-warn-soft px-1.5 text-xs font-semibold text-warn">
            <AlertTriangle aria-hidden="true" className="size-3" />
            {t('dashboard.leak.usual', { times: (row.times / 10).toLocaleString(m.locale) })}
          </span>
        )}
      </span>
      <span className="font-semibold tabular-nums">{moneyText(row.amount, m)}</span>
    </a>
  );
}

const DONUT_TONES: Record<string, SeriesTone> = { net: 1, expense0: 2, expense1: 3, other: 'muted' };

function DonutCard({ d, m, t }: { d: NonNullable<DashboardView['donut']>; m: MoneyFormat; t: TFunction }) {
  const [active, setActive] = useState<string | null>(null);
  const slices = d.slices.map((s, i) => {
    const key =
      s.kind === 'expense'
        ? `expense${d.slices.slice(0, i).filter((x) => x.kind === 'expense').length}`
        : s.kind;
    const name =
      s.kind === 'net' ? t('dashboard.donut.net') : s.kind === 'other' ? t('dashboard.donut.other') : s.name!;
    const share = percentText(s.bp, m.locale);
    return {
      key,
      tone: DONUT_TONES[key]!,
      bp: s.bp,
      name,
      amount: s.amount,
      title: t('dashboard.donut.slice', { name, amount: moneyText(s.amount, m), share }),
      share,
    };
  });
  const on = slices.find((s) => s.key === active) ?? null;
  const centre = d.loss
    ? { value: moneyText(-d.net, m), label: t('dashboard.donut.loss'), bad: true }
    : on && on.key !== 'net'
      ? { value: on.share, label: on.name, bad: false }
      : { value: percentText(d.keptBp, m.locale), label: t('dashboard.donut.kept'), bad: false };
  return (
    <Card
      id="dash-donut"
      title={t('dashboard.donut.title')}
      sub={t('dashboard.donut.sub')}
      link={{
        href: withQuery(href.profitLoss, { from: d.from, to: d.to }),
        label: t('dashboard.donut.link'),
      }}
    >
      <div className="flex flex-col gap-4">
        <DonutChart
          label={slices.map((s) => s.title).join('; ')}
          slices={slices}
          size={168}
          active={active}
          onActive={setActive}
          centre={
            <>
              <span
                className={cn(
                  'font-display text-[34px] leading-none font-bold tabular-nums',
                  centre.bad && 'text-bad',
                )}
              >
                {centre.value}
              </span>
              <span className="text-xs text-muted-foreground">{centre.label}</span>
            </>
          }
        />
        <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
          {slices.map((s) => (
            <li
              key={s.key}
              title={s.title}
              onMouseEnter={() => setActive(s.key)}
              className="flex items-center gap-2"
            >
              <Swatch tone={s.tone} />
              <span className={cn('min-w-0 flex-1', s.key === 'net' && 'font-semibold')}>{s.name}</span>
              <span className={cn('tabular-nums', s.key === 'net' && 'font-semibold')}>
                {moneyText(s.amount, m)}
              </span>
            </li>
          ))}
          {d.loss && (
            <li className="flex items-center gap-2 font-semibold text-bad">
              <span className="min-w-0 flex-1 ps-[18px]">{t('dashboard.donut.netLoss')}</span>
              <span className="tabular-nums">{moneyText(d.net, m)}</span>
            </li>
          )}
          <li className="flex justify-between gap-2 border-t border-line pt-2 text-muted-foreground tabular-nums">
            <span>{t('dashboard.donut.gross')}</span>
            <span>{moneyText(d.grossProfit, m)}</span>
          </li>
        </ul>
      </div>
    </Card>
  );
}

export function DashboardScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const [period, setPeriod] = useState<DashboardPeriodView>('today');
  const version = useRefresh();
  const { report: d, error } = useReport<DashboardView>(api, `/api/dashboard?period=${period}`, version);

  const header = (
    <PageHeader
      title={t('dashboard.title')}
      help={
        d
          ? [
              longDate(d.money.locale, d.today),
              d.dayOpenedAt && t('dashboard.openSince', { time: timeOf(d.money.locale, d.dayOpenedAt) }),
              t('dashboard.updated', { time: timeOf(d.money.locale, d.readAt) }),
            ]
              .filter(Boolean)
              .join(' · ')
          : undefined
      }
      actions={
        <div className="flex flex-wrap items-center gap-3">
          {d && (
            <span className="text-xs text-muted-foreground">
              {d.beforeGoLive ? t('dashboard.beforeGoLive') : t(`dashboard.compared.${period}`)}
            </span>
          )}
          <div
            role="group"
            aria-label={t('dashboard.period')}
            className="flex gap-0.5 rounded-lg border border-line bg-surface p-[3px]"
          >
            {DASHBOARD_PERIOD_VIEWS.map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={p === period}
                onClick={() => setPeriod(p)}
                className={cn(
                  'min-h-8 rounded-md px-3 text-sm',
                  p === period
                    ? 'bg-surface font-semibold text-ink shadow-panel'
                    : 'font-medium text-muted-foreground',
                )}
              >
                {t(`dashboard.periods.${p}`)}
              </button>
            ))}
          </div>
        </div>
      }
    />
  );

  if (error)
    return (
      <>
        {header}
        <p role="alert">{error}</p>
      </>
    );
  if (!d)
    return (
      <>
        {header}
        <p className="text-muted-foreground">{t('dashboard.loading')}</p>
      </>
    );

  const m = d.money;
  const money = (v: number | null) => moneyText(v, m);
  const range = { from: d.current.from, to: d.current.to };
  const before = (v: number | null) => t('dashboard.before', { amount: money(v) });
  const weekdays = weekdaysOf(m.locale);

  const kpis = [
    {
      key: 'sales',
      label: t(period === 'today' ? 'dashboard.kpi.salesSoFar' : 'dashboard.kpi.sales'),
      icon: <Receipt className="size-[18px]" />,
      value: money(d.netSales.now),
      chip: chipText(d.netSales.chip, m, 'percent'),
      tone: 1 as const,
      href: withQuery(href.salesProfit, { ...range, compare: 'none' }),
      details: [
        before(d.netSales.before),
        t('dashboard.kpi.bills', { count: d.netSales.bills, average: money(d.netSales.average) }),
      ],
    },
    ...(d.grossProfit.now !== null
      ? [
          {
            key: 'profit',
            label: t('dashboard.kpi.profit'),
            icon: <TrendingUp className="size-[18px]" />,
            value: money(d.grossProfit.now),
            chip: d.grossProfit.chip && chipText(d.grossProfit.chip, m, 'percent'),
            aside: t('dashboard.kpi.margin', { margin: percentText(d.grossProfit.marginBp, m.locale) }),
            tone: 1 as const,
            href: withQuery(href.profitLoss, range),
            details: [
              before(d.grossProfit.before),
              t('dashboard.kpi.marginWas', { margin: percentText(d.grossProfit.beforeMarginBp, m.locale) }),
            ],
          },
        ]
      : []),
    {
      key: 'cash',
      label: t('dashboard.kpi.cash'),
      icon: <Banknote className="size-[18px]" />,
      value: money(d.cash.now),
      chip: chipText(d.cash.chip, m, 'amount', t('dashboard.kpi.today')),
      tone: 2 as const,
      href: withQuery(href.cashBook, { from: d.today, to: d.today }),
      details: [
        t('dashboard.kpi.drawers', { amount: money(d.cash.drawers), count: d.cash.openSessions }),
        t('dashboard.kpi.safe', { amount: money(d.cash.safe) }),
        ...(d.cash.inTransit !== 0 ? [t('dashboard.kpi.transit', { amount: money(d.cash.inTransit) })] : []),
        t('dashboard.kpi.dayStart', { amount: money(d.cash.atDayStart) }),
      ],
    },
    {
      key: 'bank',
      label: t('dashboard.kpi.bank'),
      icon: <Landmark className="size-[18px]" />,
      value: money(d.bank.now),
      chip: chipText(d.bank.chip, m, 'amount', t('dashboard.kpi.today')),
      tone: 2 as const,
      href: withQuery(href.cashBook, { from: d.today, to: d.today }),
      details: [
        ...d.bank.accounts.map((a) => `${a.name}: ${money(a.balance)}`),
        ...(d.bank.cardClearing !== 0
          ? [t('dashboard.kpi.cards', { amount: money(d.bank.cardClearing) })]
          : []),
      ],
    },
    {
      key: 'owed',
      label: t('dashboard.kpi.owed'),
      icon: <Users className="size-[18px]" />,
      value: money(d.customersOwe.now),
      chip: chipText(d.customersOwe.chip, m, 'percent', t('dashboard.kpi.in30')),
      tone: 2 as const,
      href: withQuery(href.ageing, { side: 'customers' }),
      details: [
        t('dashboard.kpi.customers', { count: d.customersOwe.customers }),
        t('dashboard.kpi.ago30', { amount: money(d.customersOwe.before) }),
        t('dashboard.kpi.received', { amount: money(d.customersOwe.receivedToday) }),
      ],
    },
  ];

  const trendLabel = period === 'today' ? t('dashboard.trend.byHour') : t('dashboard.trend.byDay');
  const nowName = t(`dashboard.trend.now.${period}`);
  const beforeName = t(`dashboard.trend.before.${period}`);
  const day = dayOf(m.locale);
  const leak = d.leak;
  const vrHref = withQuery(href.voidsReturns, range);

  return (
    <>
      {header}
      <div className="flex flex-col gap-4">
        <section
          aria-label={t('dashboard.keyFigures')}
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5"
        >
          {kpis.map(({ key, ...k }) => (
            <StatCard key={key} {...k} />
          ))}
        </section>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <ChartPanel
            title={trendLabel}
            legend={[
              { label: nowName, tone: 1 },
              { label: beforeName, tone: 2, dashed: true },
            ]}
          >
            <TrendChart
              label={trendLabel}
              points={d.trend.points.map((p) => (d.trend.step === 'day' ? day(p.label) : p.label))}
              series={[
                { label: nowName, tone: 1, values: d.trend.points.map((p) => p.now) },
                { label: beforeName, tone: 2, dashed: true, values: d.trend.points.map((p) => p.before) },
              ]}
              format={money}
              tick={(i) => {
                const p = d.trend.points[i]!;
                return d.trend.step === 'day' ? day(p.label) : p.label;
              }}
            />
          </ChartPanel>
          <Card id="dash-attention" title={t('dashboard.attention.title')}>
            {d.attention.length === 0 ? (
              <p className="m-0 text-sm text-muted-foreground">{t('dashboard.attention.none')}</p>
            ) : (
              <ul className="m-0 flex list-none flex-col p-0">
                {d.attention.map((a) => {
                  const Icon = ATTENTION_ICONS[a.kind]!;
                  return (
                    <li key={`${a.kind}-${a.name ?? ''}`}>
                      <a
                        href={attentionHref(a.kind, d.today)}
                        className="flex items-center gap-3 rounded-md px-1 py-2 text-sm text-ink no-underline hover:bg-surface-2"
                      >
                        <span
                          aria-hidden="true"
                          className={cn(
                            'flex size-[30px] flex-none items-center justify-center rounded-lg',
                            a.tone === 'bad' && 'bg-bad-soft text-bad',
                            a.tone === 'warn' && 'bg-warn-soft text-warn',
                            a.tone === 'info' && 'bg-surface-2 text-muted-foreground',
                          )}
                        >
                          <Icon className="size-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="sr-only">{t(`dashboard.attention.tone.${a.tone}`)}: </span>
                          {t(`dashboard.attention.${a.kind}`, {
                            count: a.count,
                            name: a.name,
                            minutes: a.minutes,
                          })}
                        </span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card
            id="dash-busy"
            title={t('dashboard.busy.title')}
            sub={t('dashboard.busy.sub', { weeks: d.busyHours.weeks })}
            link={{
              href: withQuery(href.salesOverTime, { from: d.current.from, to: d.today }),
              label: t('dashboard.busy.link'),
            }}
          >
            {d.busyHours.hours ? (
              <HourGridChart
                label={t('dashboard.busy.title')}
                values={d.busyHours.bills.map((r) => r.map((v) => v / d.busyHours.weeks))}
                hours={d.busyHours.hours}
                weekdays={weekdays}
                hourLabel={hourOf(m.locale)}
                format={(v) => t('dashboard.busy.bills', { count: Math.round(v * 10) / 10 })}
              />
            ) : (
              <p className="m-0 text-sm text-muted-foreground">{t('dashboard.none')}</p>
            )}
          </Card>
          <Card
            id="dash-cats"
            title={t('dashboard.categories.title')}
            sub={t(`dashboard.periods.${period}`)}
            link={{
              href: withQuery(href.salesProfit, { ...range, group: 'category' }),
              label: t('dashboard.categories.link'),
            }}
          >
            <BarList
              label={t('dashboard.categories.title')}
              rows={[
                ...d.topCategories.rows.map((r) => ({
                  key: r.id ?? '',
                  name: r.name || t('dashboard.categories.none'),
                  value: r.sales,
                })),
                ...(d.topCategories.rest !== 0
                  ? [{ key: 'rest', name: t('dashboard.categories.rest'), value: d.topCategories.rest }]
                  : []),
              ]}
              format={money}
            />
          </Card>
          <Card
            id="dash-leak"
            title={t('dashboard.leak.title')}
            sub={t(`dashboard.periods.${period}`)}
            link={{ href: withQuery(href.overridesReport, range), label: t('dashboard.leak.link') }}
          >
            <div className="flex flex-col">
              <LeakRow
                name={t('dashboard.leak.discounts')}
                row={leak.discounts}
                m={m}
                to={withQuery(href.salesOverTime, range)}
                details={before(leak.discounts.usualAmount)}
              />
              <LeakRow
                name={t('dashboard.leak.belowList')}
                row={leak.belowList}
                m={m}
                to={withQuery(href.overridesReport, range)}
                details={t('dashboard.leak.approved', {
                  others: leak.belowList.count - leak.belowList.byOwner,
                  you: leak.belowList.byOwner,
                })}
              />
              <LeakRow
                name={t('dashboard.leak.returns')}
                row={leak.returns}
                m={m}
                to={vrHref}
                details={
                  leak.returns.topReason ? t('dashboard.leak.reason', { reason: leak.returns.topReason }) : ''
                }
              />
              <LeakRow
                name={t('dashboard.leak.voids')}
                row={leak.voids}
                m={m}
                to={vrHref}
                details={t('dashboard.leak.reissued', { count: leak.voids.reissued })}
              />
            </div>
          </Card>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {d.donut && <DonutCard d={d.donut} m={m} t={t} />}
          <Card
            id="dash-owe"
            title={t('dashboard.owe.title')}
            link={{ href: withQuery(href.ageing, { side: 'customers' }), label: t('dashboard.owe.link') }}
          >
            <div className="flex flex-col gap-1">
              <span className="font-display text-[34px] leading-none font-bold tabular-nums">
                {money(d.owe.total)}
              </span>
              <span className="text-xs text-muted-foreground">
                {t('dashboard.owe.count', { count: d.owe.count })}
              </span>
            </div>
            <div className="flex flex-col">
              <span className="pb-1 text-xs font-semibold text-muted-foreground">
                {t('dashboard.owe.most')}
              </span>
              {d.owe.top.map((o) => (
                <Row
                  key={o.id}
                  name={o.name}
                  value={money(o.amount)}
                  href={withQuery(href.partnerLedger, { role: 'customer', partyId: o.id })}
                />
              ))}
              {d.owe.rest.count > 0 && (
                <Row
                  muted
                  name={t('dashboard.owe.rest', { count: d.owe.rest.count })}
                  value={money(d.owe.rest.amount)}
                />
              )}
            </div>
          </Card>
          <Card
            id="dash-suppliers"
            title={t('dashboard.suppliers.title')}
            link={{
              href: withQuery(href.ageing, { side: 'suppliers' }),
              label: t('dashboard.suppliers.link'),
            }}
          >
            <span className="font-display text-[34px] leading-none font-bold tabular-nums">
              {money(d.suppliers.total)}
            </span>
            <div className="grid grid-cols-2 gap-2.5">
              <div className="flex flex-col gap-0.5 rounded-lg bg-bad-soft px-3 py-2.5">
                <span className="text-xs font-semibold text-bad">{t('dashboard.suppliers.overdue')}</span>
                <span className="font-semibold tabular-nums">{money(d.suppliers.overdue)}</span>
              </div>
              <div className="flex flex-col gap-0.5 rounded-lg bg-warn-soft px-3 py-2.5">
                <span className="text-xs font-semibold text-warn">{t('dashboard.suppliers.due7')}</span>
                <span className="font-semibold tabular-nums">{money(d.suppliers.dueIn7Days)}</span>
              </div>
            </div>
          </Card>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card
            id="dash-stock"
            title={t('dashboard.stock.title')}
            link={{ href: href.stockReport, label: t('dashboard.stock.link') }}
          >
            <div className="flex flex-col">
              {d.stock.value !== null && (
                <Row name={t('dashboard.stock.value')} value={money(d.stock.value)} href={href.stockReport} />
              )}
              <Row
                name={t('dashboard.stock.atMinimum')}
                value={t('dashboard.stock.items', { count: d.stock.atMinimum })}
                href={href.reorder}
              />
              <Row
                name={t('dashboard.stock.negative')}
                value={t('dashboard.stock.items', { count: d.stock.negative })}
                href={href.stockReport}
              />
              <Row
                name={t('dashboard.stock.dead')}
                value={
                  d.stock.dead.value === null
                    ? t('dashboard.stock.items', { count: d.stock.dead.count })
                    : `${t('dashboard.stock.items', { count: d.stock.dead.count })} · ${money(d.stock.dead.value)}`
                }
                href={withQuery(href.deadStock, { days: DEAD_DAYS })}
              />
            </div>
          </Card>
          <Card
            id="dash-items"
            title={t('dashboard.items.title')}
            sub={t(`dashboard.periods.${period}`)}
            link={{
              href: withQuery(href.salesProfit, { ...range, group: 'item' }),
              label: t('dashboard.items.link'),
            }}
          >
            {d.bestItems.length === 0 ? (
              <p className="m-0 text-sm text-muted-foreground">{t('dashboard.none')}</p>
            ) : (
              <div className="flex flex-col">
                {d.bestItems.map((i) => (
                  <Row
                    key={i.id}
                    name={
                      <>
                        {i.name}
                        <span className="text-muted-foreground"> · {qtyText(i.qty)}</span>
                      </>
                    }
                    value={money(i.sales)}
                    href={href.item(i.id)}
                  />
                ))}
              </div>
            )}
          </Card>
          <Card
            id="dash-salesmen"
            title={t('dashboard.salesmen.title')}
            sub={t(`dashboard.periods.${period}`)}
            link={{
              href: withQuery(href.salesProfit, { ...range, group: 'salesman' }),
              label: t('dashboard.salesmen.link'),
            }}
          >
            {d.salesmen.length === 0 ? (
              <p className="m-0 text-sm text-muted-foreground">{t('dashboard.none')}</p>
            ) : (
              <BarList
                label={t('dashboard.salesmen.title')}
                rows={d.salesmen.map((s) => ({
                  key: s.id,
                  name: t('dashboard.salesmen.row', { name: s.name, count: s.bills }),
                  value: s.sales,
                }))}
                format={money}
              />
            )}
          </Card>
        </div>

        <p className="m-0 text-xs text-muted-foreground">{t('dashboard.footer')}</p>
      </div>
    </>
  );
}
