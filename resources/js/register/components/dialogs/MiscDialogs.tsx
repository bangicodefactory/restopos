import { Decimal } from '@domain/money/decimal';
import { useCan, useSessionStore } from '@shared/auth';
import { Button, Dialog, NumPad, cn } from '@shared/ui';
import type { JSX } from 'react';
import { useState } from 'react';

import { useT } from '../../i18n';
import { recordCashMovement } from '../../domain/session-actions';
import { discardOrder, renameOrder, setGuestCount } from '../../domain/order-actions';
import { baseListPrice, taxIdsFor } from '../../data/catalog';
import {
    useCatalog,
    useMoney,
    useOrder,
    useSelectedOrderUuid,
    useTotals,
} from '../../hooks/use-register';
import { usePosSessionStore } from '../../state/session-store';
import { useUiStore } from '../../state/ui-store';

/** Guest count (RST-070, RST-071) — zero guests on an empty order deletes it. */
export function GuestsDialog(): JSX.Element | null {
    const t = useT();
    const money = useMoney();
    const dialog = useUiStore((state) => state.dialog);
    const close = useUiStore((state) => state.closeDialog);
    const orderUuid = useSelectedOrderUuid();
    const order = useOrder(orderUuid);
    const totals = useTotals(orderUuid);
    const [value, setValue] = useState(String(order?.guest_count ?? 1));

    if (dialog?.kind !== 'guests' || orderUuid === null) return null;

    const guests = Number.parseInt(value === '' ? '0' : value, 10);
    const perGuest =
        guests > 0 ? Decimal.of(totals.roundedTotal).div(String(guests), 2).toString() : totals.roundedTotal;

    return (
        <Dialog
            open
            onClose={close}
            title={t('reg.order.guestsTitle')}
            footer={
                <>
                    <Button variant="ghost" onClick={close}>
                        {t('common.cancel')}
                    </Button>
                    <Button
                        onClick={() => {
                            if (guests === 0 && totals.lineCount === 0) discardOrder(orderUuid);
                            else setGuestCount(orderUuid, Math.max(1, guests));
                            close();
                        }}
                    >
                        {t('common.ok')}
                    </Button>
                </>
            }
        >
            <div className="space-y-3">
                <div className="rounded-pos bg-slate-900 px-4 py-3 text-end font-mono text-3xl text-white">
                    {value === '' ? '0' : value}
                </div>
                <p className="text-end text-slate-600">{t('reg.order.perGuest', { amount: money(perGuest) })}</p>
                <NumPad value={value} onChange={setValue} mode="quantity" decimals={0} scannerGuardMs={0} />
            </div>
        </Dialog>
    );
}

/** Rename a floating order (REG-120). */
export function OrderNameDialog(): JSX.Element | null {
    const t = useT();
    const dialog = useUiStore((state) => state.dialog);
    const close = useUiStore((state) => state.closeDialog);
    const targetUuid = typeof dialog?.payload?.['orderUuid'] === 'string' ? dialog.payload['orderUuid'] : null;
    const order = useOrder(targetUuid);
    const [name, setName] = useState(order?.floating_order_name ?? '');

    if (dialog?.kind !== 'orderName' || targetUuid === null) return null;

    return (
        <Dialog
            open
            onClose={close}
            title={t('reg.order.renameTitle')}
            footer={
                <>
                    <Button variant="ghost" onClick={close}>
                        {t('common.cancel')}
                    </Button>
                    <Button
                        onClick={() => {
                            renameOrder(targetUuid, name.trim() === '' ? null : name.trim());
                            close();
                        }}
                    >
                        {t('common.ok')}
                    </Button>
                </>
            }
        >
            <input
                type="text"
                autoFocus
                className="min-h-touch-lg w-full rounded-pos border border-slate-300 px-3"
                value={name}
                onChange={(event) => setName(event.target.value)}
            />
        </Dialog>
    );
}

/** Cash in / out with a mandatory reason (REG-010). Queues offline. */
export function CashMoveDialog(): JSX.Element | null {
    const t = useT();
    const dialog = useUiStore((state) => state.dialog);
    const close = useUiStore((state) => state.closeDialog);
    const session = usePosSessionStore((state) => state.session);
    const cashier = useSessionStore((state) => state.cashier);
    const can = useCan();

    const [type, setType] = useState<'cash_in' | 'cash_out'>('cash_in');
    const [amount, setAmount] = useState('');
    const [reason, setReason] = useState('');
    const [error, setError] = useState<string | null>(null);

    if (dialog?.kind !== 'cashMove') return null;

    const disabled = !can('cash.in_out') || session === null;

    return (
        <Dialog
            open
            onClose={close}
            title={t('reg.session.cashMoveTitle')}
            footer={
                <>
                    <Button variant="ghost" onClick={close}>
                        {t('common.cancel')}
                    </Button>
                    <Button
                        disabled={disabled || amount === ''}
                        onClick={async () => {
                            if (reason.trim() === '') {
                                setError(t('reg.session.reasonRequired'));
                                return;
                            }
                            if (session === null) return;
                            await recordCashMovement({
                                sessionId: session.id,
                                type,
                                amount: Decimal.of(amount).abs().withScale(2).toString(),
                                reason: reason.trim(),
                                employeeId: cashier?.employee_id ?? null,
                            });
                            close();
                        }}
                    >
                        {t('common.ok')}
                    </Button>
                </>
            }
        >
            <div className="space-y-3">
                <div className="flex gap-2">
                    {(['cash_in', 'cash_out'] as const).map((kind) => (
                        <Button
                            key={kind}
                            className="flex-1"
                            variant={type === kind ? 'primary' : 'secondary'}
                            onClick={() => setType(kind)}
                        >
                            {kind === 'cash_in' ? t('reg.session.cashIn') : t('reg.session.cashOut')}
                        </Button>
                    ))}
                </div>

                <div className="rounded-pos bg-slate-900 px-4 py-3 text-end font-mono text-3xl text-white">
                    {amount === '' ? '0' : amount}
                </div>

                <label className="grid gap-1">
                    <span className="font-semibold">{t('reg.session.reason')}</span>
                    <input
                        type="text"
                        className="min-h-touch-lg rounded-pos border border-slate-300 px-3"
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                    />
                </label>
                {error ? <p className="text-danger">{error}</p> : null}

                <NumPad value={amount} onChange={setAmount} mode="price" scannerGuardMs={0} />
            </div>
        </Dialog>
    );
}

/** Product info (REG-072). Everything shown here is computed locally so it opens offline. */
export function ProductInfoDialog(): JSX.Element | null {
    const t = useT();
    const money = useMoney();
    const catalog = useCatalog();
    const can = useCan();
    const dialog = useUiStore((state) => state.dialog);
    const close = useUiStore((state) => state.closeDialog);

    const productId = typeof dialog?.payload?.['productId'] === 'number' ? dialog.payload['productId'] : null;
    if (dialog?.kind !== 'productInfo' || productId === null) return null;

    const product = catalog.productsById.get(productId);
    if (!product) return null;
    const variant = catalog.defaultVariantByProduct.get(productId);
    const price = variant ? baseListPrice(catalog, variant.id) : product.list_price;
    const taxes = variant ? taxIdsFor(catalog, variant.id) : product.tax_ids;
    const margin = Decimal.of(price).sub(Decimal.of(product.standard_price));

    return (
        <Dialog open onClose={close} title={product.name} description={t('reg.products.info')}>
            <dl className="grid grid-cols-2 gap-2 text-base">
                <Info label={t('reg.products.reference')} value={product.default_code ?? '—'} />
                <Info label={t('reg.products.barcode')} value={product.barcode ?? '—'} />
                <Info label={t('reg.products.priceExcl')} value={money(price)} />
                <Info
                    label={t('reg.products.taxes')}
                    value={taxes.map((id) => catalog.taxes.get(id)?.name ?? `#${id}`).join(', ') || '—'}
                />
                {can('report.margins') ? (
                    <>
                        <Info label={t('reg.products.cost')} value={money(product.standard_price)} />
                        <Info label={t('reg.products.margin')} value={money(margin.withScale(2).toString())} />
                    </>
                ) : null}
                <Info label={t('reg.products.stock')} value={String(variant?.on_hand_qty ?? 0)} />
            </dl>
        </Dialog>
    );
}

function Info({ label, value }: { label: string; value: string }): JSX.Element {
    return (
        <div className={cn('rounded-pos bg-slate-50 p-2')}>
            <dt className="text-sm text-slate-500">{label}</dt>
            <dd className="font-semibold">{value}</dd>
        </div>
    );
}

/**
 * RST-143 — "these items have not gone to the kitchen; send them first?"
 *
 * Odoo asks the same question, and for the same reason: paying is the last moment anyone looks at
 * the order, so an unsent delta at this point is food that will never be cooked. The cashier gets
 * three honest choices — send then pay, pay anyway (a paid-for takeaway the kitchen already has on
 * paper), or go back.
 *
 * The prompt is a *question*, not a block: refusing to let a table pay because of a routing detail
 * is worse than the mistake it prevents.
 */
export function SendBeforePayDialog({
    onSend,
    onPay,
}: {
    onSend: () => Promise<boolean>;
    onPay: () => void;
}): JSX.Element | null {
    const t = useT();
    const dialog = useUiStore((state) => state.dialog);
    const close = useUiStore((state) => state.closeDialog);
    const orderUuid = useSelectedOrderUuid();

    if (dialog?.kind !== 'sendBeforePay' || orderUuid === null) return null;

    return (
        <Dialog
            open
            onClose={close}
            title={t('reg.order.sendBeforePayTitle')}
            footer={
                <>
                    <Button variant="ghost" onClick={close}>
                        {t('common.back')}
                    </Button>
                    <Button
                        variant="secondary"
                        onClick={() => {
                            close();
                            onPay();
                        }}
                    >
                        {t('reg.order.payAnyway')}
                    </Button>
                    <Button
                        onClick={async () => {
                            close();

                            // Await it, and only move on if the kitchen really has it. A send can be
                            // *refused* — `outdated` means another device fired this order first —
                            // and navigating anyway would drop the cashier on the payment screen
                            // with the delta still unsent: the exact state this prompt exists to
                            // prevent, now with a false belief that it was handled.
                            if (await onSend()) onPay();
                        }}
                    >
                        {t('reg.order.sendThenPay')}
                    </Button>
                </>
            }
        >
            <p className="text-slate-700">{t('reg.order.sendBeforePayBody')}</p>
        </Dialog>
    );
}
