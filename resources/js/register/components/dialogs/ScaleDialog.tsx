import { Button, Dialog, NumPad } from '@shared/ui';
import type { JSX } from 'react';
import { useState } from 'react';

import { useT } from '../../i18n';
import { addLine, resolveUnitPrice } from '../../domain/order-actions';
import { useCatalog, useMoney, useOrder, useSelectedOrderUuid } from '../../hooks/use-register';
import { useUiStore } from '../../state/ui-store';

/**
 * The scale dialog (REG-077).
 *
 * One rule is a **legal-metrology requirement** in France and Belgium, not a UX nicety: the weight
 * must change between two consecutive weighings, or the second is refused. Without it a cashier can
 * ring the same 200 g twice by tapping confirm, and that is a fraud vector inspectors test for.
 *
 * No electronic scale is wired in this build, so the weight is entered on the numpad; the guard
 * behaves identically either way, which is the point of putting it here rather than in a driver.
 */

let lastAcceptedWeight: number | null = null;

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

    const variantId = typeof dialog?.payload?.['variantId'] === 'number' ? dialog.payload['variantId'] : null;
    if (dialog?.kind !== 'scale' || variantId === null || orderUuid === null || !order) return null;

    const variant = catalog.variantsById.get(variantId);
    const unitPrice = resolveUnitPrice(order, variantId, 1, catalog);
    const parsed = Number.parseFloat(weight);
    const valid = Number.isFinite(parsed) && parsed > 0;

    const confirm = (): void => {
        if (!valid) return;
        if (lastAcceptedWeight !== null && Math.abs(lastAcceptedWeight - parsed) < 0.0005) {
            setError(t('reg.products.scaleUnchanged'));
            return;
        }
        lastAcceptedWeight = parsed;
        addLine({ orderUuid, variantId, quantity: parsed, priceUnit: unitPrice, skipMerge: true });
        setWeight('');
        setError(null);
        close();
    };

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
                    <Button disabled={!valid} onClick={confirm}>
                        {t('reg.products.addToOrder')}
                    </Button>
                </>
            }
        >
            <div className="space-y-3">
                <p className="text-slate-600">{t('reg.products.scaleStable')}</p>
                <div className="flex items-baseline justify-between rounded-pos bg-slate-900 px-4 py-3 text-white">
                    <span className="text-sm">{t('reg.products.weight')}</span>
                    <span className="font-mono text-3xl">{weight === '' ? '0.000' : weight} kg</span>
                </div>
                <p className="text-end text-slate-600">
                    {money(unitPrice)} / kg ·{' '}
                    <strong>{money(valid ? (parsed * Number.parseFloat(unitPrice)).toFixed(2) : '0')}</strong>
                </p>
                {error ? <p className="text-danger">{error}</p> : null}
                <NumPad value={weight} onChange={setWeight} mode="quantity" decimals={3} scannerGuardMs={0} />
            </div>
        </Dialog>
    );
}
