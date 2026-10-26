import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { ComponentProps, ReactNode } from 'react';

import { Button } from './button';
import { cn } from './cn';
import { Kbd } from './key-bar';

// shadcn/ui's dialog on Radix (D-066): focus stays inside, Esc cancels, focus returns where it was. Every dialog ends
// in the D-053 button bar: Cancel (Esc) plus a main button named after its action.

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
  title,
  description,
  wide = false,
  className,
  children,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & {
  title: ReactNode;
  description?: ReactNode;
  wide?: boolean;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-20 bg-backdrop" />
      <DialogPrimitive.Content
        className={cn(
          'fixed inset-x-0 top-1/2 z-20 mx-auto flex max-h-[calc(100%-32px)] w-[min(520px,calc(100%-32px))] -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-line bg-surface text-ink shadow-panel',
          wide && 'w-[min(760px,calc(100%-32px))]',
          className,
        )}
        {...(description ? {} : { 'aria-describedby': undefined })}
        {...props}
      >
        <header className="border-b border-line px-4 py-3">
          <DialogPrimitive.Title className="m-0 font-display text-[22px] font-semibold tracking-[.02em]">
            {title}
          </DialogPrimitive.Title>
          {description && (
            <DialogPrimitive.Description className="m-0 mt-1 text-muted">
              {description}
            </DialogPrimitive.Description>
          )}
        </header>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogBody({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-3 overflow-auto px-4 py-3.5', className)} {...props} />;
}

/** The button bar (D-053): Cancel (Esc) and the main action; without `onAction` the main button submits its form. */
export function DialogActions({
  cancelLabel,
  actionLabel,
  onAction,
  busy = false,
}: {
  cancelLabel: string;
  actionLabel: string;
  onAction?: () => void;
  busy?: boolean;
}) {
  return (
    <footer className="flex flex-wrap items-center justify-between gap-2.5 border-t border-line bg-surface-2 px-4 py-2.5">
      <DialogPrimitive.Close asChild>
        <Button size="lg">
          {cancelLabel} <Kbd>Esc</Kbd>
        </Button>
      </DialogPrimitive.Close>
      <Button
        size="lg"
        variant="primary"
        type={onAction ? 'button' : 'submit'}
        {...(onAction ? { onClick: onAction } : {})}
        disabled={busy}
      >
        {actionLabel} <Kbd className="border-current bg-transparent text-inherit">Enter</Kbd>
      </Button>
    </footer>
  );
}
