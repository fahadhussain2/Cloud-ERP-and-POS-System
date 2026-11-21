import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyTheme, readCachedTheme, resolveTheme, THEME_KEY } from './theme';

// The theme on screen (W2-07 plan, PLT-13): the person's choice, System resolved through the computer's setting and
// followed while chosen; a copy in this browser for the sign-in screen, which may be missing or blocked.

let dark = false;
let listeners: Array<() => void> = [];

function stubMatchMedia() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return query.includes('dark') && dark;
    },
    media: query,
    addEventListener: (_: string, f: () => void) => listeners.push(f),
    removeEventListener: (_: string, f: () => void) => (listeners = listeners.filter((l) => l !== f)),
  }));
}
const flip = (to: boolean) => {
  dark = to;
  for (const l of listeners) l();
};
const shown = () => document.documentElement.getAttribute('data-theme');

beforeEach(() => {
  dark = false;
  listeners = [];
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  stubMatchMedia();
});
afterEach(() => {
  applyTheme('light'); // drops any System listener
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('resolveTheme', () => {
  it.each([
    ['light', false, 'light'],
    ['light', true, 'light'],
    ['dark', false, 'dark'],
    ['dark', true, 'dark'],
    ['system', false, 'light'],
    ['system', true, 'dark'],
  ] as const)('%s with the computer dark %s is %s', (choice, prefersDark, mode) => {
    expect(resolveTheme(choice, prefersDark)).toBe(mode);
  });
});

describe('applyTheme', () => {
  it('sets data-theme on <html>', () => {
    applyTheme('dark');
    expect(shown()).toBe('dark');
    applyTheme('light');
    expect(shown()).toBe('light');
  });

  it('follows the computer while System is chosen, and stops once Light is', () => {
    applyTheme('system');
    expect(shown()).toBe('light');
    flip(true);
    expect(shown()).toBe('dark');
    applyTheme('light');
    flip(false);
    flip(true);
    expect(shown()).toBe('light');
  });

  it('keeps a copy in this browser', () => {
    applyTheme('dark');
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
    expect(readCachedTheme()).toBe('dark');
  });

  it('treats a missing or odd copy as System', () => {
    expect(readCachedTheme()).toBe('system');
    localStorage.setItem(THEME_KEY, 'blue');
    expect(readCachedTheme()).toBe('system');
  });

  it('works when the browser blocks storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readCachedTheme()).toBe('system');
    expect(() => applyTheme('dark')).not.toThrow();
    expect(shown()).toBe('dark');
  });
});
