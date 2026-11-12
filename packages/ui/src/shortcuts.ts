import { useEffect, useRef } from 'react';

// The POS keyboard layer (POS-03, D-066: our own, not a library). A shortcut is written like `F2`, `Alt+L`,
// `Shift+F9` or `Escape`; modifiers must match exactly, so F9 and Shift+F9 are different keys.

export interface KeyPress {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

const MODIFIERS = ['Alt', 'Ctrl', 'Shift', 'Meta'];

export function matchKey(e: KeyPress, shortcut: string): boolean {
  const parts = shortcut.split('+');
  const key = parts.pop()!;
  const mods = new Set(parts);
  for (const m of mods) if (!MODIFIERS.includes(m)) throw new Error(`unknown modifier ${m}`);
  return (
    e.key.toLowerCase() === key.toLowerCase() &&
    e.altKey === mods.has('Alt') &&
    e.ctrlKey === mods.has('Ctrl') &&
    e.shiftKey === mods.has('Shift') &&
    e.metaKey === mods.has('Meta')
  );
}

export type Shortcuts = Record<string, (e: KeyboardEvent) => void>;

/**
 * Runs a shortcut's action on key down anywhere in the window, and stops the browser's own action for that key
 * (F3 find, F5 reload…). Off while `enabled` is false, e.g. under an open dialog.
 */
export function useShortcuts(shortcuts: Shortcuts, enabled = true): void {
  const current = useRef(shortcuts);
  useEffect(() => {
    current.current = shortcuts;
  });
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      for (const [shortcut, run] of Object.entries(current.current)) {
        if (matchKey(e, shortcut)) {
          e.preventDefault();
          run(e);
          return;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
