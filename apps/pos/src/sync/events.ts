import type { TokenSource } from '../device/session';
import { backoffDelay } from './push';

// The counter's side of the SSE nudge (sync spec §8, SYN-04, W1-07): `GET /api/sync/events` read with fetch, because
// EventSource can't send the device token. Each event (`changes-available`) makes the counter pull. The server ends
// the stream when the token would expire; the counter reconnects with a new one, and backs off while it can't.

/** Splits an event stream into events; comments (keep-alives) and data lines are ignored, chunks may split anywhere. */
export class SseParser {
  private buffer = '';

  /** The names of the events completed by this chunk, in order (`message` when an event has no name). */
  push(chunk: string): string[] {
    this.buffer += chunk.replace(/\r\n?/g, '\n');
    const blocks = this.buffer.split('\n\n');
    this.buffer = blocks.pop()!;
    const events: string[] = [];
    for (const block of blocks) {
      const lines = block.split('\n').filter((l) => l !== '' && !l.startsWith(':'));
      if (lines.length === 0) continue;
      const named = lines.find((l) => l.startsWith('event:'));
      events.push(named === undefined ? 'message' : named.slice('event:'.length).trim());
    }
    return events;
  }
}

export interface EventStreamDeps {
  fetchFn: typeof fetch;
  tokens: TokenSource;
  onEvent: (name: string) => void;
  /** True once the server has answered, false when the stream drops (the counter then polls more often). */
  onConnected?: (connected: boolean) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  random?: () => number;
  now?: () => number;
  base?: string;
}

/** A stream that lasted this long ended normally (the server closes it at the token's expiry). */
const STEADY_MS = 60_000;

export interface EventStream {
  close(): void;
}

export function openEventStream(deps: EventStreamDeps): EventStream {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const random = deps.random ?? Math.random;
  const now = deps.now ?? Date.now;
  let closed = false;
  let attempt = 0;
  let timer: unknown = null;
  let abort: AbortController | null = null;

  const retry = () => {
    if (closed) return;
    timer = setTimer(
      () => {
        timer = null;
        void connect();
      },
      backoffDelay(attempt++, random()),
    );
  };

  const connect = async () => {
    abort = new AbortController();
    let connected = false;
    const openedAt = now();
    try {
      const res = await deps.fetchFn(`${deps.base ?? ''}/api/sync/events`, {
        headers: { authorization: `Device ${await deps.tokens.get()}`, accept: 'text/event-stream' },
        signal: abort.signal,
      });
      // A refused token: the next connect gets a new one.
      if (res.status === 401) deps.tokens.invalidate();
      if (res.status !== 200 || !res.body) return;
      connected = true;
      attempt = 0;
      deps.onConnected?.(true);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const name of parser.push(decoder.decode(value, { stream: true }))) deps.onEvent(name);
      }
    } catch {
      // Offline, aborted or refused: try again later.
    } finally {
      if (connected) deps.onConnected?.(false);
      // The server ending a stream on time is normal: reconnect at once. A stream that dropped soon after opening
      // (a proxy, a restarting server) backs off like a failure, so it can't spin.
      if (connected && !closed && now() - openedAt >= STEADY_MS) void connect();
      else retry();
    }
  };

  void connect();
  return {
    close: () => {
      closed = true;
      if (timer !== null) clearTimer(timer);
      abort?.abort();
    },
  };
}
