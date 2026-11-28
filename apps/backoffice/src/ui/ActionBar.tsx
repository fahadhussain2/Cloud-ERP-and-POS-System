import { cn } from '@erp/ui';
import type { ReactNode } from 'react';

// A bar kept at the bottom of the window while the page scrolls (W2-16, owner 2026-11-28): a document's totals and
// its Save and Post, always in view while its lines are typed. It runs the width of the frame's content, out to the
// edges of its padding, so it sits as the content's foot. Its parts wrap on a narrow window. Not printed.

export function ActionBar({
  label,
  children,
  className,
}: {
  /** The region's spoken name ("Save or post"). */
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="region"
      aria-label={label}
      className={cn(
        'sticky bottom-0 z-20 -mx-4 -mb-4 mt-1 flex flex-wrap items-center gap-x-5 gap-y-3 border-t border-line bg-surface px-4 py-3 shadow-[0_-8px_24px_rgb(22_32_42/0.08)] md:-mx-7 md:-mb-5 md:px-7 print:hidden',
        className,
      )}
    >
      {children}
    </div>
  );
}
