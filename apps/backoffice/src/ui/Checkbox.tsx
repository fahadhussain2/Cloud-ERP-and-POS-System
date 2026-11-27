import { cn, Label, Checkbox as SharedCheckbox } from '@erp/ui';
import { useId, type ReactNode } from 'react';

// A checkbox with its label beside it (W2-12, D-127): 18px, the kit's border and orange focus.

export function Checkbox({
  label,
  hint,
  checked,
  onCheckedChange,
  disabled,
  id,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
}) {
  const own = useId();
  const boxId = id ?? own;
  return (
    <div className={cn('flex items-start gap-2.5', className)}>
      <SharedCheckbox
        id={boxId}
        checked={checked}
        onCheckedChange={(v) => onCheckedChange(v === true)}
        {...(disabled ? { disabled: true } : {})}
        aria-describedby={hint ? `${boxId}-hint` : undefined}
        className="mt-0.5 size-[18px] rounded-[5px] border-field-line focus-visible:border-focus focus-visible:ring-[3px] focus-visible:ring-glow"
      />
      <div className="flex flex-col gap-0.5">
        <Label htmlFor={boxId} className="text-sm font-medium text-ink">
          {label}
        </Label>
        {hint && (
          <p id={`${boxId}-hint`} className="m-0 text-[12.5px] text-muted-foreground">
            {hint}
          </p>
        )}
      </div>
    </div>
  );
}
