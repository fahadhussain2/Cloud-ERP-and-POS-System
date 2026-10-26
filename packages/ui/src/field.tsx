import { useId, type ComponentProps, type ReactNode } from 'react';

import { cn } from './cn';
import { Input } from './input';
import { Label } from './label';

/** A labelled input with its hint and its error, wired for screen readers. `className` styles the input. */
export function Field({
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
      <Label htmlFor={inputId}>{label}</Label>
      <Input
        id={inputId}
        className={className}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        {...props}
      />
      {hint && !error && <p className="m-0 text-xs text-muted">{hint}</p>}
      {error && (
        <p id={errorId} role="alert" className="m-0 font-medium text-bad">
          {error}
        </p>
      )}
    </div>
  );
}
