import type { ReactNode } from 'react';

/** The one-screen frame (the prototype): status along the top, the work area, the key bar along the bottom. */
export function AppFrame({
  top,
  bottom,
  children,
}: {
  top: ReactNode;
  bottom?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)_auto] gap-2.5 px-4 py-2.5">
      {top}
      <div className="flex min-h-0 flex-col">{children}</div>
      {bottom ?? <span />}
    </div>
  );
}
