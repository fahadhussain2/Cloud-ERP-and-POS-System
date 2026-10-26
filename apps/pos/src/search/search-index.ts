import type { CatalogDataset } from '@erp/contracts';
import { money, normalizeIdentifier } from '@erp/domain';

// The counter's omni-search (POS-02, CAT-02, POS spec §9, W1-03): an in-memory index of the local catalog, inside the
// database worker. Loaded at start-up from SQLite and patched with every pulled page; search() answers from memory.
// Pure and deterministic: no clock, no I/O.

export type CatalogChanges = Partial<Record<CatalogDataset, Record<string, unknown>[]>>;

export interface Vehicle {
  make: string | null;
  model: string | null;
  yearFrom: number | null;
  yearTo: number | null;
}

export interface SearchResult {
  id: string;
  code: string;
  name: string;
  variant: string | null;
  spec: string | null;
  /** The first OEM number (the primary one if marked). */
  oem: string | null;
  /** The first vehicle tag. */
  vehicle: Vehicle | null;
  bin: string | null;
  status: string;
  /** Minor units in the requested tier (the default tier if none); null when the item has no price there. */
  price: number | null;
  /** 1 exact code or barcode · 2 exact identifier · 3 identifier prefix · 4 words. */
  rank: 1 | 2 | 3 | 4;
}

export interface SearchOptions {
  tierId?: string;
  limit?: number;
}

type Row = Record<string, unknown>;

interface Entry {
  id: string;
  code: string;
  name: string;
  active: boolean;
  /** Every word an item can be found by: name, variant, spec, brand, origin, category, vehicle make and model. */
  words: string[];
  /** Vehicle tag year ranges, open ends as ±Infinity. */
  years: [number, number][];
}

const LIMIT = 50;
/** Rank 3 only for text that looks like a part number: a digit and at least this many characters. */
const PREFIX_MIN = 4;
const YEAR = /^(19|20)\d\d$/;

/** Pulled text, or a number as text (ids and codes are text; anything else is no value). */
const text = (v: unknown): string | null =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'bigint' ? String(v) : null;
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
/** Words for matching: upper case, split on anything that is not a letter or digit. */
const tokens = (s: string | null): string[] =>
  s
    ? s
        .toUpperCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean)
    : [];

const DATASETS = [
  'price_tiers',
  'units',
  'categories',
  'brands',
  'origins',
  'vehicle_makes',
  'items',
  'item_identifiers',
  'item_compatibility',
  'item_prices',
] as const satisfies readonly CatalogDataset[];
/** Lookups whose names are words of many items: a change rebuilds every item's words. */
const LOOKUPS: ReadonlySet<CatalogDataset> = new Set(['categories', 'brands', 'origins', 'vehicle_makes']);
/** Rows that belong to an item. */
const PER_ITEM: ReadonlySet<CatalogDataset> = new Set([
  'item_identifiers',
  'item_compatibility',
  'item_prices',
]);

export class SearchIndex {
  private readonly rows = Object.fromEntries(DATASETS.map((d) => [d, new Map<string, Row>()])) as Record<
    CatalogDataset,
    Map<string, Row>
  >;
  /** item id → ids of its identifiers, vehicle tags and prices. */
  private readonly byItem = Object.fromEntries(
    [...PER_ITEM].map((d) => [d, new Map<string, Set<string>>()]),
  ) as Record<CatalogDataset, Map<string, Set<string>>>;
  private readonly entries = new Map<string, Entry>();
  private readonly dirty = new Set<string>();
  private allDirty = false;
  /** Rebuilt on the next search after identifiers or items change. */
  private keys: {
    exactCode: Map<string, Set<string>>;
    exactOther: Map<string, Set<string>>;
    sorted: [key: string, itemId: string][];
  } | null = null;

  /** Live items. */
  get size(): number {
    return this.rows.items.size;
  }

  /** Adds, changes and removes rows (a pulled page, or the whole local catalog at start-up). */
  apply(changes: CatalogChanges): void {
    for (const d of DATASETS) {
      const list = changes[d];
      if (!list?.length) continue;
      for (const r of list) this.applyRow(d, r);
      if (LOOKUPS.has(d)) this.allDirty = true;
      if (d === 'items' || d === 'item_identifiers') this.keys = null;
    }
  }

  private applyRow(d: CatalogDataset, r: Row): void {
    const id = String(r['id']);
    const map = this.rows[d];
    const before = map.get(id);
    const removed = r['deleted_at'] !== null && r['deleted_at'] !== undefined;
    if (removed) map.delete(id);
    else map.set(id, r);
    if (PER_ITEM.has(d)) {
      const links = this.byItem[d];
      const oldItem = text(before?.['item_id']);
      if (oldItem) {
        links.get(oldItem)?.delete(id);
        this.dirty.add(oldItem);
      }
      const item = text(r['item_id']);
      if (!removed && item) {
        let set = links.get(item);
        if (!set) links.set(item, (set = new Set()));
        set.add(id);
        this.dirty.add(item);
      }
    }
    if (d === 'items') {
      if (removed) this.entries.delete(id);
      this.dirty.add(id);
    }
  }

  private related(d: CatalogDataset, itemId: string): Row[] {
    const ids = this.byItem[d].get(itemId);
    if (!ids) return [];
    const out: Row[] = [];
    for (const id of [...ids].sort()) {
      const r = this.rows[d].get(id);
      if (r) out.push(r);
    }
    return out;
  }

  private lookupName(d: CatalogDataset, id: unknown): string | null {
    const key = text(id);
    return key ? text(this.rows[d].get(key)?.['name']) : null;
  }

  private buildEntry(item: Row): Entry {
    const id = String(item['id']);
    const name = String(item['name']);
    const words = new Set<string>();
    const add = (s: string | null) => tokens(s).forEach((w) => words.add(w));
    add(name);
    add(text(item['variant']));
    add(text(item['spec']));
    add(this.lookupName('brands', item['brand_id']));
    add(this.lookupName('origins', item['origin_id']));
    add(this.lookupName('categories', item['category_id']));
    const years: [number, number][] = [];
    for (const v of this.related('item_compatibility', id)) {
      add(this.lookupName('vehicle_makes', v['make_id']));
      add(text(v['model']));
      const from = num(v['year_from']);
      const to = num(v['year_to']);
      if (from !== null || to !== null) years.push([from ?? -Infinity, to ?? Infinity]);
    }
    return {
      id,
      code: String(item['code']),
      name,
      active: item['status'] === 'active',
      words: [...words],
      years,
    };
  }

  /** Brings the per-item words and the identifier keys up to date (lazily: once after a batch of patches). */
  private refresh(): void {
    if (this.allDirty) {
      this.entries.clear();
      for (const item of this.rows.items.values())
        this.entries.set(String(item['id']), this.buildEntry(item));
      this.allDirty = false;
      this.dirty.clear();
    } else if (this.dirty.size) {
      for (const id of this.dirty) {
        const item = this.rows.items.get(id);
        if (item) this.entries.set(id, this.buildEntry(item));
        else this.entries.delete(id);
      }
      this.dirty.clear();
    }
    if (!this.keys) {
      const exactCode = new Map<string, Set<string>>();
      const exactOther = new Map<string, Set<string>>();
      const sorted: [string, string][] = [];
      const put = (map: Map<string, Set<string>>, key: string, itemId: string) => {
        let set = map.get(key);
        if (!set) map.set(key, (set = new Set()));
        set.add(itemId);
      };
      for (const item of this.rows.items.values()) {
        const key = normalizeIdentifier(String(item['code']));
        put(exactCode, key, String(item['id']));
        sorted.push([key, String(item['id'])]);
      }
      for (const x of this.rows.item_identifiers.values()) {
        const itemId = String(x['item_id']);
        if (!this.rows.items.has(itemId)) continue;
        const key = String(x['normalized_value']);
        put(x['kind'] === 'barcode' ? exactCode : exactOther, key, itemId);
        sorted.push([key, itemId]);
      }
      sorted.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      this.keys = { exactCode, exactOther, sorted };
    }
  }

  private defaultTier(): string | null {
    for (const t of this.rows.price_tiers.values()) if (t['is_default']) return String(t['id']);
    return null;
  }

  /** Builds what the next search needs now (after start-up or a complete pull), so the first key press is fast. */
  warm(): void {
    this.refresh();
  }

  search(input: string, opts: SearchOptions = {}): SearchResult[] {
    const words = tokens(input);
    if (words.length === 0) return [];
    this.refresh();
    const keys = this.keys!;
    const best = new Map<string, SearchResult['rank']>();
    const hit = (itemId: string, rank: SearchResult['rank']) => {
      const was = best.get(itemId);
      if (was === undefined || rank < was) best.set(itemId, rank);
    };

    // 1–3: the whole text as an identifier (a scanned label, an OEM number typed any way).
    const key = normalizeIdentifier(input);
    for (const id of keys.exactCode.get(key) ?? []) hit(id, 1);
    for (const id of keys.exactOther.get(key) ?? []) hit(id, 2);
    if (key.length >= PREFIX_MIN && /\d/.test(key)) {
      const sorted = keys.sorted;
      let lo = 0;
      let hi = sorted.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (sorted[mid]![0] < key) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < sorted.length && sorted[i]![0].startsWith(key); i++) hit(sorted[i]![1], 3);
    }

    // 4: every word starts a word of the item, or is a year inside one of its vehicle tags.
    // Plain loops: this runs for every item on every key press.
    const years = words.map((w) => (YEAR.test(w) ? Number(w) : null));
    for (const e of this.entries.values()) {
      if (best.has(e.id)) continue;
      let all = true;
      for (let i = 0; i < words.length && all; i++) {
        const w = words[i]!;
        all = false;
        for (let j = 0; j < e.words.length && !all; j++) all = e.words[j]!.startsWith(w);
        const y = years[i];
        if (!all && y !== null && y !== undefined)
          for (let j = 0; j < e.years.length && !all; j++) all = e.years[j]![0] <= y && y <= e.years[j]![1];
      }
      if (all) hit(e.id, 4);
    }

    const found: Entry[] = [];
    for (const id of best.keys()) {
      const e = this.entries.get(id);
      if (e) found.push(e);
    }
    found.sort(
      (a, b) =>
        best.get(a.id)! - best.get(b.id)! ||
        Number(b.active) - Number(a.active) ||
        a.name.length - b.name.length ||
        (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
    );
    const tier = opts.tierId ?? this.defaultTier();
    return found.slice(0, opts.limit ?? LIMIT).map((e) => this.result(e, best.get(e.id)!, tier));
  }

  private result(e: Entry, rank: SearchResult['rank'], tier: string | null): SearchResult {
    const item = this.rows.items.get(e.id)!;
    const oems = this.related('item_identifiers', e.id).filter((x) => x['kind'] === 'oem');
    const oem = oems.find((x) => x['is_primary']) ?? oems[0];
    const v = this.related('item_compatibility', e.id)[0];
    const price = tier ? this.related('item_prices', e.id).find((p) => p['tier_id'] === tier) : undefined;
    return {
      id: e.id,
      code: e.code,
      name: e.name,
      variant: text(item['variant']),
      spec: text(item['spec']),
      oem: text(oem?.['value']),
      vehicle: v
        ? {
            make: this.lookupName('vehicle_makes', v['make_id']),
            model: text(v['model']),
            yearFrom: num(v['year_from']),
            yearTo: num(v['year_to']),
          }
        : null,
      bin: text(item['bin_location']),
      status: String(item['status']),
      price: price ? money(price['price'] as number | string) : null,
      rank,
    };
  }
}
