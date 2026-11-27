import {
  cn,
  Label,
  SelectContent,
  SelectItem,
  Select as SharedSelect,
  SelectTrigger,
  SelectValue,
} from '@erp/ui';
import { ChevronsUpDown } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { FIELD_BOX, FIELD_LABEL, FieldNote } from './Field';

// The back office's dropdown (W2-12, D-127), for short fixed lists (owner answer 3; long ones get a searchable
// picker): the chosen option with ↕, the open list a rounded card with a tick beside the chosen option. ↑ ↓, Home,
// End, typing a letter, Enter and Esc come from Radix's select (the shared one in packages/ui, composed, not edited).

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export function Select({
  label,
  hint,
  error,
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  id,
  className,
  wrapperClassName,
  'aria-label': ariaLabel,
}: {
  /** Shown above; leave it out in a toolbar and give `aria-label` instead. */
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
  wrapperClassName?: string;
  'aria-label'?: string;
}) {
  const { t } = useTranslation();
  const own = useId();
  const triggerId = id ?? own;
  const noteId = `${triggerId}-note`;
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', wrapperClassName)}>
      {label !== undefined && (
        <Label htmlFor={triggerId} className={FIELD_LABEL}>
          {label}
        </Label>
      )}
      <SharedSelect value={value} onValueChange={onValueChange} disabled={disabled}>
        <SelectTrigger
          id={triggerId}
          aria-label={ariaLabel}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? noteId : undefined}
          className={cn(
            FIELD_BOX,
            'w-full justify-between gap-2 data-[size=default]:h-9 [&>svg:last-child]:hidden',
            className,
          )}
        >
          <SelectValue placeholder={placeholder} />
          <ChevronsUpDown aria-hidden="true" className="size-4 text-muted-foreground" />
        </SelectTrigger>
        <SelectContent position="popper" sideOffset={4} className="rounded-xl border-line shadow-panel">
          {options.length === 0 ? (
            <p className="m-0 px-3 py-2 text-sm text-muted-foreground">{t('app.noOptions')}</p>
          ) : (
            options.map((o) => (
              <SelectItem
                key={o.value}
                value={o.value}
                {...(o.disabled ? { disabled: true } : {})}
                className="h-[34px] cursor-pointer rounded-md ps-2.5 text-sm focus:bg-surface-2 focus:text-ink data-[state=checked]:font-semibold [&_svg]:text-primary"
              >
                {o.label}
              </SelectItem>
            ))
          )}
        </SelectContent>
      </SharedSelect>
      <FieldNote id={noteId} hint={hint} error={error} />
    </div>
  );
}
