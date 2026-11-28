import type { CatalogLookups } from '@erp/contracts';
import { PageHeader, Panel, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@erp/ui';
import { Save } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import { Button, notify, TextBox } from '../ui';
import { catalogRefusal, useLookups } from './data';

// Categories (W1-15, CAT-05): each category's floor margin, the "+ 5 %" of floor = cost + margin (PRD Q2). Changing it
// re-writes the category's floors from cost at once, so the counters get them at their next pull. The owner only
// (cat.price.edit, owner answer 3). W2-14 (D-127): the back office's own controls; results and refusals are toasts.

/** Basis points as a percentage for a field: 500 → "5", 250 → "2.5". */
export const percentText = (bp: number | null) => (bp === null ? '' : String(bp / 100));
/** A percentage field as basis points: null when empty, undefined when not 0–100 with at most 2 decimals. */
export function percentValue(text: string): number | null | undefined {
  const s = text.trim();
  if (s === '') return null;
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return undefined;
  const bp = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return bp <= 10_000 ? bp : undefined;
}

export function CategoriesScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const { lookups, reload } = useLookups(api);
  if (lookups === null) return <p className="text-muted-foreground">{t('app.loading')}</p>;
  return (
    <>
      <PageHeader title={t('catalog.categories.title')} help={t('catalog.categories.help')} />
      <Panel className="overflow-x-auto px-1.5 pb-2.5">
        <Table aria-label={t('catalog.categories.title')}>
          <TableHeader>
            <TableRow>
              <TableHead>{t('catalog.fields.code')}</TableHead>
              <TableHead>{t('catalog.fields.name')}</TableHead>
              <TableHead>{t('catalog.categories.margin')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lookups.categories.map((c) => (
              <CategoryRow
                key={`${c.id}:${c.rowVersion}`}
                category={c}
                can={lookups.can.editPrices}
                onSave={async (bp) => {
                  const r = await api('PATCH', `/api/catalog/categories/${encodeURIComponent(c.id)}`, {
                    rowVersion: c.rowVersion,
                    floorMarginBp: bp,
                  });
                  if (r.status === 200) {
                    notify.done(t('catalog.categories.saved', { code: c.code }));
                    await reload();
                  } else notify.problem(catalogRefusal(t, (k) => t(k) !== k, r.body));
                }}
              />
            ))}
          </TableBody>
        </Table>
      </Panel>
    </>
  );
}

function CategoryRow({
  category,
  can,
  onSave,
}: {
  category: CatalogLookups['categories'][number];
  can: boolean;
  onSave: (bp: number | null) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(percentText(category.floorMarginBp));
  const value = percentValue(text);
  const changed = value !== undefined && value !== category.floorMarginBp;
  return (
    <TableRow>
      <TableCell className="font-mono">{category.code}</TableCell>
      <TableCell>{category.name}</TableCell>
      <TableCell>
        {can ? (
          <span className="flex items-center gap-2">
            <TextBox
              aria-label={t('catalog.categories.marginOf', { code: category.code })}
              aria-invalid={value === undefined ? true : undefined}
              className="w-24"
              inputMode="decimal"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <span>%</span>
            {changed && (
              <Button size="sm" icon={Save} onClick={() => void onSave(value)}>
                {t('catalog.categories.save')}
              </Button>
            )}
          </span>
        ) : category.floorMarginBp === null ? (
          '—'
        ) : (
          `${percentText(category.floorMarginBp)} %`
        )}
      </TableCell>
    </TableRow>
  );
}
