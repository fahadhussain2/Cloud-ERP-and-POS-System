import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { onShutdown } from './shutdown';

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('onShutdown', () => {
  it('runs the handler once on SIGTERM and exits 0', async () => {
    const target = new EventEmitter();
    const exit = vi.fn();
    const handler = vi.fn(() => Promise.resolve());
    onShutdown(handler, { target, exit });

    target.emit('SIGTERM');
    target.emit('SIGTERM');
    await flush();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('also handles SIGINT', async () => {
    const target = new EventEmitter();
    const exit = vi.fn();
    onShutdown(() => Promise.resolve(), { target, exit });

    target.emit('SIGINT');
    await flush();

    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits 1 when the handler fails', async () => {
    const target = new EventEmitter();
    const exit = vi.fn();
    onShutdown(() => Promise.reject(new Error('close failed')), { target, exit });

    target.emit('SIGTERM');
    await flush();

    expect(exit).toHaveBeenCalledWith(1);
  });
});
