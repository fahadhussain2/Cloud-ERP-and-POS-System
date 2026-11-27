import type { LabelLineView, LabelsView, LabelTemplateRequest } from '@erp/contracts';
import { labelPages, type LabelPage } from '@erp/domain';
import { code39Svg, code39Width } from '@erp/print';
import { PageHeader, Panel, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@erp/ui';
import { Pencil, Printer, Save, Search } from 'lucide-react';
import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import { Button, Checkbox, FormDialog, notify, TextBox, TextInput } from '../ui';

// Printing item labels (W1-17, CAT-08, D-019, D-055): a posted goods receipt's labels (typed by number, or opened
// from the receipt) or a relabel of items picked on the items screen. The counts and supplier abbreviations can be
// changed before printing. Each label is one page on the Zebra roll (owner answer 1), laid out as the legacy label
// (owner answer 3); the template is the owner's (owner answer 5). Labels are always black on white (PLT-13).
// W2-14 (D-127): the back office's own controls, problems at their field (owner answer 6).

type TemplateField = 'widthMm' | 'heightMm' | 'marginMm' | 'shopAbbr';
/** The field each of the template's problems is about. */
const FIELD_OF_PROBLEM: Record<string, TemplateField> = {
  width_out_of_range: 'widthMm',
  height_out_of_range: 'heightMm',
  margin_out_of_range: 'marginMm',
  shop_abbr_too_long: 'shopAbbr',
};

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
            <Button
              variant="outline"
              icon={Pencil}
              onClick={() => setEditing(true)}
              disabled={template === null}
            >
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
          {/* A receipt that can't be found or isn't posted is the number's problem (owner answer 6). */}
          <TextInput
            label={t('labels.receiptNumber')}
            error={error}
            value={number}
            onChange={(e) => {
              setNumber(e.target.value);
              setError(null);
            }}
            wrapperClassName="w-56"
          />
          <Button type="submit" icon={Search} className={error ? 'mb-[22px]' : undefined}>
            {t('labels.load')}
          </Button>
        </form>
      </Panel>

      {view ? (
        <Panel className="p-3.5">
          <p className="m-0 mb-3 font-medium">
            {view.source
              ? t('labels.from', { number: view.source.number, supplier: view.source.supplier })
              : t('labels.relabel')}
          </p>
          <div className="overflow-x-auto">
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
                      <TextBox
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
                      <TextBox
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
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <span className="font-medium">{t('labels.count', { count: pages.length })}</span>
            <Button
              icon={Printer}
              onClick={() => window.print()}
              disabled={pages.length === 0 || template === null}
            >
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

/** The barcode's proportions: wide bars 2.5 × narrow, a quiet zone of 10 narrow on each side. */
const BARCODE = { narrow: 1, wide: 2.5, height: 30, quiet: 10 };

/** One label as printed: the legacy layout (owner answer 3), sized in millimetres. */
function ItemLabel({ page, template }: { page: LabelPage; template: LabelTemplateRequest }) {
  const { t } = useTranslation();
  const svg = code39Svg(page.code, BARCODE);
  // The code under the bars spans the bars only, not the quiet zones on each side (owner review, 2026-11-07).
  const quiet = `${Math.round((BARCODE.quiet * BARCODE.narrow * 100_000) / code39Width(page.code, BARCODE)) / 1000}%`;
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
      {/* As legacy prints it: between the start and stop stars, each character under its own bars. */}
      <div className="item-label-code" style={{ '--quiet': quiet } as CSSProperties}>
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
  const [f, setF] = useState(() => ({
    widthMm: String(template.widthMm),
    heightMm: String(template.heightMm),
    marginMm: String(template.marginMm),
    shopAbbr: template.shopAbbr,
    showName: template.showName,
    labelMakerBarcoded: template.labelMakerBarcoded,
  }));
  const [problems, setProblems] = useState<Partial<Record<TemplateField, string>>>({});
  const [busy, setBusy] = useState(false);
  const set = (k: TemplateField, v: string) => {
    setF((x) => ({ ...x, [k]: v }));
    setProblems((p) => (p[k] ? { ...p, [k]: undefined } : p));
  };

  const submit = async () => {
    const sizes = ['widthMm', 'heightMm', 'marginMm'] as const;
    const nums = sizes.map((k) => (f[k].trim() === '' ? Number.NaN : Number(f[k])));
    const wrong: typeof problems = {};
    sizes.forEach((k, n) => {
      if (!Number.isFinite(nums[n])) wrong[k] = t('labels.template.invalidNumber');
    });
    setProblems(wrong);
    if (Object.keys(wrong).length > 0) return;
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
      setProblems({});
      return onSaved(r.body as LabelTemplateRequest);
    }
    // The API's problems name their field (owner answer 6); anything else is a toast.
    const b = r.body as { error?: string; problems?: string[] } | null;
    if (b?.error === 'invalid' && b.problems?.length) {
      const at: typeof problems = {};
      for (const p of b.problems) at[FIELD_OF_PROBLEM[p] ?? 'widthMm'] = t(`labels.template.problems.${p}`);
      setProblems(at);
    } else notify.problem(t('app.error'));
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setProblems({});
        onOpenChange(o);
      }}
      title={t('labels.template.title')}
      description={t('labels.template.description')}
      actionLabel={t('labels.template.save')}
      actionIcon={Save}
      cancelLabel={t('labels.template.cancel')}
      busy={busy}
      onSubmit={() => void submit()}
      errors={problems}
    >
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-3">
        <TextInput
          label={t('labels.template.width')}
          error={problems.widthMm}
          inputMode="decimal"
          value={f.widthMm}
          onChange={(e) => set('widthMm', e.target.value)}
        />
        <TextInput
          label={t('labels.template.height')}
          error={problems.heightMm}
          inputMode="decimal"
          value={f.heightMm}
          onChange={(e) => set('heightMm', e.target.value)}
        />
        <TextInput
          label={t('labels.template.margin')}
          error={problems.marginMm}
          inputMode="decimal"
          value={f.marginMm}
          onChange={(e) => set('marginMm', e.target.value)}
        />
      </div>
      <TextInput
        label={t('labels.template.shopAbbr')}
        hint={t('labels.template.shopAbbrHint')}
        error={problems.shopAbbr}
        value={f.shopAbbr}
        onChange={(e) => set('shopAbbr', e.target.value)}
      />
      <Checkbox
        label={t('labels.template.showName')}
        checked={f.showName}
        onCheckedChange={(v) => setF((x) => ({ ...x, showName: v }))}
      />
      <Checkbox
        label={t('labels.template.labelMakerBarcoded')}
        checked={f.labelMakerBarcoded}
        onCheckedChange={(v) => setF((x) => ({ ...x, labelMakerBarcoded: v }))}
      />
    </FormDialog>
  );
}
