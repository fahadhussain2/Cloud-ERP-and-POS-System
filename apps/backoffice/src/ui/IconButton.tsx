import {
  cn,
  Button as SharedButton,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@erp/ui';
import type { LucideIcon } from 'lucide-react';
import type { ComponentProps } from 'react';

// A row action as an icon (W2-12, owner 2026-11-26): 32px, named by its label for screen readers ("Edit Khan Motors")
// and showing the same label as a tooltip on hover and focus. `danger` turns red on hover (Delete still asks first).

export function IconButton({
  icon: Icon,
  label,
  tone = 'default',
  className,
  ...props
}: Omit<ComponentProps<'button'>, 'children'> & {
  icon: LucideIcon;
  label: string;
  tone?: 'default' | 'danger';
}) {
  return (
    // Its own provider, so an icon button works anywhere (a dialog, a test).
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <SharedButton
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            className={cn(
              'rounded-lg text-muted-foreground hover:bg-surface-2 hover:text-ink focus-visible:border-focus focus-visible:ring-[3px] focus-visible:ring-glow',
              tone === 'danger' && 'hover:bg-bad-soft hover:text-bad',
              className,
            )}
            {...props}
          >
            <Icon aria-hidden="true" className="size-4" />
          </SharedButton>
        </TooltipTrigger>
        <TooltipContent sideOffset={4}>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
