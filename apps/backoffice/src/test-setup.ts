// jsdom lacks ResizeObserver, which Radix uses to size a checkbox inside a form; a stub that never reports is enough.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

// jsdom lacks what Radix's select uses to scroll its options and to follow the pointer (the shims shadcn's docs give).
const proto = Element.prototype as unknown as Record<string, unknown>;
proto['scrollIntoView'] ??= () => undefined;
proto['hasPointerCapture'] ??= () => false;
proto['releasePointerCapture'] ??= () => undefined;
