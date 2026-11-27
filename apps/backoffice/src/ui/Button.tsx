import { cn, Button as SharedButton } from '@erp/ui';
import type { LucideIcon } from 'lucide-react';
import type { ComponentProps } from 'react';

// The back office's buttons (W2-12, D-127): 36px (small 32px), 8px corners, 14px semibold, an optional icon before
// the word (owner answer 5: + on Add, Save, ✕ on Cancel). On the shared Button with back-office classes on top, so the
// POS's buttons stay as they are.

export type ButtonVariant = 'default' | 'outline' | 'ghost' | 'destructive' | 'link';

const VARIANT: Record<ButtonVariant, string> = {
  default: 'bg-primary text-primary-foreground hover:bg-primary/90',
  outline: 'border border-field-line bg-surface text-ink shadow-none hover:bg-surface-2',
  ghost: 'text-ink hover:bg-surface-2',
  destructive: 'bg-bad text-bad-ink hover:bg-bad/90',
  link: 'h-auto px-0 text-primary underline-offset-4 hover:underline',
};

/** The classes of a kit button, for a link or a label that looks like one. */
export function buttonClass(variant: ButtonVariant = 'default', size: 'default' | 'sm' = 'default') {
  return cn(
    'gap-2 rounded-lg text-sm font-semibold focus-visible:border-focus focus-visible:ring-[3px] focus-visible:ring-glow',
    size === 'sm' ? 'h-8 px-3 text-[13px] has-[>svg]:px-2.5' : 'h-9 px-3.5 has-[>svg]:px-3',
    VARIANT[variant],
  );
}

export function Button({
  variant = 'default',
  size = 'default',
  icon: Icon,
  className,
  children,
  asChild,
  ...props
}: Omit<ComponentProps<typeof SharedButton>, 'variant' | 'size'> & {
  variant?: ButtonVariant;
  size?: 'default' | 'sm';
  /** Shown before the word, hidden from screen readers so the button's name is its word. */
  icon?: LucideIcon;
}) {
  return (
    <SharedButton
      size={size === 'sm' ? 'sm' : 'default'}
      className={cn(buttonClass(variant, size), className)}
      {...(asChild ? { asChild } : {})}
      {...props}
    >
      {asChild || !Icon ? (
        children
      ) : (
        <>
          <Icon aria-hidden="true" className="size-4" />
          {children}
        </>
      )}
    </SharedButton>
  );
}
