import type { ComponentProps } from 'react';

import { cn } from './cn';

/** One key as printed on a keycap. */
export function Kbd({ className, ...props }: ComponentProps<'kbd'>) {
  return (
    <kbd
      className={cn(
        'rounded border border-b-2 border-line bg-surface-2 px-1.5 font-mono text-[11.5px] leading-normal font-medium whitespace-nowrap text-ink',
        className,
      )}
      {...props}
    />
  );
}

export interface KeyHint {
  /** What the keycap shows, e.g. `F2` or `↑ ↓`. */
  keys: string;
  label: string;
  /** The same action as the key, for the mouse (D-053). */
  run: () => void;
  /** The main action of the screen, drawn in the accent colour. */
  main?: boolean;
}

/** The shortcut hints along the bottom of the screen (POS-03); each is also a button. */
export function KeyBar({ title, hints }: { title: string; hints: readonly KeyHint[] }) {
  return (
    <footer className="flex flex-wrap items-center gap-1.5" aria-label={title}>
      <span className="me-1 text-[11px] font-semibold tracking-[.07em] text-muted uppercase">{title}</span>
      {hints.map((h) => (
        <button
          key={h.keys}
          type="button"
          onClick={h.run}
          className={cn(
            'inline-flex cursor-pointer items-center gap-1.5 rounded-[7px] border bg-surface py-1 ps-[5px] pe-2 text-[12.5px] font-medium hover:border-muted',
            h.main ? 'border-accent' : 'border-line',
          )}
        >
          <Kbd className={h.main ? 'border-accent bg-accent text-accent-ink' : undefined}>{h.keys}</Kbd>
          {h.label}
        </button>
      ))}
    </footer>
  );
}

