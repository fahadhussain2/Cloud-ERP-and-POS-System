// One run at a time, and no call lost (sync spec §8): a call while a run is going doesn't join it, which may already
// have passed what the caller wants (a new bill on the desk's queue); it gets one more run after it. Calls during a
// run are folded into that one follow-up, and answered with its result.

export function singleFlight<T>(run: () => Promise<T>, onIdle?: () => void): () => Promise<T> {
  let current: Promise<T> | null = null;
  let next: Promise<T> | null = null;
  const start = (): Promise<T> => {
    const p = run().finally(() => {
      if (current === p) current = null;
      if (current === null && next === null) onIdle?.();
    });
    current = p;
    return p;
  };
  return () => {
    if (current === null) return start();
    next ??= current
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        next = null;
        return start();
      });
    return next;
  };
}
