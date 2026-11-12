import { Button } from './components/ui/button';
import { DialogClose, DialogFooter } from './components/ui/dialog';
import { Kbd } from './key-bar';

/**
 * The button bar every dialog ends with (D-053): Cancel (Esc) and a main button named after its action; without
 * `onAction` the main button submits its form. Use it inside shadcn/ui's DialogContent with `showCloseButton={false}`
 * (its corner button has an English label, and Cancel already closes). The key hints are visual; screen readers get
 * them as `aria-keyshortcuts`, so each button's name is just its label.
 */
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
    <DialogFooter className="sm:justify-between">
      <DialogClose asChild>
        <Button variant="outline" size="lg" aria-keyshortcuts="Escape">
          {cancelLabel} <Kbd aria-hidden>Esc</Kbd>
        </Button>
      </DialogClose>
      <Button
        size="lg"
        type={onAction ? 'button' : 'submit'}
        {...(onAction ? { onClick: onAction } : {})}
        disabled={busy}
        aria-keyshortcuts="Enter"
      >
        {actionLabel}{' '}
        <Kbd aria-hidden className="border-current bg-transparent text-inherit">
          Enter
        </Kbd>
      </Button>
    </DialogFooter>
  );
}
