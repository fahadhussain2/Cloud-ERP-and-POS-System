import {
  DomainError,
  money,
  parseBillCode,
  parseWholeAmount,
  queueGroups,
  type Money,
  type QueueBill,
} from '@erp/domain';
import {
  Badge,
  formatMoney,
  Input,
  KeyBar,
  Panel,
  plainAmount,
  useShortcuts,
  type KeyHint,
  type MoneyFormat,
} from '@erp/ui';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { Counter } from '../counter';
import type { DeskState } from '../db/desk';
import type { StaffUser } from '../unlock/unlock';
import { ConfirmDialog, EntryDialog } from './BillDialogs';

// The cash desk (W1-10, cash desk spec, CSH-01…CSH-04, PRD W4, W7): the session bar on top, the live queue grouped by
// salesman, and the scan field, which always has the focus. Enter confirms the selected bill as shown; E corrects the
// cash received first; a scan selects its bill, or, for a bill not in the queue yet (its counter hasn't synced, or
// this desk is offline), asks before recording it from the code (owner answer 2). Every confirmation is a document
// in this desk's outbox, written before anything else happens (rule 6).

export type CashDeskCounter = Pick<
  Counter,
  'deskState' | 'openSession' | 'closeSession' | 'confirmHandover' | 'grants' | 'log'
>;

type Dialog =
  | { kind: 'open' }
  | { kind: 'close' }
  | { kind: 'correct'; bill: QueueBill }
  | { kind: 'unknown'; number: string; cashDue: Money };

interface Message {
  tone: 'ok' | 'bad';
  text: string;
}

export function CashDeskScreen({
  counter,
  money: fmt,
  user,
  staff,
  timeZone,
  offline,
  offlineSince,
  syncTick,
  onSaved,
  onSell,
  onLock,
}: {
  counter: CashDeskCounter;
  money: MoneyFormat;
  user: StaffUser;
  staff: readonly StaffUser[];
  /** Kept for the shell; the worker checks the permissions (W1-10). */
  branchId: string | null;
  timeZone: string;
  offline: boolean;
  offlineSince: Date | null;
  /** Changes after every pull: the queue is read again. */
  syncTick: number;
  /** After a document is written: push it at once (SYN-02) and refresh the status bar. */
  onSaved: () => void;
  onSell: () => void;
  onLock: () => void;
}) {
  const { t } = useTranslation();
  const [desk, setDesk] = useState<DeskState | null>(null);
  const [selected, setSelected] = useState(0);
  const [scanned, setScanned] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const scan = useRef<HTMLInputElement>(null);

  const unit = money(10 ** fmt.minorUnits);
  const rs = (m: number) => formatMoney(m, fmt);
  const time = (iso: string) =>
    new Intl.DateTimeFormat(fmt.locale, { timeZone, timeStyle: 'short' }).format(new Date(iso));
  const nameOf = (id: string) => staff.find((s) => s.id === id)?.fullName ?? t('desk.unknownSeller');

  const reload = useCallback(async () => setDesk(await counter.deskState()), [counter]);
  useEffect(() => {
    void counter.deskState().then(setDesk);
  }, [counter, syncTick]);

  const groups = desk
    ? queueGroups({
        entries: desk.queue,
        local: desk.local,
        sellers: Object.fromEntries(staff.map((s) => [s.id, s.fullName])),
      })
    : [];
  const bills = groups.flatMap((g) => g.bills);
  const current = bills[Math.min(selected, bills.length - 1)] ?? null;
  const session = desk?.session ?? null;
  const open = session?.status === 'open' ? session : null;

  // The scan field keeps the focus whenever no dialog is open (a keyboard-wedge scanner types into it).
  useEffect(() => {
    if (dialog === null) scan.current?.focus();
  }, [dialog, desk]);

  const fail = (err: unknown) => {
    if (err instanceof DomainError) setMessage({ tone: 'bad', text: t(`handover.${err.code}`) });
    else setMessage({ tone: 'bad', text: t('handover.failed', { message: (err as Error).message }) });
  };

  /** Writes a handover (or a payout) and reads the desk again. */
  const record = async (
    number: string,
    opts: { cashReceived: Money | null; code: { cashDue: Money } | null; method: 'queue' | 'scan' },
  ) => {
    if (busy) return;
    setBusy(true);
    try {
      const doc = await counter.confirmHandover({ userId: user.id, billNumber: number, ...opts });
      const amount = rs(doc.amount);
      setMessage({
        tone: 'ok',
        text:
          doc.kind === 'payout'
            ? t('desk.paid', { amount, number })
            : doc.changeGiven === null
              ? t('desk.receivedNoChange', { amount, number })
              : t('desk.received', { amount, number, change: rs(doc.changeGiven) }),
      });
      setScanned(null);
      await reload();
      onSaved();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const confirmSelected = (cashReceived: Money | null = null) => {
    if (!current) return;
    void record(current.number, {
      cashReceived,
      code: null,
      method: scanned === current.number ? 'scan' : 'queue',
    });
  };

  /** A scan (PRD W4, CSH-03): its bill is selected; one not in the queue asks before recording it. */
  const onScan = (raw: string) => {
    let code;
    try {
      code = parseBillCode(raw, unit);
    } catch {
      setMessage({ tone: 'bad', text: t('desk.invalidCode', { text: raw.trim() }) });
      return;
    }
    const i = bills.findIndex((b) => b.number === code.number);
    if (i >= 0) {
      setSelected(i);
      setScanned(code.number);
      setMessage(null);
      return;
    }
    const mine = desk?.local.find((h) => h.billNumber === code.number);
    if (mine) {
      setMessage({
        tone: 'bad',
        text: t('handover.already_handed_over_by', {
          number: mine.number,
          name: nameOf(mine.cashierId),
          time: time(mine.at),
        }),
      });
      return;
    }
    const known = desk?.queue.find((e) => e.number === code.number);
    if (known && known.handoverStatus !== 'pending') {
      setMessage({ tone: 'bad', text: t('handover.already_handed_over') });
      return;
    }
    if (code.cashDue === 0) {
      setMessage({ tone: 'bad', text: t('handover.nothing_to_collect') });
      return;
    }
    setDialog({ kind: 'unknown', number: code.number, cashDue: code.cashDue });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const value = text;
      setText('');
      if (value.trim() === '') confirmSelected();
      else onScan(value);
      return;
    }
    if (text !== '') return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = bills.length;
      if (n === 0) return;
      setSelected((s) => Math.max(0, Math.min(n - 1, s + (e.key === 'ArrowDown' ? 1 : -1))));
      setScanned(null);
    } else if ((e.key === 'e' || e.key === 'E') && !e.altKey && !e.ctrlKey && current?.kind === 'in') {
      e.preventDefault();
      setDialog({ kind: 'correct', bill: current });
    }
  };

  const openSession = async (float: Money) => {
    try {
      const doc = await counter.openSession({ userId: user.id, openingFloat: float });
      setMessage({ tone: 'ok', text: t('desk.open.opened', { number: doc.number, amount: rs(float) }) });
      await reload();
      onSaved();
    } catch (err) {
      fail(err);
    }
  };

  const closeSession = async () => {
    try {
      const doc = await counter.closeSession({ userId: user.id });
      setMessage({ tone: 'ok', text: t('desk.close.closed', { number: doc.number }) });
      await reload();
      onSaved();
    } catch (err) {
      fail(err);
    }
  };

  useShortcuts(
    {
      // Not gated on the roles, which load after the screen: the worker refuses without the permission
      // (`not_permitted`), and the message says so.
      'Alt+O': () => open === null && setDialog({ kind: 'open' }),
      'Alt+X': () => open !== null && setDialog({ kind: 'close' }),
      'Alt+Q': onSell,
      'Alt+L': onLock,
    },
    dialog === null,
  );

  const hints: KeyHint[] = [
    { keys: 'Enter', label: t('desk.keys.confirm'), run: () => confirmSelected(), main: true },
    {
      keys: 'E',
      label: t('desk.keys.correct'),
      run: () => current?.kind === 'in' && setDialog({ kind: 'correct', bill: current }),
    },
    { keys: '↑ ↓', label: t('desk.keys.select'), run: () => scan.current?.focus() },
    open === null
      ? { keys: 'Alt+O', label: t('desk.keys.open'), run: () => setDialog({ kind: 'open' }) }
      : { keys: 'Alt+X', label: t('desk.keys.close'), run: () => setDialog({ kind: 'close' }) },
    { keys: 'Alt+Q', label: t('keys.sell'), run: onSell },
    { keys: 'Alt+L', label: t('keys.lock'), run: onLock },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <Panel
        className="flex flex-wrap items-center gap-x-6 gap-y-2 px-3.5 py-2.5"
        aria-label={t('desk.title')}
      >
        {open === null ? (
          <span className="font-semibold">{t('desk.noSession')}</span>
        ) : open.cashierId === user.id ? (
          <>
            <span className="font-semibold">
              {t('desk.session', {
                number: open.number,
                name: nameOf(open.cashierId),
                time: time(open.openedAt),
              })}
            </span>
            <Figure label={t('desk.float')} value={rs(open.openingFloat)} />
            <Figure label={t('desk.handedIn')} value={rs(open.handedIn)} />
            <Figure label={t('desk.paidOut')} value={rs(open.paidOut)} />
            <Figure label={t('desk.expected')} value={rs(open.expected)} strong />
          </>
        ) : (
          <span className="font-semibold text-warn">
            {t('desk.otherSession', { name: nameOf(open.cashierId), time: time(open.openedAt) })}
          </span>
        )}
      </Panel>

      {offline && (
        <p role="status" className="m-0 rounded-[10px] bg-warn-soft px-3.5 py-2 font-semibold text-warn">
          {t('desk.offline', { time: offlineSince ? time(offlineSince.toISOString()) : '—' })}
        </p>
      )}

      <div className="flex flex-col gap-1">
        <label htmlFor="desk-scan" className="text-sm text-muted-foreground">
          {t('desk.scanHelp')}
        </label>
        <Input
          id="desk-scan"
          ref={scan}
          aria-label={t('desk.scan')}
          placeholder={t('desk.scan')}
          autoComplete="off"
          className="font-mono"
          value={text}
          onChange={(e) => setText(e.target.value.toUpperCase())}
          onKeyDown={onKeyDown}
        />
        {message && (
          <p
            role={message.tone === 'bad' ? 'alert' : 'status'}
            className={`m-0 font-semibold ${message.tone === 'ok' ? 'text-ok' : 'text-bad'}`}
          >
            {message.text}
          </p>
        )}
      </div>

      <Panel title={t('desk.queue')} aria-label={t('desk.queue')} className="min-h-0 flex-1 overflow-y-auto">
        {groups.length === 0 ? (
          <p className="m-0 px-3.5 pb-3 text-muted-foreground">{t('desk.empty')}</p>
        ) : (
          <table className="w-full border-collapse text-[15px]">
            <thead>
              <tr className="text-start text-sm text-muted-foreground">
                <th className="px-3.5 py-1 text-start font-medium">{t('desk.col.counter')}</th>
                <th className="px-2 py-1 text-start font-medium">{t('desk.col.bill')}</th>
                <th className="px-2 py-1 text-start font-medium">{t('desk.col.time')}</th>
                <th className="px-2 py-1 text-end font-medium">{t('desk.col.due')}</th>
                <th className="px-2 py-1 text-end font-medium">{t('desk.col.received')}</th>
                <th className="px-3.5 py-1 text-end font-medium">{t('desk.col.change')}</th>
              </tr>
            </thead>
            {groups.map((g) => (
              <tbody key={g.sellerId} aria-label={g.sellerName ?? t('desk.unknownSeller')}>
                <tr className="bg-surface-2">
                  <th colSpan={6} className="px-3.5 py-1.5 text-start">
                    <span className="font-semibold">{g.sellerName ?? t('desk.unknownSeller')}</span>
                    {g.toCollect > 0 && (
                      <Badge variant="secondary" className="ms-3">
                        {t('desk.toCollect', { amount: rs(g.toCollect) })}
                      </Badge>
                    )}
                    {g.toPayOut > 0 && (
                      <Badge variant="secondary" className="ms-2 text-warn">
                        {t('desk.toPayOut', { amount: rs(g.toPayOut) })}
                      </Badge>
                    )}
                  </th>
                </tr>
                {g.bills.map((b) => {
                  const isSelected = b === current;
                  return (
                    <tr
                      key={b.id}
                      aria-selected={isSelected}
                      onClick={() => {
                        setSelected(bills.indexOf(b));
                        setScanned(null);
                        scan.current?.focus();
                      }}
                      className={isSelected ? 'bg-select' : 'cursor-pointer'}
                    >
                      <td className="px-3.5 py-1.5 font-mono">{b.number.split('-')[0]}</td>
                      <td className="px-2 py-1.5 font-mono">{b.number}</td>
                      <td className="px-2 py-1.5">{time(b.createdAt)}</td>
                      <td
                        className={`px-2 py-1.5 text-end text-lg font-semibold ${b.kind === 'in' ? 'text-ok' : 'text-warn'}`}
                      >
                        {b.kind === 'in' ? rs(b.amount) : t('desk.payout', { amount: rs(b.amount) })}
                      </td>
                      <td className="px-2 py-1.5 text-end">
                        {b.kind === 'in'
                          ? b.cashReceived === null
                            ? t('desk.exact')
                            : rs(b.cashReceived)
                          : '—'}
                      </td>
                      <td className="px-3.5 py-1.5 text-end">
                        {b.kind === 'in' && b.changeDue !== null ? rs(b.changeDue) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            ))}
          </table>
        )}
      </Panel>

      <KeyBar title={t('keys.desk')} hints={hints} />

      {dialog?.kind === 'open' && (
        <EntryDialog
          title={t('desk.open.title')}
          description={t('desk.open.help')}
          label={t('desk.open.label')}
          initial="0"
          actionLabel={t('desk.open.action')}
          onSubmit={(value) => {
            let float: Money;
            try {
              float = parseWholeAmount(value, fmt.minorUnits);
            } catch {
              return t('handover.invalid_float');
            }
            setDialog(null);
            void openSession(float);
            return null;
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'close' && open && (
        <ConfirmDialog
          title={t('desk.close.title')}
          body={t('desk.close.body', { amount: rs(open.expected) })}
          actionLabel={t('desk.close.action')}
          onConfirm={() => {
            setDialog(null);
            void closeSession();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'correct' && (
        <EntryDialog
          title={t('desk.correct.title', { number: dialog.bill.number })}
          description={t('desk.correct.help')}
          label={t('desk.correct.label')}
          facts={[[t('desk.col.due'), rs(dialog.bill.amount)]]}
          initial={plainAmount(dialog.bill.cashReceived ?? dialog.bill.amount, fmt.minorUnits)}
          actionLabel={t('desk.correct.action')}
          onSubmit={(value) => {
            let received: Money;
            try {
              received = parseWholeAmount(value, fmt.minorUnits);
            } catch {
              return t('handover.received_not_rounded');
            }
            if (received < dialog.bill.amount) return t('handover.received_short');
            const bill = dialog.bill;
            setDialog(null);
            void record(bill.number, {
              cashReceived: received,
              code: null,
              method: scanned === bill.number ? 'scan' : 'queue',
            });
            return null;
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'unknown' && (
        <ConfirmDialog
          title={t('desk.unknown.title', { number: dialog.number })}
          body={t('desk.unknown.body', { amount: rs(Math.abs(dialog.cashDue)) })}
          actionLabel={
            dialog.cashDue < 0
              ? t('desk.unknown.payoutAction', { amount: rs(Math.abs(dialog.cashDue)) })
              : t('desk.unknown.action', { amount: rs(dialog.cashDue) })
          }
          onConfirm={() => {
            const { number, cashDue } = dialog;
            setDialog(null);
            void record(number, { cashReceived: null, code: { cashDue }, method: 'scan' });
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

function Figure({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <span className="flex flex-col leading-tight">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={strong ? 'text-lg font-bold' : 'font-semibold'}>{value}</span>
    </span>
  );
}
