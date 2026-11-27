import { ITEM_LEVEL_FILTERS, type ItemList, type ItemRow, type StockLevel } from '@erp/contracts';
import {
  formatMoney,
  PageHeader,
  Panel,
  StatusChip,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  type ChipTone,
} from '@erp/ui';
import { ChevronLeft, ChevronRight, Plus, Tag } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import { href } from '../router';
import { Button, buttonClass, Checkbox, ListPicker, ListToolbar, Select } from '../ui';
import { NONE, qtyText, useLookups } from './data';

// Items (W1-15, CAT-01, CAT-02): one search over code, name, brand and every barcode or OEM number, as on the counter,
// with category and status filters; 50 a page, from the server (19,552 items). W1-26: one line per item with its unit,
// average cost, Retail, the quantity in each shop- and storage-kind location (Shop, Godown), the stock value and a
// level from its minimum; a level filter, sorting by stock and value, and the value of every match. Cost and value
// only with cost.view; a quantity links to the stock card for those who can open it. W2-14 (D-127): the back office's
// own controls, the search and filters in the table's toolbar; the category is searched (owner answer 3).

const PAGE = 50;
/** A filter's "All", as an option (a dropdown's option can't be empty). */
const ALL = 'all';
const WAIT_MS = 250;

export const statusTone: Record<string, ChipTone> = {
  active: 'ok',
  dormant: 'warn',
  discontinued: 'neutral',
};

const levelTone: Record<StockLevel, ChipTone> = { ok: 'ok', low: 'warn', out: 'bad' };

/** The list's order: by code (the default), by stock value, or by a location's quantity (its id). */
interface Sort {
  key: string;
  dir: 'asc' | 'desc';
}
const BY_CODE: Sort = { key: 'code', dir: 'asc' };

export function ItemsScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const { lookups } = useLookups(api);
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState(NONE);
  const [status, setStatus] = useState(NONE);
  const [level, setLevel] = useState(NONE);
  const [sort, setSort] = useState<Sort>(BY_CODE);
  const [page, setPage] = useState(1);
  const [list, setList] = useState<ItemList | null>(null);
  // Items picked for a relabel (W1-17), kept across pages and searches, in the order picked.
  const [picked, setPicked] = useState<string[]>([]);
  const pick = (id: string, on: boolean) =>
    setPicked((p) => (on ? (p.includes(id) ? p : [...p, id]) : p.filter((x) => x !== id)));

  // Search as you type, a moment after the last key.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(text);
      setPage(1);
    }, WAIT_MS);
    return () => clearTimeout(timer);
  }, [text]);

  useEffect(() => {
    let live = true;
    const qs = new URLSearchParams({ q: query, page: String(page), pageSize: String(PAGE) });
    if (category) qs.set('category', category);
    if (status) qs.set('status', status);
    if (level) qs.set('level', level);
    if (sort !== BY_CODE) {
      qs.set('sort', sort.key);
      qs.set('dir', sort.dir);
    }
    void api('GET', `/api/catalog/items?${qs.toString()}`).then(
      (r) =>
        live && setList(r.status === 200 ? (r.body as ItemList) : { items: [], total: 0, locations: [] }),
    );
    return () => {
      live = false;
    };
  }, [api, query, category, status, level, sort, page]);

  const pages = list ? Math.max(1, Math.ceil(list.total / PAGE)) : 1;
  const costs = list?.totalValue !== undefined;
  // A new column sorts biggest first; the same column again turns it round.
  const sortBy = (key: string) => {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }));
    setPage(1);
  };
  const sorted = (key: string): 'ascending' | 'descending' | undefined =>
    sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined;
  const money = (v: number) => (lookups ? formatMoney(v, lookups.money) : '');

  return (
    <>
      <PageHeader
        title={t('catalog.items.title')}
        help={t('catalog.items.help')}
        actions={
          <span className="flex flex-wrap gap-2">
            {lookups?.can.printLabels &&
              (picked.length > 0 ? (
                <a href={href.itemLabels(picked)} className={buttonClass('outline')}>
                  <Tag aria-hidden="true" className="size-4" />
                  {`${t('labels.makeLabels')} (${picked.length})`}
                </a>
              ) : (
                <Button variant="outline" icon={Tag} disabled>
                  {`${t('labels.makeLabels')} (0)`}
                </Button>
              ))}
            {lookups?.can.editItems && (
              <a href={href.newItem} className={buttonClass()}>
                <Plus aria-hidden="true" className="size-4" />
                {t('catalog.items.add')}
              </a>
            )}
          </span>
        }
      />
      <Panel className="overflow-hidden p-0">
        <ListToolbar
          search={{
            label: t('catalog.items.search'),
            placeholder: t('catalog.items.searchHint'),
            value: text,
            onChange: setText,
          }}
        >
          <ListPicker
            hideLabel
            className="w-56"
            label={t('catalog.fields.category')}
            placeholder={t('catalog.items.allCategories')}
            options={lookups?.categories ?? []}
            value={category}
            onChange={(v) => {
              setCategory(v);
              setPage(1);
            }}
          />
          <Select
            aria-label={t('catalog.fields.status')}
            wrapperClassName="w-40"
            value={status || ALL}
            onValueChange={(v) => {
              setStatus(v === ALL ? NONE : v);
              setPage(1);
            }}
            options={[
              { value: ALL, label: t('catalog.items.allStatuses') },
              ...(['active', 'dormant', 'discontinued'] as const).map((s) => ({
                value: s,
                label: t(`catalog.status.${s}`),
              })),
            ]}
          />
          <Select
            aria-label={t('catalog.items.level')}
            wrapperClassName="w-44"
            value={level || ALL}
            onValueChange={(v) => {
              setLevel(v === ALL ? NONE : v);
              setPage(1);
            }}
            options={[
              { value: ALL, label: t('catalog.items.allLevels') },
              ...ITEM_LEVEL_FILTERS.map((l) => ({ value: l, label: t(`catalog.items.levelFilters.${l}`) })),
            ]}
          />
        </ListToolbar>
        {list === null || lookups === null ? (
          <p className="p-3.5 text-muted-foreground">{t('app.loading')}</p>
        ) : list.items.length === 0 ? (
          <p className="p-3.5 text-muted-foreground">{t('catalog.items.empty')}</p>
        ) : (
          <div className="overflow-x-auto px-1.5 pb-2.5">
            <Table aria-label={t('catalog.items.title')}>
              <TableHeader>
                <TableRow>
                  {lookups.can.printLabels && <TableHead className="w-10" />}
                  <TableHead>{t('catalog.fields.code')}</TableHead>
                  <TableHead>{t('catalog.items.item')}</TableHead>
                  <TableHead>{t('catalog.fields.brand')}</TableHead>
                  <TableHead>{t('catalog.items.unit')}</TableHead>
                  {costs && <TableHead className="text-end">{t('catalog.items.cost')}</TableHead>}
                  <TableHead className="text-end">{t('catalog.items.salePrice')}</TableHead>
                  {list.locations.map((l) => (
                    <SortHead key={l.id} label={l.name} sorted={sorted(l.id)} onSort={() => sortBy(l.id)} />
                  ))}
                  {costs && (
                    <SortHead
                      label={t('catalog.items.value')}
                      sorted={sorted('value')}
                      onSort={() => sortBy('value')}
                    />
                  )}
                  <TableHead>{t('catalog.items.level')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.items.map((i) => (
                  <TableRow key={i.id}>
                    {lookups.can.printLabels && (
                      <TableCell>
                        <Checkbox
                          hideLabel
                          label={t('labels.pick', { code: i.code })}
                          checked={picked.includes(i.id)}
                          onCheckedChange={(v) => pick(i.id, v)}
                        />
                      </TableCell>
                    )}
                    <TableCell className="font-mono">
                      <a
                        href={href.item(i.id)}
                        className="font-semibold text-ink underline-offset-4 hover:underline"
                      >
                        {i.code}
                      </a>
                    </TableCell>
                    <TableCell>
                      {i.name}
                      {i.status !== 'active' && (
                        <span className="ms-2">
                          <StatusChip tone={statusTone[i.status] ?? 'neutral'}>
                            {t(`catalog.status.${i.status}`)}
                          </StatusChip>
                        </span>
                      )}
                    </TableCell>
                    <TableCell>{i.brand ?? '—'}</TableCell>
                    <TableCell>{i.unit}</TableCell>
                    {costs && (
                      <TableCell className="text-end tabular-nums">
                        {i.avgCost === null || i.avgCost === undefined ? (
                          <span className="text-muted-foreground">{t('catalog.items.noCost')}</span>
                        ) : (
                          money(i.avgCost)
                        )}
                      </TableCell>
                    )}
                    <TableCell className="text-end tabular-nums">
                      {i.retail === null ? '—' : money(i.retail)}
                    </TableCell>
                    {list.locations.map((l) => (
                      <TableCell key={l.id} className="text-end tabular-nums">
                        <Quantity item={i} qty={i.stock[l.id] ?? 0} link={lookups.can.stockCard} />
                      </TableCell>
                    ))}
                    {costs && (
                      <TableCell
                        className={`text-end tabular-nums ${(i.value ?? 0) < 0 ? 'text-destructive' : ''}`}
                      >
                        {money(i.value ?? 0)}
                      </TableCell>
                    )}
                    <TableCell>
                      <StatusChip tone={levelTone[i.level]}>
                        {t(`catalog.items.levels.${i.level}`)}
                      </StatusChip>
                    </TableCell>
                  </TableRow>
                ))}
                {costs && (
                  <TableRow>
                    <TableCell
                      colSpan={(lookups.can.printLabels ? 1 : 0) + 6 + list.locations.length}
                      className="font-semibold"
                    >
                      {t('catalog.items.totalValue')}
                    </TableCell>
                    <TableCell className="text-end font-semibold tabular-nums">
                      {money(list.totalValue ?? 0)}
                    </TableCell>
                    <TableCell />
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
        {list && list.total > 0 && (
          <div className="flex items-center gap-2 px-3.5 pb-3">
            <span className="me-auto text-sm text-muted-foreground" role="status">
              {t('catalog.items.count', { count: list.total, page, pages })}
            </span>
            <Button
              size="sm"
              variant="outline"
              icon={ChevronLeft}
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              {t('catalog.items.previous')}
            </Button>
            <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => setPage(page + 1)}>
              {t('catalog.items.next')}
              <ChevronRight aria-hidden="true" className="size-4" />
            </Button>
          </div>
        )}
      </Panel>
    </>
  );
}

/** A sortable column's header: a button that sorts by it, biggest first, then the other way. */
function SortHead({
  label,
  sorted,
  onSort,
}: {
  label: string;
  sorted: 'ascending' | 'descending' | undefined;
  onSort: () => void;
}) {
  return (
    <TableHead className="text-end" aria-sort={sorted ?? 'none'}>
      <button type="button" className="font-semibold underline-offset-4 hover:underline" onClick={onSort}>
        {label}
      </button>
      {sorted && (
        <span aria-hidden="true" className="ms-1">
          {sorted === 'descending' ? '↓' : '↑'}
        </span>
      )}
    </TableHead>
  );
}

/** A quantity in thousandths: decimals only where there are some, below zero in red, a link to the stock card. */
function Quantity({ item, qty, link }: { item: ItemRow; qty: number; link: boolean }) {
  const text = qtyText(qty);
  const tone = qty < 0 ? 'text-destructive' : qty === 0 ? 'text-muted-foreground' : '';
  return link ? (
    <a href={href.stockCard(item.id)} className={`underline-offset-4 hover:underline ${tone}`}>
      {text}
    </a>
  ) : (
    <span className={tone}>{text}</span>
  );
}
