import { cn, Input } from '@erp/ui';
import { Search } from 'lucide-react';
import type { ReactNode } from 'react';

import { FIELD_BOX } from './Field';

// A list's own toolbar (W2-12, the mockup): the search with its icon, then the filters, then the count at the end,
// inside the table's panel rather than in a panel of their own. Wraps on a narrow screen; on a phone the search takes
// the whole width.

export function ListToolbar({
  search,
  children,
  count,
  className,
}: {
  search?: { label: string; value: string; onChange: (value: string) => void; placeholder?: string };
  children?: ReactNode;
  count?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5', className)}>
      {search && (
        <div className="relative min-w-0 basis-full sm:basis-72">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            aria-label={search.label}
            placeholder={search.placeholder ?? search.label}
            value={search.value}
            onChange={(e) => search.onChange(e.target.value)}
            className={cn(FIELD_BOX, 'ps-8')}
          />
        </div>
      )}
      {children}
      {count !== undefined && (
        <span className="ms-auto text-[13px] whitespace-nowrap text-muted-foreground">{count}</span>
      )}
    </div>
  );
}
