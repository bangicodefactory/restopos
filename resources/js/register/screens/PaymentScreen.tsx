import { Decimal, ZERO } from '@domain/money/decimal';
import { CashRoundingCalculator } from '@domain/tax/rounder';
import type { CashRounding } from '@domain/tax/types';
import type { PaymentMethodRow, PaymentRow } from '@domain/types';
import { Button, NumPad, cn } from '@shared/ui';
import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';

import { tryRuntime } from '../data/runtime';
import {
    cancelOnTerminal,
    hasTerminalDriver,
    requestTerminalCancel,
    reverseOnTerminal,
    sendToTerminal,
    terminalStatus,
} from '../domain/terminal';
import { getCatalog } from '../data/catalog';
import { useT } from '../i18n';
import type { RegisterKey } from '../i18n';
import {
    addPayment,
    commitPaidOrder,
    paymentsFrozen,
    removePayment,
    setPaymentAmount,
    setPaymentStatus,
    setTip,
} from '../domain/order-actions';
import { openDrawer } from '../domain/printing';
import { tenderTargetFor } from '../domain/split-order';
import {
    useCatalog,
    useMoney,
    useOrder,
    useOrderLines,
    useOrderPayments,
    useTotals,
} from '../hooks/use-register';
import { useUiStore } from '../state/ui-store';
import { orphanedPayments, precheckPayment, settlesOrder } from './payment-prechecks';
import type { PrecheckBlock } from './payment-prechecks';

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
 *  - **Strip before judging** (REG-216). A zero-amount line and a terminal line still waiting are
 *    not tenders; deciding "is this paid?" with them still in place answers against rows carrying
 *    no money. The whole decision lives in `payment-prechecks.ts` so it can be tested without
 *    rendering.
 *  - **A live authorisation is cancelled on the terminal before its line may go** (REG-212).
 *    Deleting the row used to be local-only, which reads as "the terminal was told" while a real
 *    capture stays live and the customer is charged for a payment the register thinks it cancelled.
 *  - **The terminal buttons go through the registry, not through a local status string** (REG-210).
 *    They used to call `setPaymentStatus(uuid, status)` and nothing else, so "Send to the terminal"
 *    wrote `pending` — the line then said "Waiting for the terminal…" with nothing sent anywhere,
 *    and the cashier watched a card being taken that was not. What renders now depends on whether a
 *    driver is registered for the method: with one, the terminal's own answer decides and carries
 *    its metadata back with it; without one there is no Send button at all, because there is nothing
 *    to send to, and the cashier's Force / Cancel remain the honest local attestations they always
 *    were.
 */

/** Stable empty array so the mount-cleanup effect does not re-run on every render. */
const EMPTY_IDS: readonly number[] = [];

/** REG-216 — one message per blocking outcome, so the union is exhaustive at the type level. */
const BLOCK_MESSAGES: Record<PrecheckBlock, RegisterKey> = {
    empty_order: 'reg.pay.emptyOrder',
    not_enough: 'reg.pay.notEnough',
    overpay_no_cash: 'reg.pay.overpayNoCash',
    unrounded_cash: 'reg.pay.unroundedCash',
    needs_customer: 'reg.pay.needCustomer',
    preset_needs_identification: 'reg.pay.needIdentification',
};

export type PaymentScreenProps = {
    orderUuid: string;
    onValidated: () => void;
    onBack: () => void;
};

/**
 * Is this register in tip-after-payment mode (RST-122)?
 *
 * Both flags, not one: `enable_tips` says the venue tips at all, `tip_after_payment` says the tip is
 * taken *after* settling — which is the mode that changes what the validate button means.
 */
function tipAfterPaymentMode(): boolean {
    const config = getCatalog().config;

    return config?.enable_tips === true && config?.tip_after_payment === true;
}

export function PaymentScreen({ orderUuid, onValidated, onBack }: PaymentScreenProps): JSX.Element {
    // Both flags, not one: `enable_tips` says the venue tips at all, `tip_after_payment` says the
    // tip is taken after settling — which is the mode that changes what this button means.
    const tipAfterPayment = tipAfterPaymentMode();
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
    const [pendingOverpay, setPendingOverpay] = useState(false);
    /**
     * A terminal operation in flight, by payment uuid.
     *
     * One lock for every verb, not one per button: re-tapping while a send is out sends a second
     * sale for one tender, and re-tapping a cancel sends a second reversal for one authorisation.
     */
    const [busy, setBusy] = useState<string | null>(null);

    const methods = catalog.paymentMethods.filter((method) =>
        (catalog.config?.payment_method_ids ?? []).includes(method.id),
    );
    const hasCash = methods.some((method) => method.is_cash_count);
    const cashRounding = catalog.cashRounding;
    const splitTender = useUiStore((state) => state.splitTender);
    const resetSplit = useUiStore((state) => state.resetSplit);

    // A money split (RST-104, RST-105) pre-fills one guest's share instead of the whole balance —
    // but only for the bill it was taken against, and never above what that bill still owes.
    const target = tenderTargetFor(orderUuid, splitTender, totals.due);

    const prefillFor = useCallback(
        (methodId: number): string =>
            prefillAmount(
                target,
                catalog.paymentMethods.find((candidate) => candidate.id === methodId),
                cashRounding,
            ),
        [cashRounding, catalog.paymentMethods, target],
    );

    const paidInFull = settlesOrder(totals.due, payments, catalog.paymentMethods, cashRounding);

    // Once the receipt is printed, the paper and the database have to agree. Restating a €40 cash
    // tender as €30 afterwards is the skim the server refuses (BAN-410); the buttons go with it, so
    // the cashier is told before tapping rather than watching a sale come back rejected.
    const frozen = paymentsFrozen(order);

    // REG-219 — an order can sit open across a config change and come back holding a tender the
    // venue has stopped accepting. Dropped on mount rather than blocked: there is nothing for the
    // cashier to decide, and the line renders with a dash for a name so they cannot see why.
    const configuredIds = catalog.config?.payment_method_ids ?? EMPTY_IDS;

    useEffect(() => {
        for (const uuid of orphanedPayments(payments, configuredIds)) {
            removePayment(uuid);
            setSelectedPayment((current) => (current === uuid ? null : current));
        }
    }, [configuredIds, payments]);

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
                if (runtime) {
                    void openDrawer(runtime.printer, 'cash_payment', {
                        sessionId: order?.pos_session_id ?? null,
                        orderUuid,
                        employeeId: order?.employee_id ?? null,
                    });
                }
            }
        },
        [catalog.paymentMethods, order?.employee_id, order?.pos_session_id, orderUuid, prefillFor],
    );

    /**
     * REG-212 — a live authorisation has to be answered for before its row disappears.
     *
     * `await`ed rather than fired and forgotten: the point is that a refusal *stops* the delete.
     */
    const removeLine = useCallback(
        async (payment: PaymentRow) => {
            if (busy !== null) return;

            setError(null);

            const method = catalog.paymentMethods.find(
                (candidate) => candidate.id === payment.payment_method_id,
            );

            setBusy(payment.uuid);

            try {
                const cancelled = await cancelOnTerminal(payment, method);

                if (!cancelled.ok) {
                    setError(t(cancelled.reason));

                    return;
                }

                removePayment(payment.uuid);
                setSelectedPayment((current) => (current === payment.uuid ? null : current));
            } finally {
                setBusy(null);
            }
        },
        [busy, catalog.paymentMethods, t],
    );

    /**
     * REG-210 — the terminal buttons, routed through the driver registry.
     *
     * `force` is the one verb that never reaches a driver: it is the cashier asserting that the
     * device took the money when the register could not be told, and it only renders where there is
     * no driver to ask. Every other verb takes the terminal's own answer — including the metadata,
     * which is why `setPaymentStatus` is finally called with its third argument. That argument has
     * existed since the row was declared and until now was passed by exactly one unit test, so a
     * card brand, an auth code and a merchant slip were fields the register could hold and never
     * filled in.
     */
    const runTerminal = useCallback(
        async (payment: PaymentRow, verb: TerminalVerb) => {
            // Belt and braces, and knowingly so: every button that can reach here carries
            // `disabled={busy}`, and React does not dispatch onClick on a disabled button, so this
            // line is not reachable by tapping. A mutation sweep confirmed it — deleting it fails
            // nothing. It stays because the `disabled` prop is a rendering decision that a future
            // button can forget, and because `removeLine` above guards the same way; the cost of
            // the double-send it prevents is a customer charged twice for one tender.
            if (busy !== null) return;

            setError(null);

            const method = catalog.paymentMethods.find(
                (candidate) => candidate.id === payment.payment_method_id,
            );

            if (verb === 'force') {
                setPaymentStatus(payment.uuid, 'done');

                return;
            }

            setBusy(payment.uuid);

            try {
                const result =
                    verb === 'send'
                        ? await sendToTerminal(payment, method, order)
                        : verb === 'cancel'
                          ? await requestTerminalCancel(payment, method)
                          : verb === 'reverse'
                            ? await reverseOnTerminal(payment, method)
                            : await terminalStatus(payment, method);

                if (!result.ok) {
                    setError(t(result.reason));

                    return;
                }

                setPaymentStatus(payment.uuid, result.status, result.metadata);
            } finally {
                setBusy(null);
            }
        },
        [busy, catalog.paymentMethods, order, t],
    );

    const applyBuffer = useCallback(
        (next: string) => {
            setBuffer(next);
            if (selectedPayment === null) return;
            setPaymentAmount(selectedPayment, next === '' ? '0' : next);
        },
        [selectedPayment],
    );

    const validate = useCallback(async (confirmedOverpay = false) => {
        setError(null);

        // REG-216 — strip first, then judge. The decision lives in `payment-prechecks.ts`, and it
        // is handed the raw rows rather than `totals`: `useTotals` counts a pending line as paid,
        // so passing its verdict in let a lone uncaptured tender be stripped *and* pass as settled,
        // validating an order with no payment rows on it.
        const verdict = precheckPayment({
            lines,
            payments,
            methods: catalog.paymentMethods,
            presetIdentification:
                catalog.presets.find((preset) => preset.id === order?.pos_preset_id)?.identification ?? null,
            cashRounding,
            total: totals.roundedTotal,
            customerId: order?.customer_id ?? null,
            hasCashMethod: hasCash,
        });

        // Acted on whatever else is wrong: these rows are not tenders either way, and leaving them
        // to be re-judged on the next tap means the same non-answer twice.
        for (const uuid of verdict.strip) {
            removePayment(uuid);
        }

        if (verdict.block !== null) {
            setError(t(BLOCK_MESSAGES[verdict.block]));

            // The one block the cashier can fix from here without dismissing anything.
            if (verdict.block === 'needs_customer') openDialog('customer');

            return;
        }

        if (verdict.confirm !== null && !confirmedOverpay) {
            // Asked, not refused: a genuinely huge tender is not the register's call to make.
            setPendingOverpay(true);

            return;
        }

        setPendingOverpay(false);

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
        // The split is over the moment the bill settles; leaving the share set would pre-fill the
        // next order with one guest's quarter of a table that has already left.
        resetSplit();
        onValidated();
    }, [
        resetSplit,
        catalog.presets,
        order?.pos_preset_id,
        cashRounding,
        catalog.paymentMethods,
        hasCash,
        lines,
        onValidated,
        openDialog,
        order?.customer_id,
        orderUuid,
        payments,
        t,
        totals.roundedTotal,
    ]);

    const quickAmounts = useCallback(
        (): string[] => quickAmountsFor(totals.due, catalog.bills),
        [totals.due, catalog.bills],
    );

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 till:flex-row">
            <section className="flex min-w-0 flex-1 flex-col gap-3">
                {/* RST-107 — the split loop is not a place the register navigates *to*; the bill
                    stays open and the balance shrinks with each share. Saying what is left is what
                    turns that into something a waiter can work through without re-finding the tab. */}
                {splitTender?.orderUuid === orderUuid && Decimal.of(totals.due).signum() > 0 ? (
                    <p className="rounded-pos bg-brand-50 px-3 py-2 font-semibold" data-testid="split-remaining">
                        {t('reg.split.remaining', { amount: money(totals.due) })}
                    </p>
                ) : null}

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
                            frozen={frozen || busy !== null}
                            busy={busy === payment.uuid}
                            onRemove={() => void removeLine(payment)}
                            onTerminal={(verb) => void runTerminal(payment, verb)}
                            terminal={
                                catalog.paymentMethods.find((method) => method.id === payment.payment_method_id)
                                    ?.method_type === 'card_terminal'
                            }
                            hasDriver={hasTerminalDriver(
                                catalog.paymentMethods.find((method) => method.id === payment.payment_method_id),
                            )}
                        />
                    ))}
                </ul>

                {error ? <p className="rounded-pos bg-danger-soft p-3 text-danger-fg">{error}</p> : null}

                {pendingOverpay ? (
                    <div className="rounded-pos bg-warning-soft p-3" data-testid="overpay-confirm">
                        <p className="font-semibold">{t('reg.pay.largeOverpay')}</p>
                        <div className="mt-2 flex gap-2">
                            <Button variant="ghost" onClick={() => setPendingOverpay(false)}>
                                {t('common.cancel')}
                            </Button>
                            <Button variant="success" onClick={() => void validate(true)}>
                                {t('common.confirm')}
                            </Button>
                        </div>
                    </div>
                ) : null}
            </section>

            <aside className="w-full shrink-0 space-y-2 till:w-80">
                <div className="grid grid-cols-4 gap-2">
                    {quickAmounts().map((amount, index) => (
                        <Button
                            key={`${amount}-${index}`}
                            size="md"
                            variant="secondary"
                            data-testid="quick-amount"
                            disabled={selectedPayment === null || frozen}
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
                    disabled={selectedPayment === null || frozen}
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
                    {/* RST-122 — in tip-after-payment mode the sale is settled but the tab is
                        not finished: the slip goes out, comes back signed, and the tip is entered
                        then. "Validate" is the wrong word for that, because it reads as done. */}
                    <Button
                        size="xl"
                        variant="success"
                        className="flex-1"
                        disabled={!paidInFull}
                        onClick={() => void validate()}
                        data-testid="payment-validate"
                    >
                        {tipAfterPayment ? t('reg.tip.closeTab') : t('reg.pay.validate')}
                    </Button>
                </div>
            </aside>
        </div>
    );
}

/**
 * What the cashier can ask of a terminal line.
 *
 * `force` is not a terminal operation and never reaches a driver — it is the cashier stating that
 * the device took the money. It is listed here because it is one of the buttons, and keeping it out
 * of the union would only mean a second handler that does the same dispatch.
 */
type TerminalVerb = 'send' | 'cancel' | 'reverse' | 'status' | 'force';

function PaymentLine({
    payment,
    label,
    selected,
    amount,
    onSelect,
    onRemove,
    onTerminal,
    terminal,
    hasDriver,
    busy,
    frozen,
}: {
    payment: PaymentRow;
    label: string;
    selected: boolean;
    amount: string;
    onSelect: () => void;
    onRemove: () => void;
    onTerminal: (verb: TerminalVerb) => void;
    terminal: boolean;
    /** Is a driver registered for this line's method? Decides which buttons are honest. */
    hasDriver: boolean;
    /** Is this line's own terminal operation still out? */
    busy: boolean;
    frozen: boolean;
}): JSX.Element {
    const t = useT();
    const status = payment.payment_status;
    const pending = status === 'pending';
    // "Waiting" now means one of two true things: an operation is genuinely out to a driver, or the
    // row arrived already pending. Nothing on this screen can put a line into `pending` without
    // having sent it any more, which is what the label used to claim falsely.
    const waiting = busy || pending;

    return (
        <li
            className={cn(
                'flex items-center gap-2 rounded-pos bg-white p-3 ring-1 ring-slate-200',
                selected && 'ring-2 ring-brand-500',
            )}
        >
            <button
                type="button"
                className="min-w-0 flex-1 text-start"
                data-testid="payment-select"
                onClick={onSelect}
            >
                <span className="block font-semibold">{label}</span>
                <span className="block text-sm text-slate-500" data-testid="payment-status">
                    {waiting ? t('reg.pay.terminalWaiting') : status}
                </span>
            </button>

            <span className="text-xl font-bold tabular-nums">{amount}</span>

            {terminal ? (
                <div className="flex flex-col gap-1">
                    {hasDriver ? (
                        <>
                            {/* Nothing to send for a capture, and re-sending an authorisation the
                                terminal is already holding would present a second sale. */}
                            {status === 'done' || status === 'authorized' ? null : (
                                <Button
                                    size="sm"
                                    variant="secondary"
                                    disabled={busy}
                                    data-testid="terminal-send"
                                    onClick={() => onTerminal('send')}
                                >
                                    {t('reg.pay.terminalSend')}
                                </Button>
                            )}
                            {status === 'pending' || status === 'authorized' ? (
                                <>
                                    {/* The way out of "the customer says it went through": ask the
                                        device rather than guess, which is what Force is. */}
                                    <Button
                                        size="sm"
                                        variant="secondary"
                                        disabled={busy}
                                        data-testid="terminal-status"
                                        onClick={() => onTerminal('status')}
                                    >
                                        {t('reg.pay.terminalAsk')}
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="danger"
                                        disabled={busy}
                                        data-testid="terminal-cancel"
                                        onClick={() => onTerminal('cancel')}
                                    >
                                        {t('reg.pay.terminalCancel')}
                                    </Button>
                                </>
                            ) : null}
                            {status === 'done' ? (
                                <Button
                                    size="sm"
                                    variant="danger"
                                    disabled={busy}
                                    data-testid="terminal-reverse"
                                    onClick={() => onTerminal('reverse')}
                                >
                                    {t('reg.pay.terminalReverse')}
                                </Button>
                            ) : null}
                        </>
                    ) : (
                        /* No driver: the cashier is the driver. There is no Send, because there is
                           nothing to send to — only the two attestations of what they did on the
                           device themselves, and each renders only where it would change anything. */
                        <>
                            {status === 'done' ? null : (
                                <Button
                                    size="sm"
                                    variant="success"
                                    disabled={busy}
                                    data-testid="terminal-force"
                                    onClick={() => onTerminal('force')}
                                >
                                    {t('reg.pay.terminalForce')}
                                </Button>
                            )}
                            {status === 'cancelled' ? null : (
                                <Button
                                    size="sm"
                                    variant="danger"
                                    disabled={busy}
                                    data-testid="terminal-cancel"
                                    onClick={() => onTerminal('cancel')}
                                >
                                    {t('reg.pay.terminalCancel')}
                                </Button>
                            )}
                        </>
                    )}
                </div>
            ) : null}

            {frozen ? null : (
                <button
                    type="button"
                    aria-label={t('reg.pay.removeLine')}
                    data-testid="payment-remove"
                    className="min-h-touch min-w-touch rounded-pos text-lg text-danger"
                    onClick={onRemove}
                >
                    ×
                </button>
            )}
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

// `hasCashTender` and `settlesOrder` moved to `payment-prechecks.ts` — the precheck now derives
// the settlement itself, so they had to live where it could reach them without an import cycle.
// Re-exported because they are the screen's published decision and the tolerance tests import
// them from here.
export { hasCashTender, settlesOrder } from './payment-prechecks';

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
