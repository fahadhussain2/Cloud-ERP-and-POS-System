import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from './cn';

// shadcn/ui's alert: a message inside a screen (a stop reason, a warning, a result).
const alertVariants = cva('rounded-[10px] border px-3.5 py-2.5 font-medium', {
  variants: {
    variant: {
      default: 'border-line bg-surface-2 text-ink',
      ok: 'border-ok bg-ok-soft text-ok',
      warn: 'border-warn bg-warn-soft text-warn',
      bad: 'border-bad bg-bad-soft text-bad',
    },
  },
  defaultVariants: { variant: 'default' },
});

export function Alert({
  className,
  variant,
  ...props
}: ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return <div role="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
}
