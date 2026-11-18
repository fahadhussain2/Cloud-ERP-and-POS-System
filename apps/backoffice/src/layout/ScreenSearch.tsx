import { Dialog, DialogContent, DialogTitle, Input, moveSelection, OptionList } from '@erp/ui';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { navigate } from '../router';
import type { ReportEntry } from '../reports/catalog';
import type { MenuGroup } from './menu';

// Go to a screen by its name (W1-28 plan, owner answer 1): Ctrl K or the top bar's search opens it; typing narrows the
// screens this person may open, by their name or their group's; ↑ ↓ choose and Enter or a click opens one. Screens
// only: finding items, customers or bills from here is a later task. Each report is found by its own name too, though
// the menu shows only the Reports home (W2-01, owner answer 1).

export function ScreenSearch({
  groups,
  reports = [],
  open,
  onOpenChange,
}: {
  /** The menu as this person may open it. */
  groups: readonly MenuGroup[];
  /** The reports this person may open. */
  reports?: readonly ReportEntry[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [selected, setSelected] = useState(0);
  const listId = useId();

  const q = text.trim().toLocaleLowerCase();
  const screens = [
    ...groups.flatMap((g) =>
      g.items.map((i) => ({
        key: i.key,
        href: i.href,
        label: t(`nav.${i.key}`),
        group: t(`nav.groups.${g.group}`),
      })),
    ),
    ...reports.map((r) => ({
      key: r.key,
      href: r.href,
      label: t(`nav.${r.key}`),
      group: t('nav.groups.reports'),
    })),
  ].filter((s) => q === '' || `${s.label}\n${s.group}`.toLocaleLowerCase().includes(q));
  const at = Math.min(selected, Math.max(0, screens.length - 1));

  const close = (next: boolean) => {
    if (!next) {
      setText('');
      setSelected(0);
    }
    onOpenChange(next);
  };
  const go = (i: number) => {
    const s = screens[i];
    if (!s) return;
    close(false);
    navigate(s.href);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        aria-describedby={undefined}
        showCloseButton={false}
        className="top-[15%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-md"
      >
        <DialogTitle className="sr-only">{t('nav.searchTitle')}</DialogTitle>
        <div className="border-b border-line p-2">
          <Input
            autoFocus
            role="combobox"
            aria-label={t('nav.searchLabel')}
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={screens.length > 0 ? `${listId}-${at}` : undefined}
            placeholder={t('nav.searchTitle')}
            className="h-10 border-0 shadow-none focus-visible:ring-0"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setSelected(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                go(at);
                return;
              }
              const next = moveSelection(at, e.key, screens.length);
              if (next !== null) {
                e.preventDefault();
                setSelected(next);
              }
            }}
          />
        </div>
        {screens.length === 0 ? (
          <p className="m-0 px-4 py-6 text-center text-muted-foreground">{t('nav.searchNone')}</p>
        ) : (
          <OptionList
            id={listId}
            label={t('nav.searchTitle')}
            items={screens}
            selected={at}
            itemKey={(s) => s.key}
            onSelect={go}
            className="max-h-80 p-1.5"
          >
            {(s) => (
              <div className="flex items-baseline justify-between gap-3 px-2.5 py-2">
                <span>{s.label}</span>
                <span className="text-xs text-muted-foreground">{s.group}</span>
              </div>
            )}
          </OptionList>
        )}
      </DialogContent>
    </Dialog>
  );
}
