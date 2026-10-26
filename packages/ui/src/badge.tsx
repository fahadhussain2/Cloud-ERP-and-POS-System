import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from './cn';

// shadcn/ui's badge as the prototype's chip: a short state next to a value (Dormant, Offline…).
const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-[7px] py-px text-[11px] font-semibold whitespace-nowrap',
  {
    variants: {
      variant: {
        neutral: 'border border-line bg-surface-2 text-muted',
        ok: 'bg-ok-soft text-ok',
        warn: 'bg-warn-soft text-warn',
        bad: 'bg-bad-soft text-bad',
        accent: 'bg-accent-soft text-accent',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
);

export function Badge({ className, variant, ...props }: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
