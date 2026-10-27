import type { TestItem } from './catalog';

// A made-up catalog in Delux's shape for staging (W1-21): codes, names, part numbers, vehicle tags, three tiers, some
// floors, dormant items and goods sold by the metre or litre. Deterministic: the same seed gives the same catalog.
// No real data: real searches are checked on the owner's PC against erp_dev (D-076).

const notBuilt = (...args: unknown[]): never => {
  throw new Error(`not built yet (W1-21): ${args.length} arguments`);
};

export function generateCatalog(opts: { items: number; seed?: number }): TestItem[] {
  return notBuilt(opts);
}

export interface SeedReport {
  tenantId: string;
  items: number;
  ms: number;
}

/**
 * Seeds a generated catalog into a shop that has no items yet, as the owner role, in one transaction. Refuses
 * production: test data never goes there (W1-21).
 */
export async function seedGeneratedCatalog(
  ownerUrl: string,
  opts: { environment: string; tenantCode: string; items: number; seed?: number },
): Promise<SeedReport> {
  return Promise.resolve(notBuilt(ownerUrl, opts));
}
