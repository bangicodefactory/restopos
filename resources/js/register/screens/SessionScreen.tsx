import { Decimal } from '@domain/money/decimal';
import { useCan, useSessionStore } from '@shared/auth';
import { Button, Spinner, cn } from '@shared/ui';
import type { JSX } from 'react';
import { useEffect, useMemo, useState } from 'react';

import { useT } from '../i18n';
import { requestApproval, type ApprovalGrant } from '../domain/approval';
import {
    closeSession,
    confirmOpeningControl,
    fetchClosingData,
    fetchCurrentSession,
    openSession,
    openingFloatFor,
} from '../domain/session-actions';
import { useCatalog, useMoney } from '../hooks/use-register';
import { draftOrders, useOrderStore } from '../state/order-store';
import { usePosSessionStore, countTotal, type DenominationCount } from '../state/session-store';

/**
 * Session open / close with cash control (REG-003 … REG-018).
 *
 * The denomination counter is the same control on both ends of the shift, and blank rows count as
 * zero so a partial count is legal — cashiers routinely count the notes, eyeball the coins and move
 * on, and a grid that demands every row gets filled with garbage.
 *
 * Closing figures come from the server (REG-014): expected cash is derived from synced orders, and
 * two devices computing it from their own replicas would disagree. Hence the explicit offline
 * message instead of a plausible-looking local guess.
 */

type Mode = 'open' | 'close';

export function SessionScreen({ mode, onDone }: { mode: Mode; onDone: () => void }): JSX.Element {
    return mode === 'open' ? <OpenPane onDone={onDone} /> : <ClosePane onDone={onDone} />;
}

function useDenominations(): [DenominationCount[], (index: number, quantity: number) => void, number] {
    const catalog = useCatalog();
    const [counts, setCounts] = useState<DenominationCount[]>(() =>
        catalog.bills.map((bill) => ({
            pos_bill_id: bill.id,
            denomination_value: bill.value,
            quantity: 0,
        })),
    );

    const update = (index: number, quantity: number): void =>
        setCounts((current) =>
            current.map((row, position) =>
                position === index ? { ...row, quantity: Math.max(0, quantity) } : row,
            ),
        );

    return [counts, update, countTotal(counts)];
}

function DenominationGrid({
    counts,
    onChange,
    total,
}: {
    counts: DenominationCount[];
    onChange: (index: number, quantity: number) => void;
    total: number;
}): JSX.Element {
    const t = useT();
    const money = useMoney();

    return (
        <div>
            <table className="w-full text-base">
                <thead>
                    <tr className="text-left text-sm text-slate-500">
                        <th className="py-1">{t('reg.session.denomination')}</th>
                        <th className="py-1">{t('reg.session.count')}</th>
                        <th className="py-1 text-right">{t('reg.session.subtotal')}</th>
                    </tr>
                </thead>
                <tbody>
                    {counts.map((row, index) => (
                        <tr key={row.pos_bill_id} className="border-t border-slate-100">
                            <td className="py-1 font-semibold tabular-nums">{money(row.denomination_value)}</td>
                            <td className="py-1">
                                <input
                                    type="number"
                                    min={0}
                                    inputMode="numeric"
                                    className="min-h-touch w-24 rounded-pos border border-slate-300 px-2 text-right"
                                    value={row.quantity === 0 ? '' : row.quantity}
                                    onChange={(event) =>
                                        onChange(index, Number.parseInt(event.target.value || '0', 10))
                                    }
                                />
                            </td>
                            <td className="py-1 text-right tabular-nums">
                                {money((Number.parseFloat(row.denomination_value) * row.quantity).toFixed(2))}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>

            <p className="mt-2 flex justify-between text-lg font-bold">
                <span>{t('reg.session.countedTotal')}</span>
                <span className="tabular-nums">{money(total.toFixed(2))}</span>
            </p>
        </div>
    );
}

function OpenPane({ onDone }: { onDone: () => void }): JSX.Element {
    const t = useT();
    const money = useMoney();
    const catalog = useCatalog();
    const cashier = useSessionStore((state) => state.cashier);
    const session = usePosSessionStore((state) => state.session);
    const opening = usePosSessionStore((state) => state.opening);
    const busy = usePosSessionStore((state) => state.busy);
    const error = usePosSessionStore((state) => state.error);
    const [counts, update, total] = useDenominations();
    const [notes, setNotes] = useState('');

    useEffect(() => {
        void fetchCurrentSession();
    }, []);

    const cashControl = catalog.config?.cash_control === true;
    const expected = Decimal.of(opening?.expected_float ?? '0');
    const float = openingFloatFor({ cashControl, countedTotal: total, expectedFloat: opening?.expected_float ?? null });
    const difference = Decimal.of(total.toFixed(2)).sub(expected);

    const problems = opening?.problems ?? [];
    const blocked = problems.length > 0;

    if (session && session.state === 'opened') {
        return (
            <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-4 p-6">
                <h1 className="text-2xl font-bold">{t('reg.session.resume')}</h1>
                <p className="text-slate-600">{t('reg.session.resumeHint')}</p>
                <p className="text-lg">
                    {session.name ?? `#${session.id}`} · {money(session.opening_float)}
                </p>
                <Button size="xl" block onClick={onDone}>
                    {t('reg.session.resume')}
                </Button>
            </main>
        );
    }

    return (
        <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-4 p-6">
            <h1 className="text-2xl font-bold">{t('reg.session.openTitle')}</h1>

            {/* Named before anything else on the screen: counting a drawer into an open that will be
                refused is the exact waste this ticket exists to stop. */}
            {blocked ? (
                <section className="rounded-pos bg-danger-soft p-3 text-danger-fg">
                    <h2 className="font-semibold">{t('reg.session.notReady')}</h2>
                    <ul className="mt-1 list-disc pl-5">
                        {problems.map((problem) => (
                            <li key={problem.code}>{problem.message}</li>
                        ))}
                    </ul>
                </section>
            ) : null}

            {cashControl ? (
                <>
                    <DenominationGrid counts={counts} onChange={update} total={total} />
                    <dl className="rounded-pos bg-slate-50 p-3 text-lg">
                        <div className="flex justify-between">
                            <dt>{t('reg.session.expectedFloat')}</dt>
                            <dd className="tabular-nums">{money(expected.withScale(2).toString())}</dd>
                        </div>
                        {/* Shown only once something has been counted: a difference against an empty
                            grid is the whole float, which reads as an alarm before anyone has begun. */}
                        {total > 0 && !difference.isZero() ? (
                            <div
                                className={cn(
                                    'mt-1 flex justify-between border-t border-slate-200 pt-1 font-bold',
                                    difference.signum() > 0 ? 'text-ok' : 'text-danger',
                                )}
                            >
                                <dt>{t('reg.session.difference')}</dt>
                                <dd className="tabular-nums">{money(difference.withScale(2).toString())}</dd>
                            </div>
                        ) : null}
                    </dl>
                </>
            ) : (
                <p className="text-slate-600">
                    {t('reg.session.openingFloat')}: {money(float)}
                </p>
            )}

            <label className="grid gap-1">
                <span className="font-semibold">{t('reg.session.notes')}</span>
                <textarea
                    rows={2}
                    className="rounded-pos border border-slate-300 p-2"
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                />
            </label>

            {error ? <p className="text-danger">{error}</p> : null}

            <Button
                size="xl"
                block
                loading={busy}
                disabled={blocked}
                onClick={async () => {
                    const created =
                        session ??
                        (await openSession({
                            openingFloat: float,
                            employeeId: cashier?.employee_id ?? null,
                            notes,
                            denominations: counts.filter((row) => row.quantity > 0),
                        }));
                    if (!created) return;
                    if (created.state === 'opening_control') {
                        await confirmOpeningControl(created.id, float, cashier?.employee_id ?? null);
                    }
                    onDone();
                }}
            >
                {t('reg.session.open')}
            </Button>
        </main>
    );
}

function ClosePane({ onDone }: { onDone: () => void }): JSX.Element {
    const t = useT();
    const money = useMoney();
    const can = useCan();
    const cashier = useSessionStore((state) => state.cashier);
    const session = usePosSessionStore((state) => state.session);
    const closingData = usePosSessionStore((state) => state.closingData);
    const busy = usePosSessionStore((state) => state.busy);
    const error = usePosSessionStore((state) => state.error);
    const orders = useOrderStore((state) => state.orders);

    const [counts, update, total] = useDenominations();
    const [byMethod, setByMethod] = useState<Record<number, string>>({});
    const [force, setForce] = useState(false);

    useEffect(() => {
        if (session) void fetchClosingData(session.id);
    }, [session]);

    const drafts = useMemo(() => (orders ? draftOrders(useOrderStore.getState()).length : 0), [orders]);

    if (!session) {
        return (
            <main className="p-6">
                <p>{t('reg.session.none')}</p>
                <Button onClick={onDone}>{t('common.back')}</Button>
            </main>
        );
    }

    if (!closingData) {
        return (
            <main className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6">
                {busy ? <Spinner size="lg" /> : <p className="text-warn-fg">{t('reg.session.offlineClose')}</p>}
                <Button variant="secondary" onClick={() => void fetchClosingData(session.id)}>
                    {t('common.retry')}
                </Button>
                <Button variant="ghost" onClick={onDone}>
                    {t('common.back')}
                </Button>
            </main>
        );
    }

    const expected = Decimal.of(closingData.expected_cash);
    const difference = Decimal.of(total.toFixed(2)).sub(expected);
    const authorized = Decimal.of(closingData.amount_authorized_diff || '0');
    const overVariance =
        closingData.enforces_maximum_difference && difference.abs().gt(authorized) && !can('session.close.over_variance');

    return (
        <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-4 overflow-auto p-6">
            <h1 className="text-2xl font-bold">{t('reg.session.closeTitle')}</h1>

            <DenominationGrid counts={counts} onChange={update} total={total} />

            <dl className="rounded-pos bg-slate-50 p-3 text-lg">
                <div className="flex justify-between">
                    <dt>{t('reg.session.expected')}</dt>
                    <dd className="tabular-nums">{money(closingData.expected_cash)}</dd>
                </div>
                <div className="flex justify-between">
                    <dt>{t('reg.session.counted')}</dt>
                    <dd className="tabular-nums">{money(total.toFixed(2))}</dd>
                </div>
                <div
                    className={cn(
                        'mt-1 flex justify-between border-t border-slate-200 pt-1 font-bold',
                        difference.isZero() ? '' : difference.signum() > 0 ? 'text-ok' : 'text-danger',
                    )}
                >
                    <dt>{t('reg.session.difference')}</dt>
                    <dd className="tabular-nums">{money(difference.withScale(2).toString())}</dd>
                </div>
            </dl>

            <section>
                <h2 className="mb-2 font-semibold">{t('reg.pay.methods')}</h2>
                <ul className="space-y-2">
                    {closingData.payment_totals
                        .filter((row) => !row.is_cash_count)
                        .map((row) => (
                            <li key={row.payment_method_id} className="flex items-center gap-2">
                                <span className="flex-1">{row.name}</span>
                                <span className="tabular-nums text-slate-500">{money(row.expected_amount)}</span>
                                <input
                                    type="text"
                                    inputMode="decimal"
                                    className="min-h-touch w-28 rounded-pos border border-slate-300 px-2 text-right"
                                    value={byMethod[row.payment_method_id] ?? row.expected_amount}
                                    onChange={(event) =>
                                        setByMethod((current) => ({
                                            ...current,
                                            [row.payment_method_id]: event.target.value,
                                        }))
                                    }
                                />
                            </li>
                        ))}
                </ul>
            </section>

            {drafts > 0 ? (
                <label className="flex items-center gap-2 rounded-pos bg-warn-soft p-3 text-warn-fg">
                    <input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} />
                    <span>
                        {t('reg.session.closeBlockedDrafts', { count: drafts })} — {t('reg.session.forceClose')}
                    </span>
                </label>
            ) : null}

            {overVariance ? <p className="text-warn-fg">{t('reg.session.overVariance')}</p> : null}
            {error ? <p className="text-danger">{error}</p> : null}

            <div className="flex gap-2">
                <Button variant="ghost" onClick={onDone}>
                    {t('common.back')}
                </Button>
                <Button
                    size="xl"
                    className="flex-1"
                    loading={busy}
                    disabled={drafts > 0 && !force}
                    onClick={async () => {
                        let grant: ApprovalGrant | null = null;
                        if (overVariance) {
                            grant = await requestApproval('session.close.over_variance');
                            if (!grant) return;
                        }
                        const result = await closeSession({
                            sessionId: session.id,
                            countedCash: total.toFixed(2),
                            countedByMethod: Object.fromEntries(
                                closingData.payment_totals.map((row) => [
                                    row.payment_method_id,
                                    byMethod[row.payment_method_id] ?? row.expected_amount,
                                ]),
                            ),
                            denominations: counts.filter((row) => row.quantity > 0),
                            employeeId: cashier?.employee_id ?? null,
                            // Pass the approving manager's credentials so the server can verify the
                            // over-variance approval and record who authorised it (REG-016).
                            managerEmployeeId: grant?.managerEmployeeId ?? null,
                            managerPin: grant?.pin ?? null,
                            force,
                        });
                        if (result.ok) onDone();
                    }}
                >
                    {t('reg.session.close')}
                </Button>
            </div>
        </main>
    );
}
