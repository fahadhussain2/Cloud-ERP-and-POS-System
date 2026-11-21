import type { Theme } from '@erp/contracts';

// The theme on screen (W2-07 plan, PLT-13, D-120). The person's choice is kept on the server (/auth/me); this sets
// data-theme on <html>, so the menus, tooltips and dialogs that render outside the app's root follow too. System is
// resolved through the computer's setting and followed while chosen. A copy in this browser lets the sign-in screen
// and the first paint (index.html) open in the last theme chosen here; storage may be missing or blocked.

export type { Theme };
export type Mode = 'light' | 'dark';

/** The browser copy; index.html reads the same key before the page paints. */
export const THEME_KEY = 'erp.backoffice.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

export const resolveTheme = (choice: Theme, prefersDark: boolean): Mode =>
  choice === 'system' ? (prefersDark ? 'dark' : 'light') : choice;

const query = (): MediaQueryList | null =>
  typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(DARK_QUERY) : null;

/** Whether the computer is set to dark now. */
export const systemPrefersDark = () => query()?.matches ?? false;

export function readCachedTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch {
    return 'system';
  }
}

let following: { list: MediaQueryList; listener: () => void } | null = null;

/** Shows `choice` now, keeps the browser copy, and follows the computer while System is chosen. */
export function applyTheme(choice: Theme): void {
  if (following) {
    following.list.removeEventListener('change', following.listener);
    following = null;
  }
  const set = () =>
    document.documentElement.setAttribute('data-theme', resolveTheme(choice, systemPrefersDark()));
  set();
  const list = choice === 'system' ? query() : null;
  if (list) {
    list.addEventListener('change', set);
    following = { list, listener: set };
  }
  try {
    localStorage.setItem(THEME_KEY, choice);
  } catch {
    // A private window or blocked storage: the choice still shows; the server keeps it for next time.
  }
}
