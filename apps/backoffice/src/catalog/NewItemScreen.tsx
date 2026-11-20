import { itemProblems, money, proposeTierPrices } from '@erp/domain';
import { Alert, AlertDescription, Button, LABEL_CLASS, PageHeader, Panel, TextField } from '@erp/ui';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import { href } from '../router';
import { catalogRefusal, moneyText, moneyValue, NONE, useLookups } from './data';

// A new item (W1-15, CAT-01): code, name, category and unit; its barcode = its code is added by the server. The owner
// also prices it, with Mechanic and Wholesale proposed at −5 % and −10 % of Retail (PRD Q1); a manager adds it
// without prices and the owner prices it after (owner answer 3).

export function NewItemScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const { lookups } = useLookups(api);
  const [f, setF] = useState({ code: '', name: '', categoryId: NONE, unitId: NONE });
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const categoryId = useId();
  const unitId = useId();

  if (lookups === null) return <p className="text-muted-foreground">{t('app.loading')}</p>;
  const m = lookups.money;
  const can = lookups.can.editPrices;

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
    if (checked.problems.length > 0)
      return setError(checked.problems.map((p) => t(`catalog.problems.${p}`)).join(' '));
    const priced = can
      ? Object.fromEntries(lookups.tiers.map((x) => [x.code, moneyValue(prices[x.code] ?? '', m.minorUnits)]))
      : null;
    if (priced && Object.values(priced).some((v) => v === undefined))
      return setError(t('catalog.problems.price_number'));
    setError(null);
    const r = await api('POST', '/api/catalog/items', {
      code: checked.code,
      name: checked.name,
      categoryId: f.categoryId,
      unitId: f.unitId,
      ...(priced ? { prices: priced } : {}),
    });
    if (r.status === 201) window.location.hash = href.item((r.body as { id: string }).id);
    else setError(catalogRefusal(t, (k) => t(k) !== k, r.body));
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
        <form className="flex flex-col gap-3.5 p-3.5" onSubmit={(e) => void submit(e)}>
          <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
            <TextField
              label={t('catalog.fields.code')}
              hint={t('catalog.newItem.codeHint')}
              className="font-mono uppercase"
              value={f.code}
              onChange={(e) => setF({ ...f, code: e.target.value })}
            />
            <TextField
              label={t('catalog.fields.name')}
              value={f.name}
              onChange={(e) => setF({ ...f, name: e.target.value })}
            />
            <div className="flex flex-col gap-1.5">
              <label htmlFor={categoryId} className={LABEL_CLASS}>
                {t('catalog.fields.category')}
              </label>
              <select
                id={categoryId}
                className="h-11 rounded-md border border-input bg-surface-2 px-2 text-base"
                value={f.categoryId}
                onChange={(e) => setF({ ...f, categoryId: e.target.value })}
              >
                <option value={NONE}>—</option>
                {lookups.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} · {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={unitId} className={LABEL_CLASS}>
                {t('catalog.fields.unit')}
              </label>
              <select
                id={unitId}
                className="h-11 rounded-md border border-input bg-surface-2 px-2 text-base"
                value={f.unitId}
                onChange={(e) => setF({ ...f, unitId: e.target.value })}
              >
                <option value={NONE}>—</option>
                {lookups.units.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.code}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {can ? (
            <div className="grid grid-cols-1 gap-3.5 md:grid-cols-3">
              {lookups.tiers.map((x) => (
                <TextField
                  key={x.code}
                  label={x.name}
                  inputMode="decimal"
                  value={prices[x.code] ?? ''}
                  onChange={(e) => {
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
          {error && (
            <Alert variant="destructive">
              <AlertDescription role="alert">{error}</AlertDescription>
            </Alert>
          )}
          <div>
            <Button type="submit" size="lg">
              {t('catalog.newItem.create')}
            </Button>
          </div>
        </form>
      </Panel>
    </>
  );
}
