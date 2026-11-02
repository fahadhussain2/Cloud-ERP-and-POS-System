import sessionCases from '../golden/cash-session.json';
import type { SessionMovement } from './cash-movement';
import {
  buildSessionDocument,
  expectedCash,
  type DeskSession,
  type SessionCollection,
  type SessionHandover,
} from './cash-session';
import type { VarianceReason } from './drawer';
import type { Money } from './money';
import { CONTEXT, grantsOf, RS } from './testing/desk';
import { runGolden, type GoldenFile } from './testing/golden';

interface SessionCash {
  handovers?: SessionHandover[];
  collections?: SessionCollection[];
  movements?: SessionMovement[];
}

interface SessionCase {
  expected?: SessionCash & { openingFloat: Money };
  open?: {
    current: DeskSession | null;
    userId: string;
    openingFloat: Money;
    floatExpected?: Money | null;
    seq: number;
    createdAt: string;
  };
  close?: SessionCash & {
    current: DeskSession | null;
    userId: string;
    count: {
      counts: Record<string, number>;
      reason?: VarianceReason;
      note?: string;
      acknowledgerId?: string | null;
      leftInDrawer?: Money;
    };
    seq: number;
    createdAt: string;
  };
}

const SESSION_CONTEXT = { ...CONTEXT, id: '019a6000-0000-7000-8000-000000000081', increment: RS };

runGolden(sessionCases as unknown as GoldenFile<SessionCase>, (i) => {
  if (i.expected !== undefined)
    // Collections and movements are left out when a case has none: they default to none.
    return expectedCash({ ...i.expected, handovers: i.expected.handovers ?? [] });
  const e = (i.open ?? i.close)!;
  const count = i.close?.count;
  const ack = count?.acknowledgerId ?? null;
  return buildSessionDocument({
    event: i.open !== undefined ? 'open' : 'close',
    current: e.current,
    userId: e.userId,
    grants: grantsOf(e.userId),
    openingFloat: i.open?.openingFloat ?? null,
    floatExpected: i.open?.floatExpected ?? null,
    handovers: i.close?.handovers ?? [],
    collections: i.close?.collections ?? [],
    movements: i.close?.movements ?? [],
    close:
      count === undefined
        ? null
        : {
            currency: 'PKR',
            counts: count.counts,
            reason: count.reason ?? null,
            note: count.note ?? null,
            acknowledger: ack === null ? null : { userId: ack, grants: grantsOf(ack) },
            leftInDrawer: count.leftInDrawer ?? null,
          },
    context: { ...SESSION_CONTEXT, seq: e.seq, createdAtMs: Date.parse(e.createdAt) },
  });
});
