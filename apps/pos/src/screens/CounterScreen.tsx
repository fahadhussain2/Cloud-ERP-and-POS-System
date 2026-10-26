import {
  Badge,
  formatMoney,
  Input,
  KeyBar,
  Kbd,
  Label,
  LABEL_CLASS,
  moveSelection,
  OptionList,
  Panel,
  useShortcuts,
  type MoneyFormat,
} from '@erp/ui';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { Counter } from '../counter';
import type { SearchResult, Vehicle } from '../search/search-index';

// The counter screen (POS spec §9, POS-02, POS-03): search on the left, the bill on the right (bill lines come with
// W1-05), the key bar along the bottom. Every key press searches the local catalog; an older answer never replaces a
// newer one.

const CATALOG_POLL_MS = 1000;

export function CounterScreen({
  counter,
  money,
  onLock,
}: {
  counter: Pick<Counter, 'search' | 'catalog'>;
  money: MoneyFormat;
  onLock: () => void;
}) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selected, setSelected] = useState(0);
  const [catalog, setCatalog] = useState<{ items: number; ready: boolean } | null>(null);
  const latest = useRef(0);

  // Until the first catalog load has finished, show its progress instead of the search (POS spec §9).
  const ready = catalog?.ready ?? false;
  useEffect(() => {
    if (ready) return;
    let stop = false;
    const check = async () => {
      const c = await counter.catalog();
      if (!stop) setCatalog(c);
    };
    void check();
    const timer = setInterval(() => void check(), CATALOG_POLL_MS);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [counter, ready]);

  const type = (value: string) => {
    setText(value);
    const request = ++latest.current;
    if (value.trim() === '') return setResults([]);
    void counter.search(value).then((r) => {
      if (request !== latest.current) return;
      setResults(r);
      setSelected(0);
    });
  };

  const focusSearch = () => {
    input.current?.focus();
    input.current?.select();
  };
  const clear = () => {
    type('');
    input.current?.focus();
  };
  const move = (key: string) => {
    const next = moveSelection(selected, key, results.length);
    if (next !== null) setSelected(next);
    return next !== null;
  };

  useShortcuts({ F2: focusSearch, 'Alt+L': onLock });

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      clear();
    } else if (move(e.key)) e.preventDefault();
  };

  const vehicle = (v: Vehicle | null) => {
    if (!v) return null;
    const years =
      v.yearFrom !== null && v.yearTo !== null
        ? t('search.years', { from: v.yearFrom, to: v.yearTo })
        : v.yearFrom !== null
          ? t('search.yearsFrom', { from: v.yearFrom })
          : v.yearTo !== null
            ? t('search.yearsTo', { to: v.yearTo })
            : null;
    return [v.make, v.model, years].filter(Boolean).join(' ');
  };

  const count =
    text.trim() === ''
      ? t('search.items', { count: catalog?.items ?? 0 })
      : results.length >= 50
        ? t('search.top', { count: results.length })
        : t('search.found', { count: results.length });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5">
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,5fr)_minmax(0,6fr)] gap-2.5 max-[780px]:grid-cols-1">
        <Panel aria-label={t('search.panel')} className="flex min-h-0 flex-col overflow-hidden">
          {!ready ? (
            <div className="flex flex-col gap-2 px-3.5 py-5" role="status">
              <p className="m-0 font-display text-xl font-semibold">
                {t('catalog.loading', { count: catalog?.items ?? 0 })}
              </p>
              <p className="m-0 text-muted-foreground">{t('catalog.help')}</p>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-1.5 px-3.5 pt-3 pb-2">
                <Label htmlFor="search" className={LABEL_CLASS}>
                  {t('search.label')} <Kbd>F2</Kbd>
                </Label>
                <Input
                  id="search"
                  ref={input}
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  className="h-11 bg-surface-2 font-mono text-base focus-visible:bg-surface"
                  placeholder={t('search.placeholder')}
                  role="combobox"
                  aria-expanded={results.length > 0}
                  aria-controls="results"
                  aria-activedescendant={results.length > 0 ? `results-${selected}` : undefined}
                  value={text}
                  onChange={(e) => type(e.target.value)}
                  onKeyDown={onKeyDown}
                />
              </div>
              <div className="flex justify-between px-3.5 pb-1.5 text-[11.5px] text-muted-foreground">
                <span>{count}</span>
                <span>{t('search.priceHead')}</span>
              </div>
              {text.trim() === '' ? (
                <p className="m-0 px-3.5 py-4 text-muted-foreground">{t('search.hint')}</p>
              ) : results.length === 0 ? (
                <p className="m-0 px-3.5 py-4 text-muted-foreground">
                  {t('search.none', { text: text.trim() })}
                </p>
              ) : (
                <OptionList
                  id="results"
                  label={t('search.results')}
                  items={results}
                  selected={selected}
                  itemKey={(r) => r.id}
                  onSelect={(i) => {
                    setSelected(i);
                    input.current?.focus();
                  }}
                  className="flex-1 px-1.5 pb-2"
                >
                  {(r) => (
                    <div className="grid grid-cols-[84px_minmax(0,1fr)_auto] items-center gap-2.5 px-2 py-[7px]">
                      <span className="font-mono text-[12.5px] font-semibold">{r.code}</span>
                      <span className="flex min-w-0 flex-col">
                        <span className="font-medium wrap-anywhere">
                          {r.name}{' '}
                          {r.status !== 'active' && (
                            <Badge variant="outline" className="border-transparent bg-warn-soft text-warn">
                              {t(`item.status.${r.status}`)}
                            </Badge>
                          )}
                        </span>
                        <span className="text-xs text-muted-foreground wrap-anywhere">
                          {[
                            [r.variant, r.spec].filter(Boolean).join(' '),
                            r.oem && t('search.oem', { oem: r.oem }),
                            vehicle(r.vehicle),
                            r.bin && t('search.bin', { bin: r.bin }),
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                      <span className="min-w-[76px] text-end font-semibold whitespace-nowrap tabular-nums">
                        {r.price === null ? (
                          <span className="font-normal text-muted-foreground">{t('search.noPrice')}</span>
                        ) : (
                          formatMoney(r.price, money)
                        )}
                      </span>
                    </div>
                  )}
                </OptionList>
              )}
            </>
          )}
        </Panel>
        <Panel title={t('bill.title')} aria-label={t('bill.title')}>
          <p className="m-0 px-3.5 py-4 text-muted-foreground">{t('bill.soon')}</p>
        </Panel>
      </div>
      <KeyBar
        title={t('keys.counter')}
        hints={[
          { keys: 'F2', label: t('keys.search'), run: focusSearch },
          { keys: '↑ ↓', label: t('keys.select'), run: () => void move('ArrowDown') },
          { keys: 'Esc', label: t('keys.clear'), run: clear },
          { keys: 'Alt+L', label: t('keys.lock'), run: onLock },
        ]}
      />
    </div>
  );
}
