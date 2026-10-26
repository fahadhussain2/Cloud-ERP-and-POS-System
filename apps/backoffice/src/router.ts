import { useEffect, useState } from 'react';

// Screen addresses in the hash (W1-04 plan): a reload or the back button keeps your place, and the back-office host
// needs no server change. Four screens don't need a router library.

export type Route =
  { screen: 'home' } | { screen: 'staff' } | { screen: 'person'; id: string } | { screen: 'counters' };

export const href = {
  staff: '#/staff',
  person: (id: string) => `#/staff/${encodeURIComponent(id)}`,
  counters: '#/counters',
} as const;

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'staff' && parts[1]) return { screen: 'person', id: decodeURIComponent(parts[1]) };
  if (parts[0] === 'staff') return { screen: 'staff' };
  if (parts[0] === 'counters') return { screen: 'counters' };
  return { screen: 'home' };
}

/** The current screen, following the address. */
export function useRoute(): Route {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const follow = () => setHash(window.location.hash);
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, []);
  return parseHash(hash);
}
