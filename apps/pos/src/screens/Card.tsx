import { cn } from '@erp/ui';
import type { ReactNode } from 'react';

/** A screen with one centred card: setup, unlock, choosing a PIN, a stop (the prototype's lock screen). */
export function CardScreen({
  eyebrow,
  title,
  children,
  wide = false,
  role,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  children: ReactNode;
  wide?: boolean;
  role?: 'alert';
}) {
  return (
    <main
      className="grid flex-1 place-items-center rounded-[10px] border border-line bg-surface px-4 py-6"
      role={role}
    >
      <div className={cn('flex w-full flex-col gap-3', wide ? 'max-w-[720px]' : 'max-w-[420px]')}>
        {eyebrow && (
          <p className="m-0 text-center text-xs font-semibold tracking-[.1em] text-muted uppercase">
            {eyebrow}
          </p>
        )}
        <h1 className="m-0 text-center font-display text-[34px] leading-tight font-bold tracking-[.02em]">
          {title}
        </h1>
        {children}
      </div>
    </main>
  );
}
