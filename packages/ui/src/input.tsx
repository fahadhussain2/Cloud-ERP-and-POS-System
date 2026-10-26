import type { ComponentProps } from 'react';

import { cn } from './cn';

/** A text field; codes and numbers read better in the mono font (`className="font-mono"`). */
export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'w-full rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-base text-ink',
        'focus:border-focus focus:bg-surface focus:shadow-[0_0_0_3px_var(--select)] focus:outline-none',
        'aria-invalid:border-bad disabled:opacity-60',
        className,
      )}
      {...props}
    />
  );
}
