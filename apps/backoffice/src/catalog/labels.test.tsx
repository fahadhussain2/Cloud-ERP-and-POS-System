import type { LabelsView } from '@erp/contracts';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Api } from '../api';
import { i18n } from '../i18n';
import en from '../locales/en.json';
import { LabelsScreen } from './LabelsScreen';

// Printing item labels (W1-17, CAT-08) over a fake API: a posted receipt's labels with their counts, the preview in
// the legacy layout (shop and supplier abbreviations, the Code 39 barcode, the item name), a count changed before
// printing, a line that can't print, and the template only the owner changes (owner answer 5).

const TEMPLATE = {
  widthMm: 40,
  heightMm: 28,
  marginMm: 1,
  shopAbbr: 'DCAC',
  showName: true,
  labelMakerBarcoded: true,
};
const RECEIPT: LabelsView = {
  source: { number: 'GR000001', supplier: 'Naveed Glass' },
  template: TEMPLATE,
  lines: [
    {
      itemId: 'i1',
      code: 'ABEA001',
      name: 'ADJUSTER BEARING SALOON',
      supplierAbbr: 'NG',
      count: 2,
      problems: [],
      warnings: [],
    },
    {
      itemId: 'i2',
      code: 'AB#2',
      name: 'OLD LEGACY CODE',
      supplierAbbr: 'NG',
      count: 3,
      problems: ['code_unprintable'],
      warnings: [],
    },
    {
      itemId: 'i3',
      code: 'OIL050',
      name: 'ENGINE OIL',
      supplierAbbr: null,
      count: 1,
      problems: [],
      warnings: ['supplier_abbr_missing'],
    },
  ],
};

function fakeApi(answers: Record<string, { status: number; body: unknown }> = {}) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const api: Api = (method, path, body) => {
    calls.push({ method, path, body });
    const key = `${method} ${path.split('?')[0]}`;
    if (answers[key]) return Promise.resolve(answers[key]);
    if (key === 'GET /api/catalog/labels/receipt') return Promise.resolve({ status: 200, body: RECEIPT });
    if (key === 'GET /api/catalog/labels/template') return Promise.resolve({ status: 200, body: TEMPLATE });
    return Promise.resolve({ status: 200, body: { ...RECEIPT, source: null } });
  };
  return { api, calls };
}

const show = (ui: ReactElement) => render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
afterEach(cleanup);

const preview = () => screen.getByRole('region', { name: en.labels.preview });
const labelsIn = (el: HTMLElement) => within(el).queryAllByRole('img', { name: /^Label / });

describe('labels for a posted receipt', () => {
  it('lists the lines with their counts and shows one label per piece in the legacy layout', async () => {
    const f = fakeApi();
    show(<LabelsScreen api={f.api} source={{ receipt: 'GR000001' }} permissions={['cat.label.print']} />);
    expect(await screen.findByText(/GR000001/)).toBeDefined();
    expect(f.calls[0]!.path).toBe('/api/catalog/labels/receipt?receipt=GR000001');
    // ABEA001 × 2 and OIL050 × 1; the line that can't print is left out.
    const labels = labelsIn(preview());
    expect(labels).toHaveLength(3);
    const first = labels[0]!;
    expect(within(first).getByText('DCAC')).toBeDefined();
    expect(within(first).getByText('NG')).toBeDefined();
    // The code as legacy prints it: between Code 39's start and stop stars, one character per cell across the width.
    const code = first.querySelector('.item-label-code')!;
    expect(code.textContent).toBe('*ABEA001*');
    expect(code.children).toHaveLength(9);
    expect(within(first).getByText('ADJUSTER BEARING SALOON')).toBeDefined();
    expect(first.querySelector('svg rect')).not.toBeNull();
    expect(screen.getByText(en.labels.problems.code_unprintable)).toBeDefined();
    expect(screen.getByText(en.labels.warnings.supplier_abbr_missing)).toBeDefined();
    expect(screen.getByText('3 labels')).toBeDefined();
  });

  it('a changed count or supplier abbreviation changes the labels', async () => {
    show(
      <LabelsScreen api={fakeApi().api} source={{ receipt: 'GR000001' }} permissions={['cat.label.print']} />,
    );
    await screen.findByText(/GR000001/);
    fireEvent.change(screen.getByLabelText('Labels for ABEA001'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Supplier abbreviation for OIL050'), {
      target: { value: 'dcen' },
    });
    expect(labelsIn(preview())).toHaveLength(6);
    expect(within(preview()).getByText('DCEN')).toBeDefined();
    expect(screen.queryByText(en.labels.warnings.supplier_abbr_missing)).toBeNull();
    expect(screen.getByText('6 labels')).toBeDefined();
  });

  it('prints with the browser, the page the size of one label', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    show(
      <LabelsScreen api={fakeApi().api} source={{ receipt: 'GR000001' }} permissions={['cat.label.print']} />,
    );
    await screen.findByText(/GR000001/);
    fireEvent.click(screen.getByRole('button', { name: en.labels.print }));
    expect(print).toHaveBeenCalledOnce();
    expect(document.head.innerHTML).toContain('size: 40mm 28mm');
    print.mockRestore();
  });

  it('a draft receipt says to post it first', async () => {
    show(
      <LabelsScreen
        api={
          fakeApi({ 'GET /api/catalog/labels/receipt': { status: 409, body: { error: 'not_posted' } } }).api
        }
        source={{ receipt: 'GR000009' }}
        permissions={['cat.label.print']}
      />,
    );
    expect(await screen.findByText(en.labels.errors.not_posted)).toBeDefined();
  });

  it('a receipt number typed in loads its labels', async () => {
    const f = fakeApi();
    show(<LabelsScreen api={f.api} source={null} permissions={['cat.label.print']} />);
    fireEvent.change(screen.getByLabelText(en.labels.receiptNumber), { target: { value: 'gr000001' } });
    fireEvent.click(screen.getByRole('button', { name: en.labels.load }));
    expect(await screen.findByText(/Naveed Glass/)).toBeDefined();
    expect(f.calls.at(-1)!.path).toBe('/api/catalog/labels/receipt?receipt=gr000001');
  });
});

describe('a relabel of items', () => {
  it('asks for the items picked on the items screen', async () => {
    const f = fakeApi();
    show(<LabelsScreen api={f.api} source={{ items: ['i1', 'i3'] }} permissions={['cat.label.print']} />);
    await waitFor(() => expect(labelsIn(preview()).length).toBeGreaterThan(0));
    expect(f.calls[0]).toMatchObject({
      method: 'POST',
      path: '/api/catalog/labels/items',
      body: { itemIds: ['i1', 'i3'] },
    });
  });
});

describe('the label template', () => {
  it('is not offered without admin.settings', async () => {
    show(
      <LabelsScreen api={fakeApi().api} source={{ receipt: 'GR000001' }} permissions={['cat.label.print']} />,
    );
    await screen.findByText(/GR000001/);
    expect(screen.queryByRole('button', { name: en.labels.template.edit })).toBeNull();
  });

  it('the owner changes it in a dialog, and the labels follow', async () => {
    const saved = { ...TEMPLATE, shopAbbr: 'DXA', showName: false };
    const f = fakeApi({ 'PUT /api/catalog/labels/template': { status: 200, body: saved } });
    show(
      <LabelsScreen
        api={f.api}
        source={{ receipt: 'GR000001' }}
        permissions={['cat.label.print', 'admin.settings']}
      />,
    );
    await screen.findByText(/GR000001/);
    fireEvent.click(screen.getByRole('button', { name: en.labels.template.edit }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(en.labels.template.shopAbbr), {
      target: { value: 'dxa' },
    });
    fireEvent.click(within(dialog).getByLabelText(en.labels.template.showName));
    fireEvent.click(within(dialog).getByRole('button', { name: en.labels.template.save }));
    await waitFor(() => expect(within(preview()).getAllByText('DXA').length).toBe(3));
    expect(f.calls.find((c) => c.method === 'PUT')!.body).toEqual({
      ...TEMPLATE,
      shopAbbr: 'dxa',
      showName: false,
    });
    expect(within(preview()).queryByText('ADJUSTER BEARING SALOON')).toBeNull();
  });

  it('shows what the API refused', async () => {
    const f = fakeApi({
      'PUT /api/catalog/labels/template': {
        status: 400,
        body: { error: 'invalid', problems: ['width_out_of_range'] },
      },
    });
    show(
      <LabelsScreen
        api={f.api}
        source={{ receipt: 'GR000001' }}
        permissions={['cat.label.print', 'admin.settings']}
      />,
    );
    await screen.findByText(/GR000001/);
    fireEvent.click(screen.getByRole('button', { name: en.labels.template.edit }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: en.labels.template.save }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain(
      en.labels.template.problems.width_out_of_range,
    );
  });
});
