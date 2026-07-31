import { Button, Dialog, NumPad } from '@shared/ui';
import type { JSX } from 'react';
import { useState } from 'react';

import { useT } from '../../i18n';
import { addLine } from '../../domain/order-actions';
import { useCatalog, useSelectedOrderUuid } from '../../hooks/use-register';
import { useUiStore } from '../../state/ui-store';

/** Open-price entry (REG-104): the line is stamped `manual`, so a pricelist change never touches it. */
export function OpenPriceDialog(): JSX.Element | null {
    const t = useT();
    const catalog = useCatalog();
    const orderUuid = useSelectedOrderUuid();
    const dialog = useUiStore((state) => state.dialog);
    const close = useUiStore((state) => state.closeDialog);
    const [price, setPrice] = useState('');

    const variantId = typeof dialog?.payload?.['variantId'] === 'number' ? dialog.payload['variantId'] : null;
    const quantity = typeof dialog?.payload?.['quantity'] === 'number' ? dialog.payload['quantity'] : 1;
    if (dialog?.kind !== 'openPrice' || variantId === null || orderUuid === null) return null;

    const variant = catalog.variantsById.get(variantId);
    const valid = price !== '' && Number.isFinite(Number.parseFloat(price));

    return (
        <Dialog
            open
            onClose={close}
            title={t('reg.products.openPriceTitle')}
            description={variant?.display_name ?? ''}
            footer={
                <>
                    <Button variant="ghost" onClick={close}>
                        {t('common.cancel')}
                    </Button>
                    <Button
                        disabled={!valid}
                        onClick={() => {
                            addLine({
                                orderUuid,
                                variantId,
                                quantity,
                                priceUnit: price,
                                priceType: 'manual',
                                skipMerge: true,
                            });
                            setPrice('');
                            close();
                        }}
                    >
                        {t('reg.products.addToOrder')}
                    </Button>
                </>
            }
        >
            <div className="space-y-3">
                <div className="rounded-pos bg-slate-900 px-4 py-3 text-end font-mono text-3xl text-white">
                    {price === '' ? '0' : price}
                </div>
                <NumPad value={price} onChange={setPrice} mode="price" scannerGuardMs={0} />
            </div>
        </Dialog>
    );
}
