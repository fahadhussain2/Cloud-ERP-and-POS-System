import { CheckCircle2, CircleAlert, X } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

// Toasts (W2-12, owner answer 6): the result of an action ("Khan Motors saved.") in the top-end corner, green, gone
// after a few seconds; a problem that isn't one field's (no connection, no permission) in red, until closed. Problems
// with a field show at the field instead. Our own, not a library: each toast needs its role (`status` or `alert`) for
// screen readers and the tests, which Sonner doesn't give (plan, "Messages").

/** Marks the toasts' region, so a dialog doesn't treat a press on a toast as a press outside it. */
export const TOASTER = 'data-toaster';
const DONE_MS = 4_000;

interface Toast {
  id: number;
  kind: 'done' | 'problem';
  text: string;
}

let toasts: Toast[] = [];
let next = 1;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const remove = (id: number) => {
  toasts = toasts.filter((x) => x.id !== id);
  emit();
};
const add = (kind: Toast['kind'], text: string) => {
  const id = next++;
  toasts = [...toasts, { id, kind, text }];
  emit();
  return id;
};

export const notify = {
  /** A result: saved, added, deleted, deactivated, posted. Fades by itself. */
  done(text: string) {
    const id = add('done', text);
    setTimeout(() => remove(id), DONE_MS);
  },
  /** A problem that isn't one field's. Stays until closed. */
  problem(text: string) {
    add('problem', text);
  },
  /** Takes every toast away (on signing out, and between tests). */
  clear() {
    toasts = [];
    emit();
  },
};

/** The toasts' place, once in the back office's frame. */
export function Toaster() {
  const { t } = useTranslation();
  const list = useSyncExternalStore(subscribe, () => toasts);
  return (
    // aria-live keeps the region readable while a dialog hides the rest of the page (Radix leaves live regions
    // alone); "off" because each toast announces itself through its role.
    <section
      {...{ [TOASTER]: '' }}
      aria-label={t('app.notifications')}
      aria-live="off"
      className="pointer-events-none fixed end-3 top-3 z-[60] flex w-[min(380px,calc(100%-24px))] flex-col gap-2 sm:end-4 sm:top-16"
    >
      {list.map((x) => {
        const done = x.kind === 'done';
        const Icon = done ? CheckCircle2 : CircleAlert;
        return (
          <div
            key={x.id}
            role={done ? 'status' : 'alert'}
            className={
              'pointer-events-auto flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-sm shadow-panel ' +
              (done ? 'border-ok/30 bg-ok-soft text-ok' : 'border-bad/30 bg-bad-soft text-bad')
            }
          >
            <Icon aria-hidden="true" className="mt-px size-4 shrink-0" />
            <p className="m-0 flex-1 font-medium text-ink">{x.text}</p>
            <button
              type="button"
              aria-label={t('app.close')}
              onClick={() => remove(x.id)}
              className="-me-1 -mt-0.5 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-surface/60 hover:text-ink focus-visible:ring-[3px] focus-visible:ring-glow focus-visible:outline-none"
            >
              <X aria-hidden="true" className="size-3.5" />
            </button>
          </div>
        );
      })}
    </section>
  );
}
