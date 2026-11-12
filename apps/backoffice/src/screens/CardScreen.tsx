import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/** Sign-in and the forced password change: one centred card on the page (as the counter's lock screen, W1-04). */
export function CardScreen({
  title,
  help,
  children,
}: {
  title: ReactNode;
  help?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <main className="grid min-h-svh place-items-center bg-bg px-4 py-6 text-ink">
      <div className="flex w-full max-w-[420px] flex-col gap-3 rounded-[10px] border border-line bg-surface p-6">
        <p className="m-0 text-center font-display text-[22px] font-bold text-primary">{t('app.brand')}</p>
        <h1 className="m-0 text-center font-display text-[34px] leading-tight font-bold tracking-[.02em]">
          {title}
        </h1>
        {help && <p className="m-0 text-center text-muted-foreground">{help}</p>}
        {children}
      </div>
    </main>
  );
}
