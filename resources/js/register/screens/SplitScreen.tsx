import { Button, cn } from '@shared/ui';
import type { JSX } from 'react';
import { useMemo, useState } from 'react';

import { useT } from '../i18n';
import { splitOrder } from '../domain/order-actions';
import { cycleSplitQuantity, splitPreview } from '../domain/split';
import { computeTotals } from '../domain/totals';
import { getCatalog } from '../data/catalog';
import { useMoney, useOrder, useOrderLines, useOrderPayments } from '../hooks/use-register';
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
 */

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
    const [busy, setBusy] = useState(false);

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

    if (!order) return <p className="p-6">{t('reg.tickets.none')}</p>;

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
            <header className="flex items-center gap-3">
                <h1 className="text-xl font-bold">{t('reg.split.title')}</h1>
                <p className="text-sm text-slate-500">{t('reg.split.byQuantity')}</p>
            </header>

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

            <footer className="grid grid-cols-2 gap-3">
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
                    onClick={async () => {
                        setBusy(true);
                        const splitUuid = await splitOrder(orderUuid, selection);
                        resetSplit();
                        setBusy(false);
                        if (splitUuid) onDone(splitUuid);
                    }}
                >
                    {t('reg.split.confirm')}
                </Button>
            </footer>
        </div>
    );
}
