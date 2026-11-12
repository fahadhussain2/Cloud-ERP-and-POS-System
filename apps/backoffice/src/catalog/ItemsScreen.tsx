import type { ItemList } from '@erp/contracts';
import {
  Button,
  Checkbox,
  formatMoney,
  Input,
  LABEL_CLASS,
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
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import { href } from '../router';
import { LiveNotice } from './LiveNotice';
import { NONE, useLookups } from './data';

// Items (W1-15, CAT-01, CAT-02): one search over code, name, brand and every barcode or OEM number, as on the counter,
// with category and status filters; 50 a page, from the server (19,552 items).

const PAGE = 50;
const WAIT_MS = 250;

export const statusTone: Record<string, ChipTone> = {
  active: 'ok',
  dormant: 'warn',
  discontinued: 'neutral',
};

export function ItemsScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const { lookups } = useLookups(api);
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState(NONE);
  const [status, setStatus] = useState(NONE);
  const [page, setPage] = useState(1);
  const [list, setList] = useState<ItemList | null>(null);
  // Items picked for a relabel (W1-17), kept across pages and searches, in the order picked.
  const [picked, setPicked] = useState<string[]>([]);
  const pick = (id: string, on: boolean) =>
    setPicked((p) => (on ? (p.includes(id) ? p : [...p, id]) : p.filter((x) => x !== id)));
  const searchId = useId();
  const categoryId = useId();
  const statusId = useId();

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
    void api('GET', `/api/catalog/items?${qs.toString()}`).then(
      (r) => live && setList(r.status === 200 ? (r.body as ItemList) : { items: [], total: 0 }),
    );
    return () => {
      live = false;
    };
  }, [api, query, category, status, page]);

  const pages = list ? Math.max(1, Math.ceil(list.total / PAGE)) : 1;

  return (
    <>
      <PageHeader
        title={t('catalog.items.title')}
        help={t('catalog.items.help')}
        actions={
          <span className="flex flex-wrap gap-2">
            {lookups?.can.printLabels &&
              (picked.length > 0 ? (
                <Button asChild size="lg" variant="outline">
                  <a href={href.itemLabels(picked)}>{`${t('labels.makeLabels')} (${picked.length})`}</a>
                </Button>
              ) : (
                <Button size="lg" variant="outline" disabled>
                  {`${t('labels.makeLabels')} (0)`}
                </Button>
              ))}
            {lookups?.can.editItems && (
              <Button asChild size="lg">
                <a href={href.newItem}>{t('catalog.items.add')}</a>
              </Button>
            )}
          </span>
        }
      />
      {lookups && <LiveNotice lookups={lookups} />}
      <Panel className="flex flex-wrap items-end gap-3 p-3.5">
        <div className="flex min-w-64 flex-1 flex-col gap-1">
          <label htmlFor={searchId} className={LABEL_CLASS}>
            {t('catalog.items.search')}
          </label>
          <Input
            id={searchId}
            type="search"
            className="h-10"
            value={text}
            placeholder={t('catalog.items.searchHint')}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <Filter
          id={categoryId}
          label={t('catalog.fields.category')}
          value={category}
          onChange={(v) => {
            setCategory(v);
            setPage(1);
          }}
        >
          <option value={NONE}>{t('catalog.items.all')}</option>
          {lookups?.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.code} · {c.name}
            </option>
          ))}
        </Filter>
        <Filter
          id={statusId}
          label={t('catalog.fields.status')}
          value={status}
          onChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
        >
          <option value={NONE}>{t('catalog.items.all')}</option>
          {(['active', 'dormant', 'discontinued'] as const).map((s) => (
            <option key={s} value={s}>
              {t(`catalog.status.${s}`)}
            </option>
          ))}
        </Filter>
      </Panel>
      <Panel>
        {list === null || lookups === null ? (
          <p className="p-3.5 text-muted-foreground">{t('app.loading')}</p>
        ) : list.items.length === 0 ? (
          <p className="p-3.5 text-muted-foreground">{t('catalog.items.empty')}</p>
        ) : (
          <div className="px-1.5 pb-2.5">
            <Table aria-label={t('catalog.items.title')}>
              <TableHeader>
                <TableRow>
                  {lookups.can.printLabels && <TableHead className="w-10" />}
                  <TableHead>{t('catalog.fields.code')}</TableHead>
                  <TableHead>{t('catalog.fields.name')}</TableHead>
                  <TableHead>{t('catalog.fields.brand')}</TableHead>
                  <TableHead>{t('catalog.fields.category')}</TableHead>
                  <TableHead className="text-end">{t('catalog.items.retail')}</TableHead>
                  <TableHead>{t('catalog.fields.status')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.items.map((i) => (
                  <TableRow key={i.id}>
                    {lookups.can.printLabels && (
                      <TableCell>
                        <Checkbox
                          aria-label={t('labels.pick', { code: i.code })}
                          checked={picked.includes(i.id)}
                          onCheckedChange={(v) => pick(i.id, v === true)}
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
                    <TableCell>{i.name}</TableCell>
                    <TableCell>{i.brand ?? '—'}</TableCell>
                    <TableCell>{i.category}</TableCell>
                    <TableCell className="text-end tabular-nums">
                      {i.retail === null ? '—' : formatMoney(i.retail, lookups.money)}
                    </TableCell>
                    <TableCell>
                      <StatusChip tone={statusTone[i.status] ?? 'neutral'}>
                        {t(`catalog.status.${i.status}`)}
                      </StatusChip>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {list && list.total > 0 && (
          <div className="flex items-center gap-2 px-3.5 pb-3">
            <span className="me-auto text-sm text-muted-foreground" role="status">
              {t('catalog.items.count', { count: list.total, page, pages })}
            </span>
            <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              {t('catalog.items.previous')}
            </Button>
            <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => setPage(page + 1)}>
              {t('catalog.items.next')}
            </Button>
          </div>
        )}
      </Panel>
    </>
  );
}

function Filter({
  id,
  label,
  value,
  onChange,
  children,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className={LABEL_CLASS}>
        {label}
      </label>
      <select
        id={id}
        className="h-10 rounded-md border border-input bg-surface px-2"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
    </div>
  );
}
