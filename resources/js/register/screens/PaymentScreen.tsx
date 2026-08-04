import { Decimal, ZERO } from '@domain/money/decimal';
import { CashRoundingCalculator, isFullyPaid } from '@domain/tax/rounder';
import type { CashRounding } from '@domain/tax/types';
import type { PaymentMethodRow, PaymentRow } from '@domain/types';
import { Button, NumPad, cn } from '@shared/ui';
import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';

import { tryRuntime } from '../data/runtime';
import { useT } from '../i18n';
import {
    addPayment,
    commitPaidOrder,
    removePayment,
    setPaymentAmount,
    setPaymentStatus,
    setTip,
} from '../domain/order-actions';
import { openDrawer } from '../domain/printing';
import {
    useCatalog,
    useMoney,
    useOrder,
    useOrderLines,
    useOrderPayments,
    useTotals,
} from '../hooks/use-register';
import { useUiStore } from '../state/ui-store';

/**
 * The payment screen (REG-200 … REG-220).
 *
 * Rules worth stating because getting them wrong costs money:
 *
 *  - **The change line is the server's job** (REG-204). The client shows the change; it never
 *    creates a negative `is_change` payment, because a client that does produces double counting.
 *  - **Overpaying is only legal when a cash method exists** (REG-203) — otherwise there is no way to
 *    give the difference back.
 *  - **"Fully paid" is a tolerance, not a sign test** (REG-176). With cash rounding on, the amount
 *    the drawer can physically take differs from the arithmetic total, so `due > 0` would leave
 *    rounded orders permanently open. See `isFullyPaid` — and note the tolerance is granted only
 *    once cash is actually in the tender, because a card can always be charged the exact amount.
 *  - **Validation flushes IndexedDB immediately** (REG-217), before navigating to the receipt. A
 *    crash between "paid" and "flushed" loses a sale, and the 250 ms debounce is exactly long enough
 *    for that to happen.
 */

export type PaymentScreenProps = {
    orderUuid: string;
    onValidated: () => void;
    onBack: () => void;
};

export function PaymentScreen({ orderUuid, onValidated, onBack }: PaymentScreenProps): JSX.Element {
    const t = useT();
    const money = useMoney();
    const catalog = useCatalog();
    const order = useOrder(orderUuid);
    const lines = useOrderLines(orderUuid);
    const payments = useOrderPayments(orderUuid);
    const totals = useTotals(orderUuid);
    const openDialog = useUiStore((state) => state.openDialog);

    const [selectedPayment, setSelectedPayment] = useState<string | null>(null);
    const [buffer, setBuffer] = useState('');
    const [error, setError] = useState<string | null>(null);

    const methods = catalog.paymentMethods.filter((method) =>
        (catalog.config?.payment_method_ids ?? []).includes(method.id),
    );
    const hasCash = methods.some((method) => method.is_cash_count);
    const cashRounding = catalog.cashRounding;

    const prefillFor = useCallback(
        (methodId: number): string =>
            prefillAmount(
                totals.due,
                catalog.paymentMethods.find((candidate) => candidate.id === methodId),
                cashRounding,
            ),
        [cashRounding, catalog.paymentMethods, totals.due],
    );

    const paidInFull = settlesOrder(totals.due, payments, catalog.paymentMethods, cashRounding);

    // REG-201 — a single configured method needs no tap.
    useEffect(() => {
        if (payments.length === 0 && methods.length === 1 && Decimal.of(totals.due).signum() > 0) {
            const only = methods[0];
            if (only) setSelectedPayment(addPayment(orderUuid, only.id, prefillFor(only.id)));
        }
    }, [methods, orderUuid, payments.length, prefillFor, totals.due]);

    const tender = useCallback(
        (methodId: number) => {
            const uuid = addPayment(orderUuid, methodId, prefillFor(methodId));
            setSelectedPayment(uuid);
            setBuffer('');
            const method = catalog.paymentMethods.find((candidate) => candidate.id === methodId);
            if (method?.is_cash_count) {
                const runtime = tryRuntime();
                if (runtime) void openDrawer(runtime.printer);
            }
        },
        [catalog.paymentMethods, orderUuid, prefillFor],
    );

    const applyBuffer = useCallback(
        (next: string) => {
            setBuffer(next);
            if (selectedPayment === null) return;
            setPaymentAmount(selectedPayment, next === '' ? '0' : next);
        },
        [selectedPayment],
    );

    const validate = useCallback(async () => {
        setError(null);
        if (lines.length === 0) {
            setError(t('reg.pay.emptyOrder'));
            return;
        }
        if (!paidInFull) {
            setError(t('reg.pay.notEnough'));
            return;
        }
        if (Decimal.of(totals.change).signum() > 0 && !hasCash) {
            setError(t('reg.pay.overpayNoCash'));
            return;
        }
        // REG-216 — a method flagged `identify_customer` needs a customer before it can settle.
        const needsCustomer = payments.some(
            (payment) =>
                catalog.paymentMethods.find((method) => method.id === payment.payment_method_id)
                    ?.identify_customer === true,
        );
        if (needsCustomer && order?.customer_id == null) {
            setError(t('reg.pay.needCustomer'));
            openDialog('customer');
            return;
        }

        // Validate, then force the sale to disk before navigating to the receipt (REG-217): the
        // 250 ms write debounce would otherwise leave a crash window that loses the sale.
        const runtime = tryRuntime();
        const flushed = await commitPaidOrder(
            orderUuid,
            runtime
                ? { flushNow: runtime.persistence.flushNow, drain: () => runtime.syncer.drain() }
                : null,
        );
        if (!flushed) {
            // The local replica write failed. The order was still pushed to the server, but
            // IndexedDB is not durable, so warn rather than navigating past it — re-tapping validate
            // retries the flush.
            setError(t('reg.pay.saveFailed'));
            return;
        }
        onValidated();
    }, [
        catalog.paymentMethods,
        hasCash,
        lines.length,
        onValidated,
        openDialog,
        order?.customer_id,
        orderUuid,
        paidInFull,
        payments,
        t,
        totals.change,
    ]);

    const quickAmounts = useCallback(
        (): string[] => quickAmountsFor(totals.due, catalog.bills),
        [totals.due, catalog.bills],
    );

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 till:flex-row">
            <section className="flex min-w-0 flex-1 flex-col gap-3">
                <header className="rounded-pos bg-slate-900 p-4 text-white">
                    <p className="text-sm opacity-80">{t('reg.pay.due')}</p>
                    <p className="text-total tabular-nums">{money(totals.roundedTotal)}</p>
                    <dl className="mt-2 grid grid-cols-3 gap-2 text-sm">
                        <div>
                            <dt className="opacity-70">{t('reg.pay.tendered')}</dt>
                            <dd className="tabular-nums">{money(totals.paid)}</dd>
                        </div>
                        <div>
                            <dt className="opacity-70">{t('reg.pay.remaining')}</dt>
                            <dd className="tabular-nums">{money(totals.due)}</dd>
                        </div>
                        <div>
                            <dt className="opacity-70">{t('reg.pay.change')}</dt>
                            <dd className="text-xl font-bold tabular-nums">{money(totals.change)}</dd>
                        </div>
                    </dl>
                    {order && order.guest_count > 1 ? (
                        <p className="mt-1 text-sm opacity-80">
                            {t('reg.order.perGuest', {
                                amount: money(
                                    Decimal.of(totals.roundedTotal).div(String(order.guest_count), 2).toString(),
                                ),
                            })}
                        </p>
                    ) : null}
                </header>

                <div className="grid grid-cols-2 gap-2 till:grid-cols-3">
                    {methods.map((method) => (
                        <Button key={method.id} size="xl" variant="secondary" onClick={() => tender(method.id)}>
                            {method.name}
                        </Button>
                    ))}
                </div>

                <ul className="space-y-2">
                    {payments.map((payment) => (
                        <PaymentLine
                            key={payment.uuid}
                            payment={payment}
                            label={
                                catalog.paymentMethods.find((method) => method.id === payment.payment_method_id)
                                    ?.name ?? '—'
                            }
                            selected={payment.uuid === selectedPayment}
                            amount={money(payment.amount)}
                            onSelect={() => {
                                setSelectedPayment(payment.uuid);
                                setBuffer('');
                            }}
                            onRemove={() => {
                                removePayment(payment.uuid);
                                if (selectedPayment === payment.uuid) setSelectedPayment(null);
                            }}
                            onTerminal={(status) => setPaymentStatus(payment.uuid, status)}
                            terminal={
                                catalog.paymentMethods.find((method) => method.id === payment.payment_method_id)
                                    ?.method_type === 'card_terminal'
                            }
                        />
                    ))}
                </ul>

                {error ? <p className="rounded-pos bg-danger-soft p-3 text-danger-fg">{error}</p> : null}
            </section>

            <aside className="w-full shrink-0 space-y-2 till:w-80">
                <div className="grid grid-cols-4 gap-2">
                    {quickAmounts().map((amount, index) => (
                        <Button
                            key={`${amount}-${index}`}
                            size="md"
                            variant="secondary"
                            disabled={selectedPayment === null}
                            onClick={() => applyBuffer(amount)}
                        >
                            {money(amount)}
                        </Button>
                    ))}
                </div>

                <NumPad
                    value={buffer}
                    onChange={applyBuffer}
                    mode="price"
                    scannerGuardMs={0}
                    disabled={selectedPayment === null}
                />

                <Button
                    block
                    variant="secondary"
                    onClick={() => {
                        const change = Decimal.of(totals.change);
                        if (change.signum() > 0) setTip(orderUuid, change.withScale(2).toString());
                    }}
                >
                    {t('reg.pay.tip')}
                </Button>

                <div className="flex gap-2">
                    <Button variant="ghost" onClick={onBack}>
                        {t('common.back')}
                    </Button>
                    <Button
                        size="xl"
                        variant="success"
                        className="flex-1"
                        disabled={!paidInFull}
                        onClick={() => void validate()}
                    >
                        {t('reg.pay.validate')}
                    </Button>
                </div>
            </aside>
        </div>
    );
}

function PaymentLine({
    payment,
    label,
    selected,
    amount,
    onSelect,
    onRemove,
    onTerminal,
    terminal,
}: {
    payment: PaymentRow;
    label: string;
    selected: boolean;
    amount: string;
    onSelect: () => void;
    onRemove: () => void;
    onTerminal: (status: PaymentRow['payment_status']) => void;
    terminal: boolean;
}): JSX.Element {
    const t = useT();
    const pending = payment.payment_status === 'pending';

    return (
        <li
            className={cn(
                'flex items-center gap-2 rounded-pos bg-white p-3 ring-1 ring-slate-200',
                selected && 'ring-2 ring-brand-500',
            )}
        >
            <button type="button" className="min-w-0 flex-1 text-start" onClick={onSelect}>
                <span className="block font-semibold">{label}</span>
                <span className="block text-sm text-slate-500">
                    {pending ? t('reg.pay.terminalWaiting') : payment.payment_status}
                </span>
            </button>

            <span className="text-xl font-bold tabular-nums">{amount}</span>

            {terminal ? (
                <div className="flex flex-col gap-1">
                    <Button size="sm" variant="secondary" onClick={() => onTerminal('pending')}>
                        {t('reg.pay.terminalSend')}
                    </Button>
                    {pending ? (
                        <>
                            <Button size="sm" variant="success" onClick={() => onTerminal('done')}>
                                {t('reg.pay.terminalForce')}
                            </Button>
                            <Button size="sm" variant="danger" onClick={() => onTerminal('cancelled')}>
                                {t('reg.pay.terminalCancel')}
                            </Button>
                        </>
                    ) : null}
                </div>
            ) : null}

            <button
                type="button"
                aria-label={t('reg.pay.removeLine')}
                className="min-h-touch min-w-touch rounded-pos text-lg text-danger"
                onClick={onRemove}
            >
                ×
            </button>
        </li>
    );
}

/**
 * The remaining due snapped to what the drawer can make (REG-202). Without cash rounding the due
 * is already exact and comes back untouched.
 */
export function cashRounded(due: Decimal, cashRounding: CashRounding | null): Decimal {
    if (cashRounding === null || due.signum() <= 0) return due;
    return new CashRoundingCalculator(cashRounding).apply(due).roundedTotal;
}

/**
 * Whether any live payment line on the order was tendered with a cash method (REG-176).
 *
 * Same exclusions as `settledPayments` in `totals.ts`, and for the same reason: a change line is
 * money going back out of the drawer, and a failed or cancelled line was never taken at all.
 * Neither is a tender, so neither earns the rounding concession.
 */
export function hasCashTender(
    payments: readonly PaymentRow[],
    methods: readonly PaymentMethodRow[],
): boolean {
    return payments.some(
        (payment) =>
            !payment.is_change &&
            payment.payment_status !== 'failed' &&
            payment.payment_status !== 'cancelled' &&
            methods.find((method) => method.id === payment.payment_method_id)?.is_cash_count === true,
    );
}

/**
 * The validate decision (REG-176) — exported so the tests exercise *this*, not a copy of it.
 *
 * The tolerance is a cash concession: it exists because the drawer has no coin smaller than the
 * step. A card can be charged the exact amount, so a settlement with no cash in it stays on the
 * strict `due <= 0` test and cannot be closed a few cents short.
 */
export function settlesOrder(
    due: string,
    payments: readonly PaymentRow[],
    methods: readonly PaymentMethodRow[],
    cashRounding: CashRounding | null,
): boolean {
    const tolerated = cashRounding !== null && hasCashTender(payments, methods);
    return isFullyPaid(
        due,
        tolerated ? cashRounding.rounding : null,
        tolerated ? cashRounding.method : undefined,
    );
}

/**
 * What a new payment line pre-fills with (REG-202) — exported for the same reason.
 *
 * Pre-filling the raw due on a cash line hands the cashier an amount the drawer cannot make, so
 * they tender something else and the line no longer matches what was taken. A card can be charged
 * the exact figure, so a card line pre-fills with the due untouched.
 */
export function prefillAmount(
    due: string,
    method: PaymentMethodRow | undefined,
    cashRounding: CashRounding | null,
): string {
    const remaining = Decimal.of(due);
    if (remaining.signum() <= 0) return '0';
    return cashRounded(remaining, method?.is_cash_count === true ? cashRounding : null)
        .withScale(2)
        .toString();
}

/**
 * The quick-tender keys (REG-205). When the currency has configured note denominations (`pos_bills`)
 * these are the notes that can cover the due — so the cashier taps the note the customer handed
 * over — with the exact due first. With no bills configured it falls back to the arithmetic ladder
 * (due, next 5, +10, +20). Exported for the tests.
 */
export function quickAmountsFor(dueValue: string, bills: readonly { value: string }[]): string[] {
    const due = Decimal.of(dueValue);
    const exact = due.withScale(2).toString();

    const notes = bills
        .map((bill) => Decimal.of(bill.value))
        .filter((value) => value.signum() > 0 && value.gte(due))
        .sort((a, b) => a.compare(b));

    if (notes.length > 0) {
        return [...new Set([exact, ...notes.map((note) => note.withScale(2).toString())])].slice(0, 4);
    }

    const rounded = due.roundToStep('5', 'up');
    return [
        exact,
        rounded.eq(due) ? rounded.add('5').withScale(2).toString() : rounded.withScale(2).toString(),
        rounded.add('10').withScale(2).toString(),
        rounded.add('20').withScale(2).toString(),
    ];
}

/** Exported for the split-payment helper in the tests. */
export function remainingAfter(payments: readonly PaymentRow[], total: string): string {
    const paid = payments
        .filter((payment) => !payment.is_change)
        .reduce((sum, payment) => sum.add(Decimal.of(payment.amount)), ZERO);
    return Decimal.of(total).sub(paid).withScale(2).toString();
}
