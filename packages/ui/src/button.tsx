import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from './cn';

// shadcn/ui's button on the prototype's tokens (D-066).
export const buttonVariants = cva(
  'inline-flex cursor-pointer items-center justify-center gap-2 rounded-md border font-semibold whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-45',
  {
    variants: {
      variant: {
        default: 'border-line bg-surface text-ink hover:border-muted',
        primary: 'border-accent bg-accent text-accent-ink hover:brightness-105',
        ghost: 'border-transparent bg-transparent text-ink hover:bg-surface-2',
        danger: 'border-line bg-surface text-bad hover:border-bad',
      },
      size: {
        default: 'px-3 py-1.5',
        lg: 'px-4 py-2 text-[15px]',
        sm: 'px-2 py-0.5 text-xs',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export function Button({
  className,
  variant,
  size,
  asChild = false,
  type = 'button',
  ...props
}: ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'button';
  return <Comp type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
