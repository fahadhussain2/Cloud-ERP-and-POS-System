import {
  SHOP_EXTRA_LINES_MAX,
  SHOP_LINE_MAX,
  type ShopSettingsRequest,
  type ShopSettingsView,
} from '@erp/contracts';
import { billHeaderLines } from '@erp/print';
import { Alert, AlertDescription, Button, PageHeader, Panel, TextField } from '@erp/ui';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';

// The shop's name and bill header (W1-25 plan; PLT-01, POS-09, D-112), the owner's: the name, the branch's address,
// phone and extra lines, and the policy line, with a preview in the bill's own order (`billHeaderLines`). Counters
// print the change from their next pull.

export function ShopSettingsScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const [shop, setShop] = useState<ShopSettingsView | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    void api('GET', '/api/settings/shop').then((res) => {
      if (!live) return;
      if (res.status === 200) setShop(res.body as ShopSettingsView);
      else setFailed(true);
    });
    return () => {
      live = false;
    };
  }, [api]);
  if (failed)
    return (
      <Alert variant="destructive">
        <AlertDescription>{t('shop.refused')}</AlertDescription>
      </Alert>
    );
  if (shop === null) return <p className="text-muted-foreground">{t('app.loading')}</p>;
  return <ShopForm api={api} shop={shop} />;
}

const padded = (lines: string[]) => Array.from({ length: SHOP_EXTRA_LINES_MAX }, (_, i) => lines[i] ?? '');

function ShopForm({ api, shop }: { api: Api; shop: ShopSettingsView }) {
  const { t } = useTranslation();
  const previewId = useId();
  const [name, setName] = useState(shop.name);
  const [address, setAddress] = useState(shop.address);
  const [phone, setPhone] = useState(shop.phone);
  const [lines, setLines] = useState(padded(shop.lines));
  const [policy, setPolicy] = useState(shop.policyText);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [saving, setSaving] = useState(false);

  // The same limits the API checks (ShopSettingsRequest), shown as the owner types.
  const tooLong = (v: string) =>
    v.trim().length > SHOP_LINE_MAX ? t('shop.problems.tooLong', { max: SHOP_LINE_MAX }) : undefined;
  const problems = {
    name: name.trim() === '' ? t('shop.problems.nameRequired') : tooLong(name),
    address: tooLong(address),
    phone: tooLong(phone),
    lines: lines.map(tooLong),
    policy: tooLong(policy),
  };
  const valid = [problems.name, problems.address, problems.phone, ...problems.lines, problems.policy].every(
    (p) => p === undefined,
  );

  const header = billHeaderLines({ address, phone, lines, profileLines: shop.profileLines });
  const change = (set: (v: string) => void) => (e: { target: { value: string } }) => {
    set(e.target.value);
    setMessage(null);
  };

  const save = async () => {
    const body: ShopSettingsRequest = {
      name: name.trim(),
      branchId: shop.branchId,
      address: address.trim(),
      phone: phone.trim(),
      lines: lines.map((l) => l.trim()).filter((l) => l !== ''),
      policyText: policy.trim(),
    };
    setSaving(true);
    try {
      const res = await api('PUT', '/api/settings/shop', body);
      if (res.status === 200) setMessage({ text: t('shop.saved'), error: false });
      else
        setMessage({
          text: t(res.status === 403 ? 'shop.refused' : 'shop.failed'),
          error: true,
        });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader title={t('shop.title')} help={t('shop.help')} />
      {message && (
        <Alert variant={message.error ? 'destructive' : 'default'} role={message.error ? 'alert' : 'status'}>
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        <Panel className="flex flex-col gap-3 p-3.5">
          <p className="m-0 text-sm text-muted-foreground">{t('shop.branch', { name: shop.branchName })}</p>
          <TextField
            label={t('shop.fields.name')}
            value={name}
            onChange={change(setName)}
            error={problems.name}
          />
          <TextField
            label={t('shop.fields.address')}
            value={address}
            onChange={change(setAddress)}
            error={problems.address}
          />
          <TextField
            label={t('shop.fields.phone')}
            value={phone}
            onChange={change(setPhone)}
            error={problems.phone}
          />
          {lines.map((line, i) => (
            <TextField
              key={i}
              label={t(`shop.fields.line${i + 1}`)}
              value={line}
              onChange={change((v) => setLines((ls) => ls.map((l, j) => (j === i ? v : l))))}
              error={problems.lines[i]}
            />
          ))}
          <TextField
            label={t('shop.fields.policy')}
            hint={t('shop.policyHint')}
            value={policy}
            onChange={change(setPolicy)}
            error={problems.policy}
          />
          <div>
            <Button onClick={() => void save()} disabled={!valid || saving}>
              {t('shop.save')}
            </Button>
          </div>
        </Panel>
        <Panel className="p-3.5">
          <section aria-labelledby={previewId} className="flex flex-col gap-1 text-center font-mono">
            <h2 id={previewId} className="m-0 text-xs font-normal text-muted-foreground">
              {t('shop.preview')}
            </h2>
            <h3 className="m-0 text-lg font-bold">{name.trim()}</h3>
            {header.map((line, i) => (
              <p key={i} className="m-0 text-sm" data-testid="header-line">
                {line}
              </p>
            ))}
            <hr className="my-3 w-full border-dashed" />
            <p className="m-0 text-sm">{policy.trim() || t('shop.defaultPolicy')}</p>
          </section>
        </Panel>
      </div>
    </>
  );
}
