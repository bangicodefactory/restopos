import { Button, cn } from '@shared/ui';
import type { JSX } from 'react';

import { Notice, Price, Screen } from './Brand';
import { useT } from '../i18n';
import { TRACKING_ORDER } from '../realtime';
import type { KnownOrder, SelfOrderConfig, SelfOrderStatus, TrackingStep } from '../types';

/**
 * Checkout, live status and history (SLF-060, SLF-061, SLF-080, SLF-081, SLF-082, SLF-083).
 *
 * The status ladder is the part Odoo does not have and the reason customers scan a QR twice:
 * "received → preparing → ready", driven by the kitchen's own stage transitions (KDS-019). It is
 * fed by the `order.state` broadcast on the order's public channel and, when that is unavailable,
 * by a ten-second poll — the same "the socket is an optimisation, never the contract" rule the
 * kitchen display follows.
 */

export function CheckoutScreen({
    config,
    total,
    submitting,
    error,
    onPayCashier,
    onPayOnline,
    onBack,
}: {
    config: SelfOrderConfig;
    total: string;
    submitting: boolean;
    error: string | null;
    onPayCashier: () => void;
    onPayOnline: () => void;
    onBack: () => void;
}): JSX.Element {
    const t = useT();
    const onlineAvailable = config.online_payment_method_id !== null;

    return (
        <Screen title={t('so.checkout.title')} onBack={onBack}>
            {error && <Notice tone="danger">{t(error)}</Notice>}

            <div className="flex flex-col gap-3 p-3">
                <p className="flex items-baseline justify-between rounded-pos bg-white px-4 py-3 text-2xl font-black shadow-pos">
                    <span>{t('so.cart.total')}</span>
                    <Price amount={total} />
                </p>

                <PaymentOption
                    title={t('so.checkout.payCashier')}
                    hint={t('so.checkout.payCashierHint')}
                    onClick={onPayCashier}
                    loading={submitting}
                    primary
                />

                {/*
                 * Online payment degrades on purpose. The shipped provider is a NullProvider and a
                 * venue may have no online method at all, in which case the button is simply absent
                 * — never a dead button that fails on tap.
                 */}
                {onlineAvailable && (
                    <PaymentOption
                        title={t('so.checkout.payOnline')}
                        hint={t('so.checkout.payOnlineHint')}
                        onClick={onPayOnline}
                        loading={submitting}
                    />
                )}
            </div>
        </Screen>
    );
}

function PaymentOption({
    title,
    hint,
    onClick,
    loading,
    primary,
}: {
    title: string;
    hint: string;
    onClick: () => void;
    loading: boolean;
    primary?: boolean;
}): JSX.Element {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={loading}
            className={cn(
                'rounded-pos-lg px-5 py-5 text-start shadow-pos ring-1 ring-inset disabled:opacity-60',
                primary ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-slate-900 ring-slate-200',
            )}
        >
            <span className="block text-2xl font-bold">{title}</span>
            <span className={cn('block text-base', primary ? 'text-white/85' : 'text-slate-500')}>{hint}</span>
        </button>
    );
}

// ─────────────────────────────────────────────────────────────────────────────

const STEP_LABEL: Record<TrackingStep, string> = {
    received: 'so.status.received',
    preparing: 'so.status.preparing',
    ready: 'so.status.ready',
    done: 'so.status.done',
    cancelled: 'so.status.cancelled',
};

const STEP_HINT: Record<TrackingStep, string> = {
    received: 'so.status.receivedHint',
    preparing: 'so.status.preparingHint',
    ready: 'so.status.readyHint',
    done: 'so.status.done',
    cancelled: 'so.status.cancelled',
};

export function StatusScreen({
    order,
    step,
    offline,
    paymentPending,
    canCancel,
    onCancel,
    onNewOrder,
    onHistory,
}: {
    order: SelfOrderStatus | null;
    step: TrackingStep;
    offline: boolean;
    paymentPending: boolean;
    canCancel: boolean;
    onCancel: () => void;
    onNewOrder: () => void;
    onHistory: () => void;
}): JSX.Element {
    const t = useT();
    const tracking = order?.tracking_number ?? '—';
    const due = Number.parseFloat(order?.amount_due ?? '0');

    return (
        <Screen title={t('so.status.title', { tracking })} onBack={onHistory}>
            {offline && <Notice tone="warn">{t('so.error.offline')}</Notice>}
            {paymentPending && <Notice tone="info">{t('so.checkout.paymentPending')}</Notice>}

            <div className="flex flex-col items-center gap-6 px-4 py-8 text-center">
                <p className="text-base font-semibold uppercase tracking-[0.2em] text-slate-500">
                    {t('so.status.title', { tracking: '' })}
                </p>
                <p className="font-mono text-6xl font-black tabular-nums">{tracking}</p>

                {step === 'cancelled' ? (
                    <p className="rounded-pos bg-danger-soft px-5 py-3 text-2xl font-bold text-danger-fg">
                        {t('so.status.cancelled')}
                    </p>
                ) : (
                    <>
                        <ol className="flex w-full max-w-md items-center justify-between gap-2">
                            {TRACKING_ORDER.map((candidate, index) => {
                                const reached = TRACKING_ORDER.indexOf(step) >= index || step === 'done';
                                const current = candidate === step;
                                return (
                                    <li key={candidate} className="flex flex-1 flex-col items-center gap-1">
                                        <span
                                            aria-hidden="true"
                                            className={cn(
                                                'flex size-12 items-center justify-center rounded-full text-xl font-black',
                                                reached ? 'bg-brand-600 text-white' : 'bg-slate-200 text-slate-500',
                                                current && 'ring-4 ring-brand-300',
                                            )}
                                        >
                                            {index + 1}
                                        </span>
                                        <span
                                            className={cn(
                                                'text-base font-bold',
                                                reached ? 'text-slate-900' : 'text-slate-400',
                                            )}
                                        >
                                            {t(STEP_LABEL[candidate])}
                                        </span>
                                    </li>
                                );
                            })}
                        </ol>
                        <p aria-live="polite" className="text-xl font-semibold">
                            {t(STEP_HINT[step])}
                        </p>
                    </>
                )}

                {order && (
                    <section className="w-full max-w-md rounded-pos bg-white p-4 text-start shadow-pos">
                        <ul className="divide-y divide-slate-100">
                            {order.lines.map((line) => (
                                <li key={line.uuid} className="flex items-baseline justify-between py-2">
                                    <span className="text-lg">
                                        <span className="me-2 font-black tabular-nums">
                                            {formatQuantity(line.quantity)}×
                                        </span>
                                        {line.full_product_name}
                                    </span>
                                    <Price amount={line.price_subtotal_incl} className="font-bold" />
                                </li>
                            ))}
                        </ul>
                        <p className="flex items-baseline justify-between pt-3 text-2xl font-black">
                            <span>{t('so.cart.total')}</span>
                            <Price amount={order.amount_total} />
                        </p>
                        {due > 0 ? (
                            <p className="pt-2 text-lg font-bold text-warn-fg">{t('so.status.payAtCounter')}</p>
                        ) : (
                            <p className="pt-2 text-lg font-bold text-ok">{t('so.status.paid')}</p>
                        )}
                    </section>
                )}

                <div className="flex w-full max-w-md flex-col gap-2">
                    <Button size="lg" block onClick={onNewOrder}>
                        {t('so.status.newOrder')}
                    </Button>
                    {canCancel && (
                        <Button variant="ghost" size="lg" block onClick={onCancel} className="!text-danger">
                            {t('so.checkout.cancel')}
                        </Button>
                    )}
                </div>
            </div>
        </Screen>
    );
}

// ─────────────────────────────────────────────────────────────────────────────

export function HistoryScreen({
    orders,
    onOpen,
    onBack,
}: {
    orders: readonly KnownOrder[];
    onOpen: (order: KnownOrder) => void;
    onBack: () => void;
}): JSX.Element {
    const t = useT();

    return (
        <Screen title={t('so.history.title')} onBack={onBack}>
            {orders.length === 0 ? (
                <p className="px-6 py-20 text-center text-xl text-slate-500">{t('so.history.empty')}</p>
            ) : (
                <ul className="divide-y divide-slate-200 bg-white">
                    {orders.map((order) => (
                        <li key={order.uuid}>
                            <button
                                type="button"
                                onClick={() => onOpen(order)}
                                className="flex min-h-touch-xl w-full items-center gap-3 px-3 py-3 text-start active:bg-slate-50"
                            >
                                <span className="font-mono text-2xl font-black tabular-nums">
                                    {order.trackingNumber ?? '—'}
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="block text-base font-bold">{t(STEP_LABEL[order.step])}</span>
                                    <span className="block text-base text-slate-500">
                                        {new Date(order.placedAt).toLocaleString()}
                                    </span>
                                </span>
                                <Price amount={order.total} className="text-lg font-bold" />
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </Screen>
    );
}

function formatQuantity(quantity: string): string {
    const value = Number.parseFloat(quantity);
    if (!Number.isFinite(value)) return quantity;
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}
