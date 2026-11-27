import { cn, Input, Label } from '@erp/ui';
import { useId, type ComponentProps, type ReactNode } from 'react';

// Fields (W2-12, D-127): the label above in normal case, 13px semibold; a 36px box with 14px text, 8px corners and a
// slightly stronger border; on focus an orange border and glow (owner answer 2); a hint under it, or the problem
// instead (owner answer 6: problems at their field). Same props as the shared TextField, so a screen swaps the import.

/** The label of a kit field, for a group or a control that isn't a text box. */
export const FIELD_LABEL = 'text-[13px] font-semibold text-ink';

/** The box of a kit field, for a native control that needs the same look. */
export const FIELD_BOX =
  'h-9 rounded-lg border border-field-line bg-surface px-3 text-sm shadow-none transition-[border-color,box-shadow] focus-visible:border-focus focus-visible:ring-[3px] focus-visible:ring-glow aria-invalid:border-bad aria-invalid:ring-bad/20';

/** The line under a field: its problem (an alert, red) or its hint. */
export function FieldNote({ id, hint, error }: { id: string; hint?: ReactNode; error?: ReactNode }) {
  if (error)
    return (
      <p id={id} role="alert" className="m-0 text-[12.5px] font-medium text-bad">
        {error}
      </p>
    );
  if (hint)
    return (
      <p id={id} className="m-0 text-[12.5px] text-muted-foreground">
        {hint}
      </p>
    );
  return null;
}

/** A bare box in the kit's look, for a table cell whose column names it (give it an `aria-label`). */
export function TextBox({ className, ...props }: ComponentProps<'input'>) {
  return <Input className={cn(FIELD_BOX, className)} {...props} />;
}

export function TextInput({
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
  const noteId = `${inputId}-note`;
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', wrapperClassName)}>
      <Label htmlFor={inputId} className={FIELD_LABEL}>
        {label}
      </Label>
      <Input
        id={inputId}
        className={cn(FIELD_BOX, className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? noteId : undefined}
        {...props}
      />
      <FieldNote id={noteId} hint={hint} error={error} />
    </div>
  );
}
