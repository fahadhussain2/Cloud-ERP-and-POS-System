import { itemProblems, money, proposeTierPrices } from '@erp/domain';
import { PageHeader, Panel } from '@erp/ui';
import { Plus } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import { href } from '../router';
import { Button, ListPicker, notify, Select, TextInput } from '../ui';
import { catalogRefusal, moneyText, moneyValue, NONE, useLookups } from './data';

// A new item (W1-15, CAT-01): code, name, category and unit; its barcode = its code is added by the server. The owner
// also prices it, with Mechanic and Wholesale proposed at −5 % and −10 % of Retail (PRD Q1); a manager adds it
// without prices and the owner prices it after (owner answer 3). W2-14 (D-127): the back office's own controls, every
// problem at its field at once (owner answer 6), a refusal that isn't one field's in a toast.

type Field = 'code' | 'name' | 'categoryId' | 'unitId';
/** Which field each of the item checks' problems is about. */
const FIELD_OF: Record<string, Field> = {
  code_required: 'code',
  code_format: 'code',
  name_required: 'name',
  name_too_long: 'name',
  category_required: 'categoryId',
  unit_required: 'unitId',
};

export function NewItemScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const { lookups } = useLookups(api);
  const [f, setF] = useState({ code: '', name: '', categoryId: NONE, unitId: NONE });
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  // Problems by field, and by tier code for the prices.
  const [problems, setProblems] = useState<Record<string, string | undefined>>({});
  const [tried, setTried] = useState(0);
  const form = useRef<HTMLFormElement>(null);

  // After a save is tried, focus goes to the first field marked wrong (owner answer 6).
  useEffect(() => {
    if (tried === 0) return;
    form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [tried]);

  if (lookups === null) return <p className="text-muted-foreground">{t('app.loading')}</p>;
  const m = lookups.money;
  const can = lookups.can.editPrices;
  const clear = (k: string) => setProblems((p) => (p[k] ? { ...p, [k]: undefined } : p));

  // Typing Retail proposes the other tiers, until someone types one of them.
  const setRetail = (text: string) => {
    const retail = moneyValue(text, m.minorUnits);
    const proposed =
      typeof retail === 'number' ? proposeTierPrices(money(retail)) : ({} as Record<string, number>);
    setPrices((p) => {
      const next: Record<string, string> = { ...p, RETAIL: text };
      for (const tier of lookups.tiers)
        if (tier.code !== 'RETAIL' && !touched[tier.code])
          next[tier.code] = moneyText((proposed as Record<string, number>)[tier.code] ?? null, m.minorUnits);
      return next;
    });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const unit = lookups.units.find((u) => u.id === f.unitId);
    const checked = itemProblems({
      code: f.code,
      name: f.name,
      categoryId: f.categoryId || null,
      unitId: f.unitId || null,
      allowsFraction: unit?.allowsFraction ?? false,
      minQty: null,
      maxQty: null,
    });
    const wrong: Record<string, string> = {};
    for (const p of checked.problems) {
      const field = FIELD_OF[p];
      if (field && !wrong[field]) wrong[field] = t(`catalog.problems.${p}`);
    }
    const priced = can
      ? Object.fromEntries(lookups.tiers.map((x) => [x.code, moneyValue(prices[x.code] ?? '', m.minorUnits)]))
      : null;
    if (priced)
      for (const [code, v] of Object.entries(priced))
        if (v === undefined) wrong[code] = t('catalog.problems.price_number');
    setProblems(wrong);
    if (Object.keys(wrong).length > 0) return setTried((n) => n + 1);
    const r = await api('POST', '/api/catalog/items', {
      code: checked.code,
      name: checked.name,
      categoryId: f.categoryId,
      unitId: f.unitId,
      ...(priced ? { prices: priced } : {}),
    });
    if (r.status === 201) {
      notify.done(t('catalog.newItem.added', { code: checked.code }));
      window.location.hash = href.item((r.body as { id: string }).id);
    } else notify.problem(catalogRefusal(t, (k) => t(k) !== k, r.body));
  };

  const back = (
    <a
      href={href.items}
      className="text-sm font-medium text-muted-foreground underline-offset-4 hover:underline"
    >
      ← {t('catalog.item.back')}
    </a>
  );
  return (
    <>
      <PageHeader eyebrow={back} title={t('catalog.newItem.title')} help={t('catalog.newItem.help')} />
      <Panel>
        <form ref={form} className="flex flex-col gap-3.5 p-3.5" onSubmit={(e) => void submit(e)} noValidate>
          <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
            <TextInput
              label={t('catalog.fields.code')}
              hint={t('catalog.newItem.codeHint')}
              error={problems['code']}
              className="font-mono uppercase"
              value={f.code}
              onChange={(e) => {
                setF({ ...f, code: e.target.value });
                clear('code');
              }}
            />
            <TextInput
              label={t('catalog.fields.name')}
              error={problems['name']}
              value={f.name}
              onChange={(e) => {
                setF({ ...f, name: e.target.value });
                clear('name');
              }}
            />
            <ListPicker
              label={t('catalog.fields.category')}
              error={problems['categoryId']}
              options={lookups.categories}
              value={f.categoryId}
              onChange={(v) => {
                setF({ ...f, categoryId: v });
                clear('categoryId');
              }}
            />
            <Select
              label={t('catalog.fields.unit')}
              placeholder="—"
              error={problems['unitId']}
              value={f.unitId}
              onValueChange={(v) => {
                setF({ ...f, unitId: v });
                clear('unitId');
              }}
              options={lookups.units.map((u) => ({ value: u.id, label: u.code }))}
            />
          </div>
          {can ? (
            <div className="grid grid-cols-1 gap-3.5 md:grid-cols-3">
              {lookups.tiers.map((x) => (
                <TextInput
                  key={x.code}
                  label={x.name}
                  error={problems[x.code]}
                  inputMode="decimal"
                  value={prices[x.code] ?? ''}
                  onChange={(e) => {
                    clear(x.code);
                    if (x.code === 'RETAIL') return setRetail(e.target.value);
                    setTouched({ ...touched, [x.code]: true });
                    setPrices({ ...prices, [x.code]: e.target.value });
                  }}
                />
              ))}
            </div>
          ) : (
            <p className="m-0 text-sm text-muted-foreground">{t('catalog.newItem.ownerPrices')}</p>
          )}
          <div>
            <Button type="submit" icon={Plus}>
              {t('catalog.newItem.create')}
            </Button>
          </div>
        </form>
      </Panel>
    </>
  );
}
