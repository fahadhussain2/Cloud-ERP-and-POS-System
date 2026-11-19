import { cn, Panel } from '@erp/ui';
import { useState, type ReactNode } from 'react';

// The reports' first charts (W2-03 plan, owner answer 5): a trend over time, the busy hours of the week and a bar list,
// drawn as SVG and HTML by us (no chart library). Colours are the theme's chart tokens (this period, the comparison),
// checked for colour blindness and contrast in both modes; the comparison is also dashed, so it reads on paper in black
// and white. Every chart sits above a table with the same figures (the table is the accessible view, and what the CSV
// holds); hovering a point shows its figures. Text uses the ink tokens, never a series colour.

/** A chart's frame: its title, its legend and the drawing. */
export function ChartPanel({
  title,
  legend,
  children,
}: {
  title: string;
  legend?: { label: string; tone: 1 | 2; dashed?: boolean }[];
  children: ReactNode;
}) {
  return (
    <Panel className="flex flex-col gap-2 p-3.5 break-inside-avoid">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="m-0 text-base font-semibold">{title}</h2>
        {legend && legend.length > 1 && (
          <ul className="m-0 flex list-none flex-wrap gap-4 p-0 text-sm text-muted-foreground">
            {legend.map((l) => (
              <li key={l.label} className="flex items-center gap-1.5">
                <svg width="20" height="8" aria-hidden="true">
                  <line
                    x1="1"
                    x2="19"
                    y1="4"
                    y2="4"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeDasharray={l.dashed ? '4 3' : undefined}
                    className={l.tone === 1 ? 'stroke-chart-1' : 'stroke-chart-2'}
                  />
                </svg>
                {l.label}
              </li>
            ))}
          </ul>
        )}
      </div>
      {children}
    </Panel>
  );
}

const W = 720;
const H = 220;
const PAD = { top: 12, bottom: 24, start: 64, end: 12 };

/** A round step for the axis: 1, 2 or 5 × a power of ten, about four of them. */
function ticksOf(min: number, max: number): number[] {
  const span = max - min || Math.abs(max) || 1;
  const raw = span / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw)!;
  const out: number[] = [];
  for (let v = Math.floor(min / step) * step; v <= max + step / 2; v += step) out.push(v);
  return out;
}

export interface TrendSeries {
  label: string;
  tone: 1 | 2;
  dashed?: boolean;
  /** One per point; null where the series has none. */
  values: (number | null)[];
}

/**
 * Lines over time on one axis: this period, and the comparison bucket by bucket. The time axis runs with the page's
 * direction (right to left on a right-to-left page).
 */
export function TrendChart({
  label,
  points,
  series,
  format,
  tick,
  rtl = typeof document !== 'undefined' && document.documentElement.dir === 'rtl',
}: {
  label: string;
  /** A short label for each point (its date). */
  points: string[];
  series: TrendSeries[];
  format: (v: number) => string;
  /** A short label for the axis, for some of the points. */
  tick: (i: number) => string;
  rtl?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const ticks = ticksOf(Math.min(0, ...all), Math.max(0, ...all));
  const lo = ticks[0]!;
  const hi = ticks.at(-1)!;
  const n = points.length;
  const plotW = W - PAD.start - PAD.end;
  const plotH = H - PAD.top - PAD.bottom;
  const xAt = (i: number) => {
    const x = PAD.start + (n === 1 ? plotW / 2 : (i * plotW) / (n - 1));
    return rtl ? W - x : x;
  };
  const yAt = (v: number) => PAD.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
  const every = Math.max(1, Math.ceil(n / 8));
  const at = hover ?? null;
  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={label}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((v) => (
          <g key={v}>
            <line
              x1={rtl ? W - PAD.start : PAD.start}
              x2={rtl ? PAD.end : W - PAD.end}
              y1={yAt(v)}
              y2={yAt(v)}
              className={v === 0 ? 'stroke-muted-foreground' : 'stroke-line'}
              strokeWidth="1"
            />
            <text
              x={rtl ? W - PAD.start + 6 : PAD.start - 6}
              y={yAt(v)}
              textAnchor={rtl ? 'start' : 'end'}
              dominantBaseline="middle"
              className="fill-muted-foreground text-[11px]"
            >
              {format(v)}
            </text>
          </g>
        ))}
        {points.map((_, i) =>
          i % every === 0 ? (
            <text
              key={i}
              x={xAt(i)}
              y={H - 6}
              textAnchor="middle"
              className="fill-muted-foreground text-[11px]"
            >
              {tick(i)}
            </text>
          ) : null,
        )}
        {at !== null && (
          <line
            x1={xAt(at)}
            x2={xAt(at)}
            y1={PAD.top}
            y2={PAD.top + plotH}
            className="stroke-muted-foreground"
            strokeWidth="1"
          />
        )}
        {series.map((s) => {
          const d = s.values
            .map((v, i) => (v === null ? null : `${xAt(i)},${yAt(v)}`))
            .filter((x) => x !== null)
            .join(' L ');
          return d ? (
            <path
              key={s.label}
              d={`M ${d}`}
              fill="none"
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
              strokeDasharray={s.dashed ? '6 4' : undefined}
              className={s.tone === 1 ? 'stroke-chart-1' : 'stroke-chart-2'}
            />
          ) : null;
        })}
        {at !== null &&
          series.map((s) =>
            s.values[at] === null || s.values[at] === undefined ? null : (
              <circle
                key={s.label}
                cx={xAt(at)}
                cy={yAt(s.values[at])}
                r="4"
                strokeWidth="2"
                className={cn('stroke-surface', s.tone === 1 ? 'fill-chart-1' : 'fill-chart-2')}
              />
            ),
          )}
        {/* Hit areas wider than the line: one band per point. */}
        {points.map((_, i) => (
          <rect
            key={i}
            x={xAt(i) - plotW / Math.max(n - 1, 1) / 2}
            y={PAD.top}
            width={plotW / Math.max(n - 1, 1)}
            height={plotH}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
          />
        ))}
      </svg>
      {at !== null && (
        <div
          role="status"
          className="pointer-events-none absolute top-1 rounded-md border border-line bg-surface px-2 py-1 text-sm whitespace-nowrap shadow-md print:hidden"
          style={{ insetInlineStart: `${Math.min(60, (xAt(at) / W) * 100)}%` }}
        >
          <div className="font-semibold">{points[at]}</div>
          {series.map((s) => (
            <div key={s.label} className="flex justify-between gap-3 tabular-nums">
              <span className="text-muted-foreground">{s.label}</span>
              <span>{s.values[at] === null || s.values[at] === undefined ? '—' : format(s.values[at])}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Weekdays down, hours across: each cell's colour is one hue, lighter to darker with its share of the busiest cell
 * (empty cells are the surface). Its figures show on hover and in the cell's title.
 */
export function HourGridChart({
  label,
  values,
  hours,
  weekdays,
  hourLabel,
  format,
}: {
  label: string;
  /** [weekday][hour], Monday first. */
  values: number[][];
  hours: { first: number; last: number };
  weekdays: string[];
  hourLabel: (h: number) => string;
  format: (v: number) => string;
}) {
  const span = Array.from({ length: hours.last - hours.first + 1 }, (_, i) => hours.first + i);
  const max = Math.max(1, ...values.flat());
  return (
    <div className="overflow-x-auto">
      <table aria-label={label} className="border-separate border-spacing-0.5 text-xs">
        <thead>
          <tr>
            <th />
            {span.map((h) => (
              <th key={h} scope="col" className="px-0.5 font-normal text-muted-foreground">
                {hourLabel(h)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weekdays.map((day, d) => (
            <tr key={day}>
              <th scope="row" className="pe-2 text-start font-normal text-muted-foreground">
                {day}
              </th>
              {span.map((h) => {
                const v = values[d]?.[h] ?? 0;
                return (
                  <td
                    key={h}
                    title={`${day} ${hourLabel(h)}: ${format(v)}`}
                    className={cn('size-7 min-w-7 rounded-sm', v === 0 ? 'bg-surface-2' : 'bg-chart-1')}
                    style={v === 0 ? undefined : { opacity: 0.15 + (0.85 * v) / max }}
                  >
                    <span className="sr-only">{format(v)}</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Horizontal bars from a common start, largest first; a negative figure (a loss) is drawn lighter. */
export function BarList({
  label,
  rows,
  format,
}: {
  label: string;
  rows: { key: string; name: ReactNode; value: number }[];
  format: (v: number) => string;
}) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  return (
    <ol aria-label={label} className="m-0 flex list-none flex-col gap-1.5 p-0">
      {rows.map((r) => (
        <li key={r.key} className="grid grid-cols-[minmax(8rem,16rem)_1fr_auto] items-center gap-3 text-sm">
          <span className="truncate">{r.name}</span>
          <span className="h-3 rounded-e bg-surface-2">
            <span
              className={cn('block h-3 rounded-e bg-chart-1', r.value < 0 && 'opacity-40')}
              style={{ inlineSize: `${(Math.abs(r.value) / max) * 100}%` }}
            />
          </span>
          <span className="tabular-nums">{format(r.value)}</span>
        </li>
      ))}
    </ol>
  );
}
