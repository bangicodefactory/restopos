import type { OrderRow } from '@domain/types';
import { Button, cn } from '@shared/ui';
import type { JSX } from 'react';
import { useMemo, useState } from 'react';

import { getCatalog } from '../data/catalog';
import { useT } from '../i18n';
import { setTip } from '../domain/order-actions';
import {
    needsTipConfirmation,
    parseTip,
    settlementRows,
    settlementTotal,
    TIP_PRESETS,
    tipFromPercent,
    tipPercentOf,
} from '../domain/tip-entry';
import { orderTotals } from '../domain/totals';
import { useMoney } from '../hooks/use-register';
import { useOrderStore } from '../state/order-store';

/**
 * Tips (RST-123, RST-127).
 *
 * Two jobs on one screen, because they are the same job at different moments. **One order** is the
 * card slip that has just come back signed. **The shift** is the stack of them at the end of
 * service, and settling those one receipt at a time means finding each order first — the grid turns
 * that into type, type, type.
 *
 * A tip above a quarter of the bill is confirmed before it is applied. That guard exists because of
 * how the number arrives: read off a signed slip, often by someone who did not take the payment, so
 * the realistic mistake is a decimal point rather than fraud. `18.00` on a `12.10` bill balances
 * perfectly — the tender is topped up, the order reconciles, and nothing downstream can tell it was
 * wrong. This is the last place it can be caught.
 */

export function TipScreen({
    orderUuid,
    onDone,
}: {
    /** The order just settled, when the waiter arrived here from a payment. Absent for a shift pass. */
    orderUuid?: string | null;
    onDone: () => void;
}): JSX.Element {
    const t = useT();
    const money = useMoney();
    const orders = useOrderStore((state) => state.orders);
    const config = getCatalog().config;

    const [mode, setMode] = useState<'one' | 'shift'>(orderUuid ? 'one' : 'shift');

    if (config?.enable_tips !== true) {
        return <p className="p-6 text-slate-600">{t('reg.tip.disabled')}</p>;
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-3" data-testid="tip-screen">
            <header className="flex flex-wrap items-center gap-3">
                <h1 className="text-xl font-bold">{t('reg.tip.title')}</h1>

                <div className="flex gap-1" role="tablist" aria-label={t('reg.tip.title')}>
                    {(['one', 'shift'] as const).map((candidate) => (
                        <button
                            key={candidate}
                            type="button"
                            role="tab"
                            aria-selected={mode === candidate}
                            // Nothing to show for a single order when none was handed in.
                            disabled={candidate === 'one' && !orderUuid}
                            data-testid={`tip-mode-${candidate}`}
                            onClick={() => setMode(candidate)}
                            className={cn(
                                'min-h-touch rounded-pos px-3 font-semibold ring-1 ring-inset disabled:opacity-40',
                                mode === candidate ? 'bg-brand-600 text-white ring-brand-700' : 'bg-white ring-slate-300',
                            )}
                        >
                            {t(candidate === 'one' ? 'reg.tip.thisOrder' : 'reg.tip.thisShift')}
                        </button>
                    ))}
                </div>

                <Button className="ms-auto" variant="secondary" onClick={onDone}>
                    {t('common.close')}
                </Button>
            </header>

            {mode === 'one' && orderUuid ? (
                <SingleTip orderUuid={orderUuid} onApplied={onDone} />
            ) : (
                <ShiftGrid orders={Object.values(orders ?? {})} money={money} />
            )}
        </div>
    );
}

/** One order, one slip (RST-123). */
function SingleTip({ orderUuid, onApplied }: { orderUuid: string; onApplied: () => void }): JSX.Element {
    const t = useT();
    const money = useMoney();
    const [amount, setAmount] = useState('');
    const [confirming, setConfirming] = useState(false);

    const total = orderTotals(orderUuid).roundedTotal;
    const parsed = parseTip(amount);
    const oversized = parsed !== null && needsTipConfirmation(total, parsed);

    const apply = (value: string): void => {
        setTip(orderUuid, value);
        setAmount('');
        setConfirming(false);
        onApplied();
    };

    return (
        <div className="flex flex-col gap-3">
            <p className="text-slate-600">
                {t('reg.tip.billTotal')} <span className="font-bold tabular-nums">{money(total)}</span>
            </p>

            <div className="flex flex-wrap gap-2">
                {TIP_PRESETS.map((percent) => (
                    <Button
                        key={percent}
                        size="lg"
                        variant="secondary"
                        data-testid={`tip-preset-${percent}`}
                        onClick={() => setAmount(tipFromPercent(total, percent))}
                    >
                        {percent} % · {money(tipFromPercent(total, percent))}
                    </Button>
                ))}
            </div>

            <label className="flex flex-col gap-1">
                <span className="text-sm text-slate-600">{t('reg.tip.custom')}</span>
                <input
                    type="text"
                    inputMode="decimal"
                    data-testid="tip-amount"
                    className="min-h-touch-lg rounded-pos border border-slate-300 px-3 text-right text-xl tabular-nums"
                    value={amount}
                    onChange={(event) => {
                        setAmount(event.target.value);
                        setConfirming(false);
                    }}
                />
            </label>

            {parsed !== null ? (
                <p className={cn('text-sm', oversized ? 'font-semibold text-warn-fg' : 'text-slate-600')}>
                    {t('reg.tip.percentOfBill', { percent: tipPercentOf(total, parsed) })}
                </p>
            ) : null}

            {confirming ? (
                <div className="rounded-pos bg-warn-soft p-3" data-testid="tip-confirm">
                    <p className="font-semibold text-warn-fg">
                        {t('reg.tip.confirmLarge', {
                            amount: money(parsed ?? '0'),
                            percent: tipPercentOf(total, parsed ?? '0'),
                        })}
                    </p>
                    <div className="mt-2 flex gap-2">
                        <Button data-testid="tip-confirm-yes" onClick={() => apply(parsed ?? '0')}>
                            {t('reg.tip.confirmYes')}
                        </Button>
                        <Button variant="secondary" onClick={() => setConfirming(false)}>
                            {t('common.cancel')}
                        </Button>
                    </div>
                </div>
            ) : null}

            <Button
                size="xl"
                data-testid="tip-apply"
                disabled={parsed === null || confirming}
                onClick={() => {
                    if (parsed === null) return;
                    // Confirmed rather than refused: a large tip is unusual, not impossible, and a
                    // till that simply says no leaves the waiter with a signed slip and no way to
                    // honour it.
                    if (oversized) {
                        setConfirming(true);
                        return;
                    }
                    apply(parsed);
                }}
            >
                {t('reg.tip.apply')} · {money(parsed ?? '0')}
            </Button>
        </div>
    );
}

/**
 * The whole shift in one pass (RST-127).
 *
 * Each row is applied on its own, as it is typed, rather than collected and written at the end. A
 * manager working through a stack of slips gets interrupted, and a batch that is lost on the way out
 * of the screen is worse than one that was never started.
 */
function ShiftGrid({
    orders,
    money,
}: {
    orders: readonly OrderRow[];
    money: (value: string) => string;
}): JSX.Element {
    const t = useT();
    const [entries, setEntries] = useState<Record<string, string>>({});
    const [confirming, setConfirming] = useState<string | null>(null);

    const rows = useMemo(() => settlementRows(orders, (uuid) => orderTotals(uuid).roundedTotal), [orders]);
    const running = settlementTotal(entries);

    const commit = (orderUuid: string, total: string): void => {
        const parsed = parseTip(entries[orderUuid] ?? '');
        if (parsed === null) return;

        if (needsTipConfirmation(total, parsed) && confirming !== orderUuid) {
            setConfirming(orderUuid);
            return;
        }

        setTip(orderUuid, parsed);
        setConfirming(null);
        setEntries((current) => {
            const next = { ...current };
            delete next[orderUuid];
            return next;
        });
    };

    if (rows.length === 0) {
        return <p className="p-6 text-slate-600" data-testid="tip-grid-empty">{t('reg.tip.nothingToSettle')}</p>;
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
            <p className="text-sm text-slate-600">
                {t('reg.tip.gridRunning')} <span className="font-bold tabular-nums">{money(running)}</span>
            </p>

            <div className="min-h-0 flex-1 overflow-auto" data-testid="tip-grid">
                <table className="w-full text-start">
                    <thead className="sticky top-0 bg-slate-100 text-sm text-slate-600">
                        <tr>
                            <th className="p-2 text-start">{t('reg.tip.order')}</th>
                            <th className="p-2 text-end">{t('reg.tip.billTotal')}</th>
                            <th className="p-2 text-end">{t('reg.tickets.tipAmount')}</th>
                            <th className="p-2" />
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((row) => (
                            <tr key={row.orderUuid} data-testid="tip-grid-row" data-order={row.orderUuid}>
                                <td className="p-2 font-semibold">{row.label}</td>
                                <td className="p-2 text-end tabular-nums">{money(row.total)}</td>
                                <td className="p-2 text-end">
                                    <input
                                        type="text"
                                        inputMode="decimal"
                                        aria-label={`${t('reg.tickets.tipAmount')} ${row.label}`}
                                        className="min-h-touch w-24 rounded-pos border border-slate-300 px-2 text-right tabular-nums"
                                        value={entries[row.orderUuid] ?? ''}
                                        onChange={(event) => {
                                            const value = event.target.value;
                                            setConfirming(null);
                                            setEntries((current) => ({ ...current, [row.orderUuid]: value }));
                                        }}
                                    />
                                </td>
                                <td className="p-2">
                                    <Button
                                        size="sm"
                                        disabled={parseTip(entries[row.orderUuid] ?? '') === null}
                                        onClick={() => commit(row.orderUuid, row.total)}
                                    >
                                        {confirming === row.orderUuid
                                            ? t('reg.tip.confirmYes')
                                            : t('reg.tickets.settleTip')}
                                    </Button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {confirming !== null ? (
                <p className="rounded-pos bg-warn-soft p-2 font-semibold text-warn-fg" data-testid="tip-grid-confirm">
                    {t('reg.tip.confirmRow')}
                </p>
            ) : null}
        </div>
    );
}
