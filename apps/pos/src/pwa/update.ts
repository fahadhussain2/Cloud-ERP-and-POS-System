// App updates (POS spec §8, D-089): the service worker downloads a new version in the background; it takes over only
// when no bill is open, so a sale is never interrupted. Bills arrive in W1-05; the rule is built now.

const RETRY_MS = 60_000;

export function applyUpdateWhenSafe(opts: {
  activate: () => unknown;
  billOpen: () => boolean;
  retryMs?: number;
}) {
  const tryNow = () => {
    if (opts.billOpen()) return false;
    opts.activate();
    return true;
  };
  if (tryNow()) return;
  const timer = setInterval(() => {
    if (tryNow()) clearInterval(timer);
  }, opts.retryMs ?? RETRY_MS);
}
