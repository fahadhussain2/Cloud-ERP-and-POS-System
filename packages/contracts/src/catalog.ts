import { z } from 'zod';

// Catalog maintenance in the back office (W1-15 plan; CAT-01…CAT-05, CAT-07). Money in paisa and quantities in
// thousandths, as integers (CLAUDE.md rule 1). A row version is a decimal string (bigint).

const Id = z.uuid();
const RowVersion = z.string().regex(/^\d+$/);
const Text = (max: number) =>
  z
    .string()
    .max(max)
    .transform((s) => (s.trim() === '' ? null : s.trim()))
    .nullable();
const Thousandths = z.number().int().nullable();
const Paisa = z.number().nullable();

export const ItemStatus = z.enum(['active', 'dormant', 'discontinued']);
export type ItemStatus = z.infer<typeof ItemStatus>;

const ItemFields = {
  name: z.string().max(200),
  categoryId: Id,
  unitId: Id,
  brandId: Id.nullable(),
  originId: Id.nullable(),
  variant: Text(60),
  spec: Text(60),
  binLocation: Text(40),
  defaultSupplierId: Id.nullable(),
  minQty: Thousandths,
  maxQty: Thousandths,
  excludeFromReorder: z.boolean(),
  status: ItemStatus,
};

/** A new item; `prices` only with cat.price.edit (owner answer 3). Unknown fields are refused. */
export const CreateItemRequest = z
  .strictObject({ code: z.string().max(40), ...ItemFields, prices: z.record(z.string(), Paisa) })
  .partial()
  .required({ code: true, name: true, categoryId: true, unitId: true });
export type CreateItemRequest = z.infer<typeof CreateItemRequest>;

/** The details of an item; the code never changes, so it is refused here (a strict object). */
export const UpdateItemRequest = z
  .strictObject({ rowVersion: RowVersion, ...ItemFields })
  .partial()
  .required({ rowVersion: true });
export type UpdateItemRequest = z.infer<typeof UpdateItemRequest>;

export const IdentifierKind = z.enum(['barcode', 'oem', 'alternate', 'supplier_ref']);
export const SetIdentifiersRequest = z.strictObject({
  rowVersion: RowVersion,
  identifiers: z.array(z.strictObject({ kind: IdentifierKind, value: z.string().max(60) })).max(50),
});
export type SetIdentifiersRequest = z.infer<typeof SetIdentifiersRequest>;

export const VehicleTag = z.strictObject({
  makeId: Id.nullable(),
  model: Text(60),
  yearFrom: z.number().int().nullable(),
  yearTo: z.number().int().nullable(),
  note: Text(120),
});
export const SetVehiclesRequest = z.strictObject({
  rowVersion: RowVersion,
  vehicles: z.array(VehicleTag).max(50),
});
export type SetVehiclesRequest = z.infer<typeof SetVehiclesRequest>;

export const SetPricesRequest = z.strictObject({
  rowVersion: RowVersion,
  tiers: z.record(z.string(), Paisa),
  floor: Paisa,
  reason: z.string().max(40).nullable().optional(),
  note: z.string().max(200).nullable().optional(),
});
export type SetPricesRequest = z.infer<typeof SetPricesRequest>;

export const UpdateCategoryRequest = z.strictObject({
  rowVersion: RowVersion,
  floorMarginBp: z.number().int().min(0).max(10_000).nullable(),
});
export type UpdateCategoryRequest = z.infer<typeof UpdateCategoryRequest>;

/** A brand, origin or vehicle make added while editing an item. */
export const AddNameRequest = z.strictObject({ name: z.string().trim().min(1).max(60) });

export interface ItemRow {
  id: string;
  code: string;
  name: string;
  brand: string | null;
  category: string;
  status: ItemStatus;
  retail: number | null;
}
export interface ItemList {
  items: ItemRow[];
  total: number;
}

export interface ItemDetail {
  item: {
    id: string;
    code: string;
    name: string;
    categoryId: string;
    unitId: string;
    brandId: string | null;
    originId: string | null;
    variant: string | null;
    spec: string | null;
    binLocation: string | null;
    defaultSupplierId: string | null;
    minQty: number | null;
    maxQty: number | null;
    excludeFromReorder: boolean;
    status: ItemStatus;
    rowVersion: string;
    updatedAt: string;
    updatedBy: string | null;
  };
  identifiers: { kind: z.infer<typeof IdentifierKind>; value: string; isPrimary: boolean }[];
  vehicles: {
    makeId: string | null;
    model: string | null;
    yearFrom: number | null;
    yearTo: number | null;
    note: string | null;
  }[];
  /** Paisa per tier code; null = no price. */
  prices: Record<string, number | null>;
  /** What the counter uses (D-092, D-101): the item's own floor, else cost + margin, else the list price. */
  floor: {
    own: number | null;
    fromCost: number | null;
    effective: number | null;
    source: 'item' | 'cost' | 'list';
  };
  /** Only with cost.view. */
  cost?: {
    avgCost: number | null;
    lastCost: number | null;
    lastSupplier: string | null;
    lastReceiptAt: string | null;
  };
  /** Newest first. */
  history: {
    target: string;
    old: number | null;
    new: number | null;
    source: string;
    reason: string | null;
    note: string | null;
    by: string | null;
    at: string;
  }[];
}

export interface CatalogLookups {
  categories: {
    id: string;
    code: string;
    name: string;
    parentId: string | null;
    floorMarginBp: number | null;
    rowVersion: string;
  }[];
  units: { id: string; code: string; name: string; allowsFraction: boolean }[];
  brands: { id: string; name: string }[];
  origins: { id: string; name: string }[];
  makes: { id: string; name: string }[];
  tiers: { id: string; code: string; name: string }[];
  suppliers: { id: string; code: string; name: string }[];
  /** The shop is marked live (D-101); until then the final import overwrites the catalog (owner answer 1). */
  live: boolean;
  /** How the shop writes money (CLAUDE.md rule 10). */
  money: { locale: string; currency: string; minorUnits: number };
  /** printLabels: cat.label.print, a relabel from the items list (W1-17). */
  can: { editItems: boolean; editPrices: boolean; viewCost: boolean; printLabels: boolean };
}
