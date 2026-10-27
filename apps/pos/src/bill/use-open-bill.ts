import type { DomainErrorCode } from '@erp/domain';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { Counter } from '../counter';
import type { Tier } from '../search/search-index';
import { newOpenBill, type tryEdit } from './bill-state';
import type { OpenBill } from './open-bill';

// The open bill of the person selling (POS spec §10): loaded at unlock (theirs from before a lock or a reload, or a
// new one on the default tier), saved after every change. A save that fails is shown, never swallowed: a lock or a
// reload would lose a bill that isn't saved.

export type BillCounter = Pick<Counter, 'openBill' | 'saveOpenBill' | 'clearOpenBill' | 'tiers' | 'log'>;

export function useOpenBill(counter: BillCounter, sellerId: string) {
  const [openBill, setOpenBill] = useState<OpenBill | null>(null);
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [saveFailed, setSaveFailed] = useState(false);
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

  /** Runs a write to the local database; a failure stays on screen until a later write succeeds. */
  const persist = useCallback(
    async (write: () => Promise<void>) => {
      try {
        await write();
        setSaveFailed(false);
      } catch (err) {
        setSaveFailed(true);
        // The log is in the same database, so it may fail too; the message on screen is what matters.
        await counter.log('bill.save_failed', { sellerId, error: String(err) }).catch(() => undefined);
      }
    },
    [counter, sellerId],
  );

  /** Applies an edit; on success the bill is shown and saved, otherwise the broken rule comes back. */
  const change = useCallback(
    (edit: (ob: OpenBill) => ReturnType<typeof tryEdit>): DomainErrorCode | null => {
      const ob = current.current;
      if (!ob) return null;
      const r = edit(ob);
      if (!r.ok) return r.error;
      current.current = r.bill;
      setOpenBill(r.bill);
      void persist(() => counter.saveOpenBill(sellerId, r.bill));
      return null;
    },
    [counter, sellerId, persist],
  );

  /** Starts again: a new bill on the default tier, and the saved one removed (`Alt+C`). */
  const clear = useCallback(async () => {
    const ob = newOpenBill(sellerId, defaultTier(tiers));
    current.current = ob;
    setOpenBill(ob);
    await persist(() => counter.clearOpenBill(sellerId));
  }, [counter, sellerId, tiers, persist]);

  /** The bill right now, including a change made in this same event. */
  const get = useCallback(() => current.current, []);

  return { openBill, tiers, change, clear, get, saveFailed };
}
