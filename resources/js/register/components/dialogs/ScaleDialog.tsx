import { WeightSource } from '@domain/enums';
import { Button, Dialog, NumPad } from '@shared/ui';
import { ScaleReader, resolveScaleTransport, type ScaleState } from '@shared/scale';
import type { JSX } from 'react';
import { useEffect, useMemo, useState } from 'react';

import { useT } from '../../i18n';
import { addLine, resolveUnitPrice } from '../../domain/order-actions';
import { isRepeatWeight, recordAcceptedWeight } from '../../domain/weighing';
import { useCatalog, useMoney, useOrder, useSelectedOrderUuid } from '../../hooks/use-register';
import { useUiStore } from '../../state/ui-store';

type ScaleStatusKey =
    | 'reg.products.scaleStable'
    | 'reg.products.scaleManual'
    | 'reg.products.scaleWaiting'
    | 'reg.products.scaleNotZeroed';

/**
 * The scale dialog (REG-077, XCT-058).
 *
 * Two rules govern a weighing, and separating them is what this ticket was really about:
 *
 *  - **The weight must change between two consecutive weighings of the same item on the same
 *    bill.** A legal-metrology requirement in France and Belgium, not a UX nicety: without it a
 *    cashier rings the same 200 g twice by tapping confirm, and inspectors test for it. It lives in
 *    `@register/domain/weighing`, scoped to (order, variant) — it used to be a module-level
 *    `let` shared by every product and every order for the lifetime of the page, which refused
 *    perfectly legitimate second sales and could never be cleared.
 *  - **A reading must be settled, and the pan must have been seen empty.** Only meaningful with a
 *    scale attached, so it lives in `@shared/scale`'s reader and applies only on the driver path.
 *
 * The dialog itself now does what its own copy has always claimed. Until this ticket the string
 * "Place the item on the scale, then confirm" was displayed while nothing polled anything and the
 * weight was typed on the numpad — the copy was simply untrue. It is shown on the driver path and
 * a different string is shown on the manual one.
 *
 * Which path runs is `pos_configs.iot_scale`, and the driver is only offered when a transport is
 * both configured and available in this browser. Manual entry is never taken away: it is the
 * fallback when the scale is off, unavailable, refused or broken, and the line records which of
 * the two produced its quantity (AC4).
 */
export function ScaleDialog(): JSX.Element | null {
    const t = useT();
    const money = useMoney();
    const catalog = useCatalog();
    const orderUuid = useSelectedOrderUuid();
    const order = useOrder(orderUuid);
    const dialog = useUiStore((state) => state.dialog);
    const close = useUiStore((state) => state.closeDialog);

    const [weight, setWeight] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [scale, setScale] = useState<ScaleState | null>(null);
    /** The cashier chose to type instead. Sticky for this dialog, so the reading stops overriding. */
    const [manual, setManual] = useState(false);

    const open = dialog?.kind === 'scale';
    const variantId = typeof dialog?.payload?.['variantId'] === 'number' ? dialog.payload['variantId'] : null;

    // Built once per open, from the config. `null` means no scale on this till, which is the
    // overwhelmingly common case and must cost nothing.
    const reader = useMemo(() => {
        if (!open) return null;
        const transport = resolveScaleTransport(catalog.config);
        return transport === null ? null : new ScaleReader({ transport });
    }, [open, catalog.config]);

    /**
     * Spec 03 §7.7: poll "while the weighing dialog is open, never otherwise". The cleanup is the
     * "never otherwise" half — without it the serial port stays open and read four times a second
     * for the rest of the shift, and no other application can take it.
     */
    useEffect(() => {
        if (reader === null) return undefined;

        const unsubscribe = reader.subscribe(setScale);
        void reader.start();

        return () => {
            unsubscribe();
            void reader.stop();
            setScale(null);
        };
    }, [reader]);

    if (!open || variantId === null || orderUuid === null || !order) return null;

    const variant = catalog.variantsById.get(variantId);
    const unitPrice = resolveUnitPrice(order, variantId, 1, catalog);

    // The driver is "live" only when it has a reading to give. Everything else — no transport, a
    // browser without WebSerial, a declined port, a dead cable — falls back to typing, which is
    // AC4's "manual entry is still possible" and is also the only sane failure mode for a till.
    const live = !manual && scale !== null && scale.status === 'live' ? scale : null;
    const source = live !== null ? WeightSource.Scale : WeightSource.Manual;

    const typed = Number.parseFloat(weight);
    const shown = live !== null ? live.netKg : Number.isFinite(typed) ? typed : 0;
    const canAccept = live !== null ? live.stable && live.zeroed && shown > 0 : shown > 0;

    const confirm = (): void => {
        if (!canAccept) return;

        // REG-077. Checked for both paths: the arithmetic rule does not care how the number was
        // produced, and the manual path is the one an operator would use to get round it.
        if (isRepeatWeight(orderUuid, variantId, shown)) {
            setError(t('reg.products.scaleUnchanged'));
            return;
        }

        recordAcceptedWeight(orderUuid, variantId, shown);
        addLine({
            orderUuid,
            variantId,
            quantity: shown,
            priceUnit: unitPrice,
            skipMerge: true,
            weightSource: source,
        });
        // Re-arms the reader's zero requirement: the next weighing on this dialog cannot be
        // accepted until the item actually comes off the pan.
        reader?.accepted();
        setWeight('');
        setError(null);
        close();
    };

    // Each line of the copy names the one thing that is stopping the confirm button, in the order
    // the guards fire. "Place the item on the scale, then confirm" as a permanent caption is what
    // this replaces, and it was untrue in every state including the one it described.
    const statusKey = ((): ScaleStatusKey => {
        if (live === null) return 'reg.products.scaleManual';
        if (!live.zeroed) return 'reg.products.scaleNotZeroed';
        if (!live.stable) return 'reg.products.scaleWaiting';
        return 'reg.products.scaleStable';
    })();

    return (
        <Dialog
            open
            onClose={close}
            title={t('reg.products.scaleTitle')}
            description={variant?.display_name ?? ''}
            footer={
                <>
                    <Button variant="ghost" onClick={close}>
                        {t('common.cancel')}
                    </Button>
                    <Button disabled={!canAccept} onClick={confirm} data-testid="scale-confirm">
                        {t('reg.products.addToOrder')}
                    </Button>
                </>
            }
        >
            <div className="space-y-3">
                <p className="text-slate-600" data-testid="scale-status">
                    {t(statusKey)}
                </p>

                <div
                    className="flex items-baseline justify-between rounded-pos bg-slate-900 px-4 py-3 text-white"
                    data-testid="scale-readout"
                    data-weight={shown.toFixed(3)}
                    data-weight-source={source}
                >
                    <span className="text-sm">{t('reg.products.weight')}</span>
                    <span className="font-mono text-3xl">{shown.toFixed(3)} kg</span>
                </div>

                <p className="text-end text-slate-600">
                    {money(unitPrice)} / kg ·{' '}
                    <strong>{money(canAccept ? (shown * Number.parseFloat(unitPrice)).toFixed(2) : '0')}</strong>
                </p>

                {error ? <p className="text-danger">{error}</p> : null}

                {live !== null ? (
                    <div className="flex gap-2">
                        <Button
                            variant="secondary"
                            className="flex-1"
                            data-testid="scale-tare"
                            onClick={() => void reader?.zero()}
                        >
                            {t('reg.products.scaleTare')}
                        </Button>
                        <Button
                            variant="ghost"
                            className="flex-1"
                            data-testid="scale-manual"
                            onClick={() => setManual(true)}
                        >
                            {t('reg.products.scaleEnterByHand')}
                        </Button>
                    </div>
                ) : (
                    <NumPad value={weight} onChange={setWeight} mode="quantity" decimals={3} scannerGuardMs={0} />
                )}
            </div>
        </Dialog>
    );
}
