import { Button, cn } from '@shared/ui';
import type { JSX } from 'react';
import { useMemo, useState } from 'react';

import { useT } from '../i18n';
import { splitOntoTable } from '../domain/split-destination';
import { transferTargets } from '../domain/table-transfer';
import { cycleSplitQuantity, splitPreview } from '../domain/split';
import { clampSplitAmount, evenSplitAmounts } from '../domain/split-order';
import { computeTotals } from '../domain/totals';
import { getCatalog } from '../data/catalog';
import { useMoney, useOrder, useOrderLines, useOrderPayments } from '../hooks/use-register';
import { useOrderStore } from '../state/order-store';
import { useUiStore } from '../state/ui-store';

/**
 * Split bill (RST-100 … RST-106).
 *
 * Tapping a line cycles the quantity 0 → 1 → … → max → 0, which is the fastest possible gesture for
 * "two of these go on the other bill" and needs no numpad. Combos move whole. The running total of
 * the new bill is computed with the real tax engine, not by summing line prices, so the number the
 * customer is told matches the receipt they get.
 *
 * The confirm button disables itself while the split runs — RST-106 exists because a double-tap
 * here duplicates revenue.
 *
 * **Three modes, two mechanisms.** Splitting by item moves lines onto a new order, because "she had
 * the fish" is a real second bill with its own correctly taxed contents. Splitting evenly or by a
 * fixed amount moves no lines at all — there is nothing to move when four people halve a table — and
 * is taken as **successive payments against the one order** (RST-104, RST-105). Manufacturing four
 * orders would mean inventing lines at a blended tax rate, which stops being arithmetic and starts
 * being a false VAT return the moment a bill mixes food and drink.
 *
 * That choice is what makes "keep splitting" free: the remainder is not a new document to find, it
 * is this order's outstanding balance.
 */

type SplitMode = 'items' | 'evenly' | 'amount';

export function SplitScreen({
    orderUuid,
    onDone,
    onCancel,
}: {
    orderUuid: string;
    onDone: (splitUuid: string) => void;
    onCancel: () => void;
}): JSX.Element {
    const t = useT();
    const money = useMoney();
    const order = useOrder(orderUuid);
    const lines = useOrderLines(orderUuid);
    const payments = useOrderPayments(orderUuid);
    const selection = useUiStore((state) => state.splitSelection);
    const setSplitQuantity = useUiStore((state) => state.setSplitQuantity);
    const resetSplit = useUiStore((state) => state.resetSplit);
    const setSplitTender = useUiStore((state) => state.setSplitTender);
    const [busy, setBusy] = useState(false);
    const [destination, setDestination] = useState<number | null>(null);
    const [seatingError, setSeatingError] = useState<string | null>(null);
    const [mode, setMode] = useState<SplitMode>('items');
    const [ways, setWays] = useState(2);
    const [amount, setAmount] = useState('');

    const preview = useMemo(() => splitPreview(lines, selection), [lines, selection]);

    const movedTotal = useMemo(() => {
        if (!order) return '0';
        const virtual = preview.moved.map((part) => ({ ...part.line, quantity: part.quantity }));
        return computeTotals(order, virtual, [], getCatalog()).roundedTotal;
    }, [order, preview.moved]);

    const remainingTotal = useMemo(() => {
        if (!order) return '0';
        const virtual = preview.remaining.map((part) => ({ ...part.line, quantity: part.quantity }));
        return computeTotals(order, virtual, payments, getCatalog()).roundedTotal;
    }, [order, payments, preview.remaining]);

    // What the bill still owes — the figure both money modes divide, and the one the loop ends on.
    const outstanding = useMemo(() => {
        if (!order) return '0.00';

        return computeTotals(order, lines, payments, getCatalog()).due;
    }, [lines, order, payments]);

    const shares = useMemo(() => evenSplitAmounts(outstanding, Math.max(1, ways)), [outstanding, ways]);

    // Where the new bill can go (RST-106). The same list the ticket screen's move picker is built
    // from, so a table that is occupied reads as a merge in both places rather than two vocabularies
    // for one rule. `orderUuid` stands in for the split that does not exist yet: it excludes the
    // parent's own table, which is the one seat the new bill cannot take.
    const orders = useOrderStore((state) => state.orders);
    const drafts = useMemo(
        () => Object.values(orders ?? {}).filter((candidate) => candidate.state === 'draft'),
        [orders],
    );
    const targets = useMemo(
        () => transferTargets(getCatalog().tables, drafts, orderUuid),
        [drafts, orderUuid],
    );

    if (!order) return <p className="p-6">{t('reg.tickets.none')}</p>;

    const commitSplit = async (): Promise<void> => {
        setBusy(true);
        setSeatingError(null);

        const outcome = await splitOntoTable(orderUuid, selection, destination, drafts);

        setBusy(false);

        if (!outcome) return;

        if (outcome.seatingError !== null) {
            // The split happened; only the seating did not. Kept on screen rather than navigating
            // away, because the waiter needs to know the bill is floating before they walk off.
            setSeatingError(outcome.seatingError === 'offline' ? t('reg.split.seatOffline') : t('reg.split.seatFailed'));
            return;
        }

        resetSplit();
        setDestination(null);
        onDone(outcome.orderUuid);
    };

    /** Hand the payment screen one share and let it collect; the rest is the ordinary payment flow. */
    const takeMoneySplit = (share: string): void => {
        setSplitTender({ orderUuid, amount: clampSplitAmount(share, outstanding) });
        onDone(orderUuid);
    };

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
            <header className="flex flex-wrap items-center gap-3">
                <h1 className="text-xl font-bold">{t('reg.split.title')}</h1>

                <div className="flex gap-1" role="tablist" aria-label={t('reg.split.title')}>
                    {(['items', 'evenly', 'amount'] as const).map((candidate) => (
                        <button
                            key={candidate}
                            type="button"
                            role="tab"
                            aria-selected={mode === candidate}
                            data-testid={`split-mode-${candidate}`}
                            onClick={() => setMode(candidate)}
                            className={cn(
                                'min-h-touch rounded-pos px-3 font-semibold ring-1 ring-inset',
                                mode === candidate ? 'bg-brand-600 text-white ring-brand-700' : 'bg-white ring-slate-300',
                            )}
                        >
                            {t(
                                candidate === 'items'
                                    ? 'reg.split.byQuantity'
                                    : candidate === 'evenly'
                                      ? 'reg.split.evenly'
                                      : 'reg.split.byAmount',
                            )}
                        </button>
                    ))}
                </div>
            </header>

            {mode === 'evenly' ? (
                <section className="flex flex-col gap-3 rounded-pos bg-slate-50 p-3" data-testid="split-evenly">
                    <label className="flex items-center gap-3">
                        <span className="font-semibold">{t('reg.split.ways')}</span>
                        <input
                            type="number"
                            min={1}
                            max={99}
                            value={ways}
                            className="min-h-touch w-24 rounded-pos border border-slate-300 px-2 tabular-nums"
                            onChange={(event) => {
                                const next = Number(event.target.value);
                                setWays(Number.isInteger(next) && next >= 1 ? Math.min(next, 99) : 1);
                            }}
                        />
                        <span className="text-slate-600">{t('reg.split.of', { total: money(outstanding) })}</span>
                    </label>

                    {/* Every share is offered, not just the first: the shares differ by a cent when
                        the total does not divide evenly, and the waiter collects them in whatever
                        order the table hands over the cards. */}
                    <div className="flex flex-wrap gap-2">
                        {shares.map((share, index) => (
                            <Button
                                key={`${share}-${index}`}
                                variant="secondary"
                                data-testid={`split-share-${index}`}
                                onClick={() => takeMoneySplit(share)}
                            >
                                {money(share)}
                            </Button>
                        ))}
                    </div>
                </section>
            ) : null}

            {mode === 'amount' ? (
                <section className="flex flex-col gap-3 rounded-pos bg-slate-50 p-3" data-testid="split-amount">
                    <label className="flex items-center gap-3">
                        <span className="font-semibold">{t('reg.split.amount')}</span>
                        <input
                            inputMode="decimal"
                            value={amount}
                            className="min-h-touch w-40 rounded-pos border border-slate-300 px-2 tabular-nums"
                            onChange={(event) => setAmount(event.target.value.replace(/[^0-9.,]/g, '').replace(',', '.'))}
                        />
                        <span className="text-slate-600">{t('reg.split.of', { total: money(outstanding) })}</span>
                    </label>

                    <Button
                        size="lg"
                        data-testid="split-amount-take"
                        disabled={clampSplitAmount(amount === '' ? '0' : amount, outstanding) === '0.00'}
                        onClick={() => takeMoneySplit(amount === '' ? '0' : amount)}
                    >
                        {t('reg.split.take')}
                    </Button>
                </section>
            ) : null}

            {mode === 'items' ? (
            <ul className="min-h-0 flex-1 overflow-auto divide-y divide-slate-200">
                {lines.map((line) => {
                    const taken = selection[line.uuid] ?? 0;
                    const max = Math.abs(line.quantity);
                    const isChild = line.combo_parent_uuid !== null;
                    return (
                        <li key={line.uuid}>
                            <button
                                type="button"
                                disabled={isChild}
                                onClick={() => setSplitQuantity(line.uuid, cycleSplitQuantity(taken, max))}
                                className={cn(
                                    'flex w-full items-center gap-3 p-3 text-start',
                                    taken > 0 && 'bg-brand-50',
                                    isChild && 'ps-8 opacity-70',
                                )}
                            >
                                <span className="min-w-0 flex-1 truncate font-semibold">
                                    {line.full_product_name}
                                </span>
                                <span className="tabular-nums text-lg">
                                    {taken} / {line.quantity}
                                </span>
                            </button>
                        </li>
                    );
                })}
            </ul>
            ) : null}

            <footer className={cn('grid grid-cols-2 gap-3', mode !== 'items' && 'mt-auto')}>
                {/* RST-106 — four guests moving to the bar, while the rest of the table eats on.
                    Absent on a counter sale, which has no table to move away from. */}
                {order.restaurant_table_id !== null ? (
                    <label className="flex flex-col gap-1">
                        <span className="text-sm text-slate-600">{t('reg.split.destination')}</span>
                        <select
                            className="min-h-touch rounded-pos border border-slate-300 bg-white px-2"
                            data-testid="split-destination"
                            value={destination ?? ''}
                            onChange={(event) =>
                                setDestination(event.target.value === '' ? null : Number(event.target.value))
                            }
                        >
                            <option value="">{t('reg.split.stayFloating')}</option>
                            {targets.map((target) => (
                                <option key={target.tableId} value={target.tableId}>
                                    {target.occupiedByUuid
                                        ? t('reg.split.tableOccupied', { number: target.label.replace('T ', '') })
                                        : target.label}
                                </option>
                            ))}
                        </select>
                    </label>
                ) : null}

                {seatingError !== null ? (
                    <p className="rounded-pos bg-warn-soft p-2 text-sm font-semibold text-warn-fg" data-testid="split-seat-error">
                        {seatingError}
                    </p>
                ) : null}

                <div className="rounded-pos bg-slate-100 p-3">
                    <p className="text-sm text-slate-600">{t('reg.split.original')}</p>
                    <p className="text-xl font-bold tabular-nums">{money(remainingTotal)}</p>
                </div>
                <div className="rounded-pos bg-brand-50 p-3">
                    <p className="text-sm text-slate-600">{t('reg.split.newBill')}</p>
                    <p className="text-xl font-bold tabular-nums">{money(movedTotal)}</p>
                </div>

                <Button
                    variant="ghost"
                    onClick={() => {
                        resetSplit();
                        onCancel();
                    }}
                >
                    {t('common.cancel')}
                </Button>
                <Button
                    size="xl"
                    loading={busy}
                    disabled={preview.movedCount === 0 || busy}
                    onClick={() => void commitSplit()}
                >
                    {t('reg.split.confirm')}
                </Button>
            </footer>
        </div>
    );
}
