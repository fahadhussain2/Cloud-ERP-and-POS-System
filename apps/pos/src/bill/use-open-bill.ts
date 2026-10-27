import type { DomainErrorCode } from '@erp/domain';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { Counter } from '../counter';
import type { Tier } from '../search/search-index';
import { newOpenBill, type tryEdit } from './bill-state';
import type { OpenBill } from './open-bill';

// The open bill of the person selling (POS spec §10): loaded at unlock (theirs from before a lock or a reload, or a
// new one on the default tier), saved after every change.

export type BillCounter = Pick<Counter, 'openBill' | 'saveOpenBill' | 'clearOpenBill' | 'tiers'>;

export function useOpenBill(counter: BillCounter, sellerId: string) {
  const [openBill, setOpenBill] = useState<OpenBill | null>(null);
  const [tiers, setTiers] = useState<Tier[]>([]);
  const current = useRef<OpenBill | null>(null);

  const defaultTier = (list: Tier[]) => list.find((t) => t.isDefault)?.id ?? list[0]?.id ?? '';

  useEffect(() => {
    let stop = false;
    void Promise.all([counter.openBill(sellerId), counter.tiers()]).then(([saved, list]) => {
      if (stop) return;
      const ob = saved ?? newOpenBill(sellerId, defaultTier(list));
      current.current = ob;
      setTiers(list);
      setOpenBill(ob);
    });
    return () => {
      stop = true;
    };
  }, [counter, sellerId]);

  /** Applies an edit; on success the bill is shown and saved, otherwise the broken rule comes back. */
  const change = useCallback(
    (edit: (ob: OpenBill) => ReturnType<typeof tryEdit>): DomainErrorCode | null => {
      const ob = current.current;
      if (!ob) return null;
      const r = edit(ob);
      if (!r.ok) return r.error;
      current.current = r.bill;
      setOpenBill(r.bill);
      void counter.saveOpenBill(sellerId, r.bill);
      return null;
    },
    [counter, sellerId],
  );

  /** Starts again: a new bill on the default tier, and the saved one removed (`Alt+C`). */
  const clear = useCallback(async () => {
    const ob = newOpenBill(sellerId, defaultTier(tiers));
    current.current = ob;
    setOpenBill(ob);
    await counter.clearOpenBill(sellerId);
  }, [counter, sellerId, tiers]);

  /** The bill right now, including a change made in this same event. */
  const get = useCallback(() => current.current, []);

  return { openBill, tiers, change, clear, get };
}
