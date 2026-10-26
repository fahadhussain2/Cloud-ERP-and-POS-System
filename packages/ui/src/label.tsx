import * as LabelPrimitive from '@radix-ui/react-label';
import type { ComponentProps } from 'react';

import { cn } from './cn';

/** The small upper-case label of the prototype. */
export function Label({ className, ...props }: ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      className={cn(
        'inline-flex items-center gap-1.5 text-[11.5px] font-semibold tracking-[.07em] text-muted uppercase',
        className,
      )}
      {...props}
    />
  );
}
