// jsdom lacks ResizeObserver, which Radix uses to size a checkbox inside a form; a stub that never reports is enough.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
