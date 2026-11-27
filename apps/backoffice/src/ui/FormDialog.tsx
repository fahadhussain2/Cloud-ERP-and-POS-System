import {
  cn,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@erp/ui';
import { X, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from './Button';
import { TOASTER } from './notify';

// The back office's dialog (W2-12, D-127; the owner's reference, 2026-11-27): centred, at most 90% of the screen's
// height; the title at the top, the fields scrolling in the middle, and the D-053 bar fixed at the bottom right under
// a line: Cancel (✕) then the main button (its icon, owner answer 5). No visible key hints (owner answer 1): Esc
// closes and Enter submits as before, and screen readers hear them (`aria-keyshortcuts`). On a phone it takes the
// width and the buttons stay at the bottom. On the shared Dialog, composed with back-office classes, not edited.

const WIDTH = { sm: 'sm:max-w-[440px]', md: 'sm:max-w-[560px]', lg: 'sm:max-w-[680px]' } as const;

export type DialogSize = keyof typeof WIDTH;

export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  actionLabel,
  actionIcon,
  busy,
  onSubmit,
  children,
  cancelLabel,
  size = 'md',
  tone = 'default',
  errors,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  actionLabel: string;
  /** The main button's icon: Save for a form that saves (owner answer 5). */
  actionIcon?: LucideIcon;
  busy: boolean;
  onSubmit: () => void;
  children?: ReactNode;
  cancelLabel?: string;
  size?: DialogSize;
  /** `danger`: the main button is red (Delete, Deactivate). */
  tone?: 'default' | 'danger';
  /**
   * The form's problems by field (owner answer 6). After a save is tried, focus goes to the first field marked wrong
   * (`aria-invalid`) and the body scrolls to it. Fixing a field later doesn't move focus.
   */
  errors?: Record<string, ReactNode | undefined>;
}) {
  const { t } = useTranslation();
  // These dialogs open from state, not a DialogTrigger, so Radix can't know where focus came from: remember it and
  // give it back on close (D-053: Esc returns you where you were).
  const opener = useRef<HTMLElement | null>(null);
  const body = useRef<HTMLDivElement | null>(null);
  const tried = useRef(false);

  useEffect(() => {
    if (!tried.current || !errors || !Object.values(errors).some(Boolean)) return;
    tried.current = false;
    const first = body.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    first?.scrollIntoView?.({ block: 'center' });
    first?.focus();
  }, [errors]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    tried.current = true;
    onSubmit();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        {...(description ? {} : { 'aria-describedby': undefined })}
        className={cn(
          'flex max-h-[min(90dvh,860px)] max-w-[calc(100%-24px)] flex-col gap-0 overflow-hidden rounded-xl border-line bg-surface p-0',
          WIDTH[size],
        )}
        onOpenAutoFocus={() => {
          tried.current = false;
          opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }}
        onCloseAutoFocus={(e) => {
          if (!opener.current?.isConnected) return;
          e.preventDefault();
          opener.current.focus();
        }}
        // A toast's close button is outside the dialog; pressing it must not close the form (owner answer 6).
        onInteractOutside={(e) => {
          if (e.target instanceof Element && e.target.closest(`[${TOASTER}]`)) e.preventDefault();
        }}
      >
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit} noValidate>
          <DialogHeader className="flex-row items-start gap-3 ps-6 pe-14 pt-5 pb-3 text-start sm:text-start">
            <div className="flex min-w-0 flex-col gap-1">
              <DialogTitle className="font-display text-[22px] leading-tight font-bold">{title}</DialogTitle>
              {description && <DialogDescription>{description}</DialogDescription>}
            </div>
          </DialogHeader>
          <div
            ref={body}
            data-slot="dialog-body"
            className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pt-1 pb-5"
          >
            {children}
          </div>
          <DialogFooter className="flex-row justify-end gap-2 border-t border-line bg-surface px-6 py-3.5">
            <DialogClose asChild>
              <Button type="button" variant="outline" icon={X} aria-keyshortcuts="Escape">
                {cancelLabel ?? t('app.cancel')}
              </Button>
            </DialogClose>
            <Button
              type="submit"
              variant={tone === 'danger' ? 'destructive' : 'default'}
              {...(actionIcon ? { icon: actionIcon } : {})}
              disabled={busy}
              aria-keyshortcuts="Enter"
            >
              {actionLabel}
            </Button>
          </DialogFooter>
        </form>
        {/* After the form, so opening the dialog puts focus on its first field, not here. No tooltip: Esc would close
            the tooltip first instead of the dialog. */}
        <DialogClose
          aria-label={t('app.close')}
          className="absolute end-3 top-3.5 grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-surface-2 hover:text-ink focus-visible:border-focus focus-visible:ring-[3px] focus-visible:ring-glow focus-visible:outline-none"
        >
          <X aria-hidden="true" className="size-4" />
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}

/** A question before an action (Deactivate, Reactivate, Delete): the small dialog with its text. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  children,
  actionLabel,
  actionIcon,
  tone = 'default',
  busy,
  onConfirm,
  cancelLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  children?: ReactNode;
  actionLabel: string;
  actionIcon?: LucideIcon;
  tone?: 'default' | 'danger';
  busy: boolean;
  onConfirm: () => void;
  cancelLabel?: string;
}) {
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      actionLabel={actionLabel}
      {...(actionIcon ? { actionIcon } : {})}
      {...(cancelLabel ? { cancelLabel } : {})}
      tone={tone}
      busy={busy}
      onSubmit={onConfirm}
      size="sm"
    >
      {children && <div className="text-sm text-muted-foreground">{children}</div>}
    </FormDialog>
  );
}
