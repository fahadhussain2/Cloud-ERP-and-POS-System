import { useRef, useState } from 'react';

// One save at a time (W2-17, owner's staging test 2026-11-28): two quick clicks on Save draft sent two saves, the second
// with the version the first had just replaced ("… changed this in the meantime"), or made two new drafts.
// `run(name, action)` wraps an action: while it runs, `busy` is its name (that button shows a spinner, the others are
// disabled) and any other call does nothing. An action that succeeded returns `true` when its form is about to be
// replaced (reloaded with the new version, or another address), so the buttons stay busy until then and no click can
// carry the old version; otherwise they come back.

export function useOneAtATime<Name extends string>() {
  const running = useRef(false);
  const [busy, setBusy] = useState<Name | null>(null);
  const run = (name: Name, action: () => Promise<boolean | void>) => async (): Promise<void> => {
    if (running.current) return;
    running.current = true;
    setBusy(name);
    let keep = false;
    try {
      keep = (await action()) === true;
    } finally {
      if (!keep) {
        running.current = false;
        setBusy(null);
      }
    }
  };
  return { busy, run };
}
