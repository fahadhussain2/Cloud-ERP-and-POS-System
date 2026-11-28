import { PageHeader, Panel } from '@erp/ui';
import { RotateCw } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from './Button';

// The back office's error screen (W2-17, owner's staging test 2026-11-28): a screen that fails for a reason nobody
// foresaw used to leave a blank page (a huge unit cost did, before the check learnt to say "too large"). The screen's
// place shows what happened and Reload instead; the menu stays, so another screen can be opened. Moving to another
// address tries again.

function Failed() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t('app.failed.title')} help={t('app.failed.text')} />
      <Panel className="p-3.5">
        <Button icon={RotateCw} onClick={() => window.location.reload()}>
          {t('app.failed.reload')}
        </Button>
      </Panel>
    </>
  );
}

export class ScreenGuard extends Component<
  { children: ReactNode; /** Where the screen is: a new address clears a failure. */ at: string },
  { failedAt: string | null }
> {
  override state: { failedAt: string | null } = { failedAt: null };

  static getDerivedStateFromError(): Partial<{ failedAt: string | null }> {
    // Marked as failed here; getDerivedStateFromProps, which runs next, records at which address.
    return { failedAt: '' };
  }

  static getDerivedStateFromProps(
    props: { at: string },
    state: { failedAt: string | null },
  ): Partial<{ failedAt: string | null }> | null {
    if (state.failedAt === '') return { failedAt: props.at };
    if (state.failedAt !== null && state.failedAt !== props.at) return { failedAt: null };
    return null;
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // Kept in the browser's console for whoever looks into it.
    console.error(error, info.componentStack);
  }

  override render() {
    return this.state.failedAt === null ? this.props.children : <Failed />;
  }
}
