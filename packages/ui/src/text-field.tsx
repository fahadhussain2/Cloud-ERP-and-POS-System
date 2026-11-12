import { useId, type ComponentProps, type ReactNode } from 'react';

import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import { cn } from './lib/utils';

/** The prototype's small upper-case label, on shadcn/ui's Label. */
export const LABEL_CLASS = 'text-[11.5px] font-semibold tracking-[.07em] text-muted-foreground uppercase';

/**
 * A labelled text input with its hint and its error, wired for screen readers (on shadcn/ui's Input and Label).
 * `className` styles the input. Named TextField so shadcn/ui's own `field` component can be added later.
 */
export function TextField({
  label,
  hint,
  error,
  className,
  wrapperClassName,
  id,
  ...props
}: ComponentProps<'input'> & {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  wrapperClassName?: string;
}) {
  const own = useId();
  const inputId = id ?? own;
  const errorId = `${inputId}-error`;
  return (
    <div className={cn('flex flex-col gap-1.5', wrapperClassName)}>
      <Label htmlFor={inputId} className={LABEL_CLASS}>
        {label}
      </Label>
      <Input
        id={inputId}
        className={cn('h-11 bg-surface-2 text-base focus-visible:bg-surface', className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        {...props}
      />
      {hint && !error && <p className="m-0 text-xs text-muted-foreground">{hint}</p>}
      {error && (
        <p id={errorId} role="alert" className="m-0 font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
