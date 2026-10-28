import { describe, expect, it } from 'vitest';

import { PUSH_BATCH_MAX, PushRequestSchema, PushResponseSchema, type PushRequest } from './push';

// The push contract (sync spec §6.2): what a counter may send and what the server answers. A document's payload is
// checked per document on the server, so the request only checks the envelope.

const ID = (n: number) => `019a3f6e-7b10-7c3a-9d2e-${String(n).padStart(12, '0')}`;
const USER = '019a0000-0000-7000-8000-0000000000a1';

const doc = (seq: number, id = ID(seq)) => ({
  id,
  family: 'S' as const,
  seq,
  payload: { version: 1, anything: 'checked per document' },
  signature: 'c2lnbmF0dXJl',
});

const request = (over: Partial<PushRequest> = {}): PushRequest => ({
  clientVersion: '0.7.0',
  schemaVersion: 6,
  deviceClock: '2026-11-02T10:15:31.000Z',
  health: {
    outboxCount: 2,
    oldestUnsyncedAt: '2026-11-02T10:15:30.000Z',
    quarantinedCount: 0,
    storagePersisted: true,
    storageUsage: 41_000_000,
    storageQuota: 2_000_000_000,
    lastPullAt: '2026-11-02T10:14:00.000Z',
  },
  documents: [doc(411), doc(412)],
  events: [
    { id: ID(900), kind: 'pin.locked', at: '2026-11-02T09:00:00.000Z', userId: USER },
    {
      id: ID(901),
      kind: 'pin.unlocked_by_manager',
      at: '2026-11-02T09:01:00.000Z',
      userId: USER,
      byUserId: '019a0000-0000-7000-8000-0000000000a2',
    },
    {
      id: ID(902),
      kind: 'bill.reprinted',
      at: '2026-11-02T10:20:00.000Z',
      userId: USER,
      documentId: ID(412),
      number: 'C03-S000412',
    },
  ],
  ...over,
});

const parses = (body: unknown) => PushRequestSchema.safeParse(body).success;

describe('PushRequest', () => {
  it('accepts documents in sequence order with events and health', () => {
    expect(parses(request())).toBe(true);
  });

  it('accepts the start-up handshake: no documents, no events', () => {
    expect(parses(request({ documents: [], events: [] }))).toBe(true);
  });

  it('accepts an unsigned document (the server answers it as unsigned) and unknown storage figures', () => {
    const r = request({ documents: [{ ...doc(411), signature: null }] });
    r.health = {
      ...r.health,
      storageUsage: null,
      storageQuota: null,
      oldestUnsyncedAt: null,
      lastPullAt: null,
    };
    expect(parses(r)).toBe(true);
  });

  it(`refuses more than ${PUSH_BATCH_MAX} documents`, () => {
    const many = Array.from({ length: PUSH_BATCH_MAX + 1 }, (_, i) => doc(i + 1));
    expect(parses(request({ documents: many.slice(0, PUSH_BATCH_MAX) }))).toBe(true);
    expect(parses(request({ documents: many }))).toBe(false);
  });

  it('refuses documents out of sequence order, or the same seq twice, in a family', () => {
    expect(parses(request({ documents: [doc(412), doc(411)] }))).toBe(false);
    expect(parses(request({ documents: [doc(411), doc(411, ID(999))] }))).toBe(false);
  });

  it('keeps each family in its own order', () => {
    const handover = { ...doc(3, ID(503)), family: 'H' as const };
    expect(parses(request({ documents: [doc(411), handover, doc(412)] }))).toBe(true);
  });

  it('refuses the same document id twice', () => {
    expect(parses(request({ documents: [doc(411), doc(412, ID(411))] }))).toBe(false);
  });

  it('refuses an unknown event kind, an event without its fields, and unknown fields', () => {
    const r = request();
    expect(
      parses({ ...r, events: [{ id: ID(903), kind: 'pin.changed', at: r.deviceClock, userId: USER }] }),
    ).toBe(false);
    expect(
      parses({ ...r, events: [{ id: ID(904), kind: 'bill.reprinted', at: r.deviceClock, userId: USER }] }),
    ).toBe(false);
    expect(parses({ ...r, extra: true })).toBe(false);
    expect(parses({ ...r, documents: [{ ...doc(411), extra: true }] })).toBe(false);
  });

  it('refuses a bad family, seq, id or clock', () => {
    expect(parses(request({ documents: [{ ...doc(411), family: 'X' as 'S' }] }))).toBe(false);
    expect(parses(request({ documents: [doc(0)] }))).toBe(false);
    expect(parses(request({ documents: [{ ...doc(411), id: 'not-a-uuid' }] }))).toBe(false);
    expect(parses(request({ deviceClock: 'yesterday' }))).toBe(false);
  });
});

describe('PushResponse', () => {
  const response = {
    serverTime: '2026-11-02T10:15:31.400Z',
    results: [
      { id: ID(411), status: 'duplicate', exceptions: [], error: null },
      { id: ID(412), status: 'accepted', exceptions: ['below_floor_no_override', 'clock_skew'], error: null },
      { id: ID(413), status: 'rejected', exceptions: ['bad_signature'], error: 'bad_signature' },
    ],
    series: [{ family: 'S', through: 410, missing: [[411, 411]] }],
    events: [ID(900)],
  };

  it('parses an answer with each status, the series and the stored events', () => {
    expect(PushResponseSchema.safeParse(response).success).toBe(true);
  });

  it('refuses an unknown status, exception kind or reject code', () => {
    const bad = (result: object) =>
      PushResponseSchema.safeParse({ ...response, results: [{ ...response.results[0], ...result }] }).success;
    expect(bad({ status: 'quarantined' })).toBe(false);
    expect(bad({ exceptions: ['looks_odd'] })).toBe(false);
    expect(bad({ status: 'rejected', error: 'too_late' })).toBe(false);
  });
});
