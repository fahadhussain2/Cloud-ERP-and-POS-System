import type { ComponentProps, ReactNode } from 'react';

import { cn } from './cn';

/** A white panel with an optional upper-case title (the prototype's `.panel`). */
export function Panel({
  title,
  className,
  children,
  ...props
}: ComponentProps<'section'> & { title?: ReactNode }) {
  return (
    <section className={cn('rounded-[10px] border border-line bg-surface', className)} {...props}>
      {title && (
        <h2 className="m-0 px-3.5 pt-2.5 pb-1.5 font-display text-[15px] font-semibold tracking-[.06em] text-muted uppercase">
          {title}
        </h2>
      )}
      {children}
    </section>
  );
}
