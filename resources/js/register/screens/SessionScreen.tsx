import { Decimal } from '@domain/money/decimal';
import { useCan, useSessionStore } from '@shared/auth';
import { Button, Spinner, cn, sanitizeMoneyInput } from '@shared/ui';
import type { JSX } from 'react';
import { useEffect, useMemo, useState } from 'react';

import { useT } from '../i18n';
import { requestApproval, type ApprovalGrant } from '../domain/approval';
import {
    closeSession,
    confirmOpeningControl,
    deleteCashMovement,
    fetchCashMovements,
    fetchClosingData,
    fetchCurrentSession,
    openSession,
    openingFloatFor,
    printXReport,
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
                refused is the exact waste this ticket exists to stop.

                The retry is not decoration. This pane is a terminal screen — with no session there
                is nowhere else to navigate — and the problems are only read on mount, so without it
                a manager fixes the configuration in the back office and the till goes on refusing
                with no way to ask again short of reloading the browser. */}
            {blocked ? (
                <section className="rounded-pos bg-danger-soft p-3 text-danger-fg">
                    <h2 className="font-semibold">{t('reg.session.notReady')}</h2>
                    <ul className="mt-1 list-disc pl-5">
                        {problems.map((problem) => (
                            <li key={problem.code}>{problem.message}</li>
                        ))}
                    </ul>
                    <Button
                        variant="secondary"
                        className="mt-3"
                        onClick={() => void fetchCurrentSession()}
                    >
                        {t('common.retry')}
                    </Button>
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

/**
 * The drawer ledger, in the pane where the drawer is counted (REG-012).
 *
 * Every movement with its reason and who made it, because "the drawer is 40 short" and "Karim took
 * 40 to the bank at 15:20 and here is the slip" are the same fact told with and without the ledger
 * — and only one of them ends the conversation.
 */
function CashMovementList({ sessionId }: { sessionId: number }): JSX.Element | null {
    const t = useT();
    const money = useMoney();
    const can = useCan();
    const movements = usePosSessionStore((state) => state.movements);
    const busy = usePosSessionStore((state) => state.busy);

    if (movements.length === 0) return null;

    // The ability governs whether the button is *offered*; the server verifies a manager PIN before
    // it acts either way. A cashier who cannot delete should not be shown a button that will refuse
    // them, and a manager should not have to guess that one exists.
    const mayDelete = can('cash.in_out.delete');

    return (
        <section>
            <h2 className="mb-2 font-semibold">{t('reg.session.movements')}</h2>
            <ul data-testid="cash-movements" className="divide-y divide-slate-100 rounded-pos bg-slate-50">
                {movements.map((movement) => {
                    const out = Decimal.of(movement.amount).signum() < 0;

                    return (
                        <li key={movement.uuid} className="flex items-center gap-2 p-2">
                            <div className="min-w-0 flex-1">
                                <p className="truncate">
                                    {movement.reason ?? t(out ? 'reg.session.cashOut' : 'reg.session.cashIn')}
                                </p>
                                <p className="text-sm text-slate-500">
                                    {[movement.employee_name, formatClock(movement.moved_at)]
                                        .filter(Boolean)
                                        .join(' · ')}
                                </p>
                            </div>
                            <span className={cn('tabular-nums font-semibold', out ? 'text-danger' : 'text-ok')}>
                                {money(Decimal.of(movement.amount).withScale(2).toString())}
                            </span>
                            {mayDelete ? (
                                <Button
                                    variant="ghost"
                                    disabled={busy}
                                    onClick={async () => {
                                        const grant = await requestApproval('cash.in_out.delete');
                                        if (!grant) return;
                                        await deleteCashMovement({
                                            sessionId,
                                            movementUuid: movement.uuid,
                                            managerEmployeeId: grant.managerEmployeeId,
                                            managerPin: grant.pin,
                                        });
                                    }}
                                >
                                    {t('reg.session.removeMovement')}
                                </Button>
                            ) : null}
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}

/** `15:20` from an ISO timestamp, or nothing when the server sent none. */
function formatClock(iso: string | null): string {
    if (!iso) return '';
    const at = new Date(iso);

    return Number.isNaN(at.getTime())
        ? ''
        : `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

function ClosePane({ onDone }: { onDone: () => void }): JSX.Element {
    const t = useT();
    const money = useMoney();
    const can = useCan();
    const catalog = useCatalog();
    const cashier = useSessionStore((state) => state.cashier);
    const session = usePosSessionStore((state) => state.session);
    const closingData = usePosSessionStore((state) => state.closingData);
    const busy = usePosSessionStore((state) => state.busy);
    const error = usePosSessionStore((state) => state.error);
    const orders = useOrderStore((state) => state.orders);

    const [counts, update, total] = useDenominations();
    const [byMethod, setByMethod] = useState<Record<number, string>>({});
    const [force, setForce] = useState(false);
    const [notes, setNotes] = useState('');
    const [quarantined, setQuarantined] = useState(0);

    useEffect(() => {
        if (!session) return;
        void fetchClosingData(session.id);
        void fetchCashMovements(session.id);
    }, [session]);

    // The greater of what this till holds and what the server counts. The local store alone misses
    // a draft left open on a sibling till on the same register — the server refuses the close over
    // it, but this pane, seeing none of its own, never offered the force checkbox that is the only
    // way past. Counting both means the refusal is one the cashier can actually answer (BAN-514).
    const drafts = useMemo(
        () =>
            Math.max(
                orders ? draftOrders(useOrderStore.getState()).length : 0,
                closingData?.draft_order_count ?? 0,
            ),
        [orders, closingData?.draft_order_count],
    );

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

            <CashMovementList sessionId={session.id} />

            <section>
                <h2 className="mb-2 font-semibold">{t('reg.pay.methods')}</h2>
                <ul className="space-y-2">
                    {closingData.payment_totals
                        .filter((row) => !row.is_cash_count)
                        .map((row) => (
                            <li key={row.payment_method_id} className="flex items-center gap-2">
                                <span className="flex-1">{row.name}</span>
                                <span className="tabular-nums text-slate-500">{money(row.expected_amount)}</span>
                                {/* Sanitised, not raw: the venue is French-Moroccan and a decimal
                                    keypad here produces `12,50`, which the server refuses outright
                                    since BAN-507 — so an untouched close went through and an edited
                                    one did not. `sanitizeMoneyInput` is what the rest of the app
                                    already uses to make both separators mean the same amount. */}
                                <input
                                    type="text"
                                    inputMode="decimal"
                                    className="min-h-touch w-28 rounded-pos border border-slate-300 px-2 text-right tabular-nums"
                                    value={byMethod[row.payment_method_id] ?? row.expected_amount}
                                    onChange={(event) =>
                                        setByMethod((current) => ({
                                            ...current,
                                            [row.payment_method_id]: sanitizeMoneyInput(
                                                event.target.value,
                                                catalog.currencyFormat.decimalPlaces,
                                            ),
                                        }))
                                    }
                                />
                            </li>
                        ))}
                </ul>
            </section>

            {quarantined > 0 ? (
                <div className="rounded-pos bg-warn-soft p-3 text-warn-fg">
                    <p>{t('reg.session.quarantinedAtClose', { count: quarantined })}</p>
                    <Button variant="secondary" className="mt-2" onClick={onDone}>
                        {t('common.ok')}
                    </Button>
                </div>
            ) : null}

            {/* The server has persisted `closing_notes` all along and nothing ever sent one. It is
                where "till 2 was 5 short, Amina counted it twice" goes — the sentence that stops a
                variance becoming an argument a week later. */}
            <label className="grid gap-1">
                <span className="font-semibold">{t('reg.session.closeNotes')}</span>
                <textarea
                    rows={2}
                    className="rounded-pos border border-slate-300 p-2"
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                />
            </label>

            {drafts > 0 ? (
                <label className="flex items-center gap-2 rounded-pos bg-warn-soft p-3 text-warn-fg">
                    <input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} />
                    <span>
                        {t('reg.session.closeBlockedDrafts', { count: drafts })} — {t('reg.session.forceClose')}
                    </span>
                </label>
            ) : null}

            {overVariance ? <p className="text-warn-fg">{t('reg.session.overVariance')}</p> : null}
            {/* `unsent` is the sentinel `closeSession` returns when the outbox would not drain. It
                is the one refusal a cashier can act on themselves, so it gets a sentence rather
                than a code. */}
            {error ? (
                <p className="text-danger">
                    {error === 'unsent'
                        ? t('reg.session.unsentBlocksClose')
                        : error === 'expected_changed'
                          ? t('reg.session.expectedMoved')
                          : error === 'drafts_arrived'
                            ? t('reg.session.draftsArrived')
                            : error}
                </p>
            ) : null}

            <div className="flex gap-2">
                <Button variant="ghost" onClick={onDone}>
                    {t('common.back')}
                </Button>
                {/* A reading, not a close (REG-020, REG-022). Deliberately not the primary button,
                    and deliberately not disabled by the draft guard: unsettled orders are a reason
                    to look at where the day stands, not a reason to be refused a look. */}
                <Button
                    variant="ghost"
                    loading={busy}
                    onClick={async () => {
                        await printXReport({
                            sessionId: session.id,
                            employeeId: cashier?.employee_id ?? null,
                        });
                    }}
                >
                    {t('reg.session.xReport')}
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
                        setQuarantined(0);

                        const result = await closeSession({
                            sessionId: session.id,
                            countedCash: total.toFixed(2),
                            // What this screen showed while the drawer was counted. If draining the
                            // outbox moves it, the close comes back rather than recording the count
                            // against a number that changed underneath it.
                            expectedCash: closingData.expected_cash,
                            // Likewise for the drafts it showed: draining can sync a queued one,
                            // and the close would then be refused over an order this pane said was
                            // not there.
                            draftOrderCount: closingData.draft_order_count,
                            countedByMethod: Object.fromEntries(
                                closingData.payment_totals.map((row) => [
                                    row.payment_method_id,
                                    byMethod[row.payment_method_id] ?? row.expected_amount,
                                ]),
                            ),
                            denominations: counts.filter((row) => row.quantity > 0),
                            employeeId: cashier?.employee_id ?? null,
                            notes: notes.trim() === '' ? null : notes.trim(),
                            // Pass the approving manager's credentials so the server can verify the
                            // over-variance approval and record who authorised it (REG-016).
                            managerEmployeeId: grant?.managerEmployeeId ?? null,
                            managerPin: grant?.pin ?? null,
                            force,
                        });
                        if (!result.ok) return;

                        // Refused entries never reach the server, so they are not in the summaries
                        // the drawer was just counted against. The close is correct; somebody still
                        // has to be told what is missing from it.
                        if (result.quarantined) {
                            setQuarantined(result.quarantined);

                            return;
                        }

                        onDone();
                    }}
                >
                    {t('reg.session.close')}
                </Button>
            </div>
        </main>
    );
}
