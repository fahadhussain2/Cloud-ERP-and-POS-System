import type { LabelLineView, LabelsView, LabelTemplateRequest } from '@erp/contracts';
import { labelPages, type LabelPage } from '@erp/domain';
import { code39Svg } from '@erp/print';
import {
  Button,
  Checkbox,
  Input,
  Label,
  PageHeader,
  Panel,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TextField,
} from '@erp/ui';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import { FormDialog } from '../staff/dialogs';

// Printing item labels (W1-17, CAT-08, D-019, D-055): a posted goods receipt's labels (typed by number, or opened
// from the receipt) or a relabel of items picked on the items screen. The counts and supplier abbreviations can be
// changed before printing. Each label is one page on the Zebra roll (owner answer 1), laid out as the legacy label
// (owner answer 3); the template is the owner's (owner answer 5). Labels are always black on white (PLT-13).

export type LabelsSource = { receipt: string } | { items: string[] } | null;

/** Labels shown on screen; all of them print. */
const PREVIEW_MAX = 60;

export function LabelsScreen({
  api,
  source,
  permissions,
}: {
  api: Api;
  source: LabelsSource;
  permissions: readonly string[];
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<LabelsView | null>(null);
  const [lines, setLines] = useState<LabelLineView[]>([]);
  const [template, setTemplate] = useState<LabelTemplateRequest | null>(null);
  const [number, setNumber] = useState(source && 'receipt' in source ? source.receipt : '');
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const canEditTemplate = permissions.includes('admin.settings');

  const show = (r: { status: number; body: unknown }) => {
    if (r.status === 200) {
      const v = r.body as LabelsView;
      setView(v);
      setLines(v.lines);
      setTemplate(v.template);
      setError(null);
      return;
    }
    const code = (r.body as { error?: string } | null)?.error;
    setError(code === 'not_posted' || code === 'not_found' ? t(`labels.errors.${code}`) : t('app.error'));
  };
  const loadReceipt = async (ref: string) =>
    show(await api('GET', `/api/catalog/labels/receipt?receipt=${encodeURIComponent(ref.trim())}`));

  const itemIds = source && 'items' in source ? source.items.join(',') : '';
  const receipt = source && 'receipt' in source ? source.receipt : '';
  useEffect(() => {
    let live = true;
    const load = async () => {
      const r = receipt
        ? await api('GET', `/api/catalog/labels/receipt?receipt=${encodeURIComponent(receipt)}`)
        : itemIds
          ? await api('POST', '/api/catalog/labels/items', { itemIds: itemIds.split(',') })
          : await api('GET', '/api/catalog/labels/template');
      if (!live) return;
      if (!receipt && !itemIds) {
        if (r.status === 200) setTemplate(r.body as LabelTemplateRequest);
        return;
      }
      show(r);
    };
    void load();
    return () => {
      live = false;
    };
    // show and t are stable enough; reload only when the source changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, receipt, itemIds]);

  const put = (i: number, patch: Partial<LabelLineView>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const pages = labelPages(lines);

  return (
    <>
      <PageHeader
        title={t('labels.title')}
        help={t('labels.help')}
        actions={
          canEditTemplate && (
            <Button variant="outline" onClick={() => setEditing(true)} disabled={template === null}>
              {t('labels.template.edit')}
            </Button>
          )
        }
      />
      <Panel className="p-3.5">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (number.trim() !== '') void loadReceipt(number);
          }}
        >
          <TextField
            label={t('labels.receiptNumber')}
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            wrapperClassName="w-56"
          />
          <Button type="submit">{t('labels.load')}</Button>
        </form>
        {error && (
          <p role="alert" className="m-0 mt-3 text-sm text-destructive">
            {error}
          </p>
        )}
      </Panel>

      {view ? (
        <Panel className="p-3.5">
          <p className="m-0 mb-3 font-medium">
            {view.source
              ? t('labels.from', { number: view.source.number, supplier: view.source.supplier })
              : t('labels.relabel')}
          </p>
          <Table aria-label={t('labels.lines')}>
            <TableHeader>
              <TableRow>
                <TableHead>{t('labels.columns.code')}</TableHead>
                <TableHead>{t('labels.columns.item')}</TableHead>
                <TableHead>{t('labels.columns.supplierAbbr')}</TableHead>
                <TableHead className="text-end">{t('labels.columns.labels')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((l, i) => (
                <TableRow key={`${l.itemId}-${i}`} className="align-top">
                  <TableCell className="leading-9 font-mono">{l.code}</TableCell>
                  <TableCell>
                    <div className="leading-9">{l.name}</div>
                    {l.problems.map((p) => (
                      <p key={p} className="m-0 text-sm text-destructive">
                        {t(`labels.problems.${p}`)}
                      </p>
                    ))}
                    {!l.supplierAbbr && (
                      <p className="m-0 text-sm text-muted-foreground">
                        {t('labels.warnings.supplier_abbr_missing')}
                      </p>
                    )}
                  </TableCell>
                  <TableCell>
                    <Input
                      aria-label={t('labels.abbrFor', { code: l.code })}
                      className="w-24 uppercase"
                      maxLength={10}
                      value={l.supplierAbbr ?? ''}
                      onChange={(e) => {
                        const v = e.target.value.trim().toUpperCase();
                        put(i, { supplierAbbr: v === '' ? null : v });
                      }}
                    />
                  </TableCell>
                  <TableCell className="text-end">
                    <Input
                      aria-label={t('labels.countFor', { code: l.code })}
                      className="ms-auto w-20 text-end"
                      inputMode="numeric"
                      value={String(l.count)}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        put(i, { count: Number.isInteger(n) && n >= 0 ? Math.min(n, 9999) : 0 });
                      }}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <span className="font-medium">{t('labels.count', { count: pages.length })}</span>
            <Button onClick={() => window.print()} disabled={pages.length === 0 || template === null}>
              {t('labels.print')}
            </Button>
            <span className="text-sm text-muted-foreground">{t('labels.printHint')}</span>
          </div>
        </Panel>
      ) : (
        !error && <p className="text-muted-foreground">{t('labels.empty')}</p>
      )}

      {view && template && (
        <section aria-label={t('labels.preview')} className="flex flex-wrap gap-3">
          {pages.slice(0, PREVIEW_MAX).map((p, i) => (
            <ItemLabel key={i} page={p} template={template} />
          ))}
          {pages.length > PREVIEW_MAX && (
            <p className="m-0 self-center text-muted-foreground">
              {t('labels.more', { count: pages.length - PREVIEW_MAX })}
            </p>
          )}
        </section>
      )}

      {template && pages.length > 0 && <PrintPages pages={pages} template={template} />}

      {/* Mounted only while open, so its fields start from the template as saved. */}
      {canEditTemplate && template && editing && (
        <TemplateDialog
          api={api}
          template={template}
          open
          onOpenChange={setEditing}
          onSaved={(saved) => {
            setTemplate(saved);
            setEditing(false);
          }}
        />
      )}
    </>
  );
}

/** One label as printed: the legacy layout (owner answer 3), sized in millimetres. */
function ItemLabel({ page, template }: { page: LabelPage; template: LabelTemplateRequest }) {
  const { t } = useTranslation();
  const svg = code39Svg(page.code, { narrow: 1, wide: 2.5, height: 30, quiet: 10 });
  return (
    <div
      role="img"
      aria-label={t('labels.labelOf', { code: page.code })}
      className="item-label"
      style={{
        inlineSize: `${template.widthMm}mm`,
        blockSize: `${template.heightMm}mm`,
        padding: `${template.marginMm}mm`,
      }}
    >
      <div className="item-label-top">
        <span className="item-label-shop">{template.shopAbbr}</span>
        <span className="item-label-supplier">{page.supplierAbbr ?? ''}</span>
      </div>
      {/* code39Svg draws only rects from a code checked against the Code 39 characters. */}
      <div className="item-label-bars" dangerouslySetInnerHTML={{ __html: svg }} />
      {/* As legacy prints it: between the start and stop stars, spread across the label's width. */}
      <div className="item-label-code">
        {[...`*${page.code}*`].map((c, i) => (
          <span key={i}>{c}</span>
        ))}
      </div>
      {template.showName && (
        <div className="item-label-name">
          <span>{page.name}</span>
        </div>
      )}
    </div>
  );
}

/** Every label, one per page, shown only when printing; the page is the label's size. */
function PrintPages({ pages, template }: { pages: LabelPage[]; template: LabelTemplateRequest }) {
  useEffect(() => {
    const style = document.createElement('style');
    style.dataset['labels'] = '';
    style.textContent = `@page { size: ${template.widthMm}mm ${template.heightMm}mm; margin: 0; }`;
    document.head.appendChild(style);
    return () => style.remove();
  }, [template.widthMm, template.heightMm]);
  return createPortal(
    <div className="label-print" aria-hidden="true">
      {pages.map((p, i) => (
        <ItemLabel key={i} page={p} template={template} />
      ))}
    </div>,
    document.body,
  );
}

function TemplateDialog({
  api,
  template,
  open,
  onOpenChange,
  onSaved,
}: {
  api: Api;
  template: LabelTemplateRequest;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (template: LabelTemplateRequest) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [f, setF] = useState(() => ({
    widthMm: String(template.widthMm),
    heightMm: String(template.heightMm),
    marginMm: String(template.marginMm),
    shopAbbr: template.shopAbbr,
    showName: template.showName,
    labelMakerBarcoded: template.labelMakerBarcoded,
  }));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const nums = [f.widthMm, f.heightMm, f.marginMm].map((v) => (v.trim() === '' ? Number.NaN : Number(v)));
    if (nums.some((n) => !Number.isFinite(n))) return setError(t('labels.template.invalidNumber'));
    const [widthMm, heightMm, marginMm] = nums as [number, number, number];
    setBusy(true);
    const r = await api('PUT', '/api/catalog/labels/template', {
      widthMm,
      heightMm,
      marginMm,
      shopAbbr: f.shopAbbr,
      showName: f.showName,
      labelMakerBarcoded: f.labelMakerBarcoded,
    });
    setBusy(false);
    if (r.status === 200) {
      setError(null);
      return onSaved(r.body as LabelTemplateRequest);
    }
    const b = r.body as { error?: string; problems?: string[] } | null;
    setError(
      b?.error === 'invalid' && b.problems?.length
        ? b.problems.map((p) => t(`labels.template.problems.${p}`)).join(' ')
        : t('app.error'),
    );
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setError(null);
        onOpenChange(o);
      }}
      title={t('labels.template.title')}
      description={t('labels.template.description')}
      actionLabel={t('labels.template.save')}
      cancelLabel={t('labels.template.cancel')}
      busy={busy}
      onSubmit={() => void submit()}
    >
      <div className="grid gap-3.5 sm:grid-cols-3">
        <TextField
          label={t('labels.template.width')}
          inputMode="decimal"
          value={f.widthMm}
          onChange={(e) => setF((x) => ({ ...x, widthMm: e.target.value }))}
        />
        <TextField
          label={t('labels.template.height')}
          inputMode="decimal"
          value={f.heightMm}
          onChange={(e) => setF((x) => ({ ...x, heightMm: e.target.value }))}
        />
        <TextField
          label={t('labels.template.margin')}
          inputMode="decimal"
          value={f.marginMm}
          onChange={(e) => setF((x) => ({ ...x, marginMm: e.target.value }))}
        />
      </div>
      <TextField
        label={t('labels.template.shopAbbr')}
        hint={t('labels.template.shopAbbrHint')}
        value={f.shopAbbr}
        onChange={(e) => setF((x) => ({ ...x, shopAbbr: e.target.value }))}
      />
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${id}-name`}
          checked={f.showName}
          onCheckedChange={(v) => setF((x) => ({ ...x, showName: v === true }))}
        />
        <Label htmlFor={`${id}-name`}>{t('labels.template.showName')}</Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${id}-maker`}
          checked={f.labelMakerBarcoded}
          onCheckedChange={(v) => setF((x) => ({ ...x, labelMakerBarcoded: v === true }))}
        />
        <Label htmlFor={`${id}-maker`}>{t('labels.template.labelMakerBarcoded')}</Label>
      </div>
      {error && (
        <p role="alert" className="m-0 text-sm text-destructive">
          {error}
        </p>
      )}
    </FormDialog>
  );
}
