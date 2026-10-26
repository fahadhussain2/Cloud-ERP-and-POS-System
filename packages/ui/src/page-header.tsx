import type { ReactNode } from 'react';

/** The top of a back-office screen (W1-04): its title, a line of help, and the main action on the end side. */
export function PageHeader({
  title,
  help,
  actions,
  eyebrow,
}: {
  title: ReactNode;
  help?: ReactNode;
  actions?: ReactNode;
  /** A small line above the title, e.g. the way back to a list. */
  eyebrow?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <div className="flex min-w-0 flex-col gap-1">
        {eyebrow}
        <h1 className="m-0 font-display text-[28px] leading-tight font-bold">{title}</h1>
        {help && <p className="m-0 max-w-[75ch] text-muted-foreground">{help}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}
