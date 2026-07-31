import { distributeComboPrice } from '@domain/pricing/combo';
import { Button, Dialog, cn } from '@shared/ui';
import type { JSX } from 'react';
import { useMemo, useState } from 'react';

import { baseListPrice } from '../../data/catalog';
import { useT } from '../../i18n';
import { addLine } from '../../domain/order-actions';
import { useCatalog, useMoney, useSelectedOrderUuid } from '../../hooks/use-register';
import { useUiStore } from '../../state/ui-store';

/**
 * The combo configurator (REG-075).
 *
 * The price split is **not** ours to invent: `@domain/pricing/combo` distributes the parent price
 * across the children proportionally to each item's base price and pushes the rounding remainder
 * onto the last line. Any deviation breaks receipts, invoices and the closing report — which is
 * exactly why that algorithm lives in the parity-tested domain package and this dialog only feeds
 * it and writes the resulting lines.
 */

export function ComboDialog(): JSX.Element | null {
    const t = useT();
    const money = useMoney();
    const catalog = useCatalog();
    const orderUuid = useSelectedOrderUuid();
    const dialog = useUiStore((state) => state.dialog);
    const close = useUiStore((state) => state.closeDialog);

    const productId = typeof dialog?.payload?.['productId'] === 'number' ? dialog.payload['productId'] : null;
    const quantity = typeof dialog?.payload?.['quantity'] === 'number' ? dialog.payload['quantity'] : 1;

    const product = productId !== null ? catalog.productsById.get(productId) : undefined;
    const combos = useMemo(
        () =>
            (product?.combo_ids ?? [])
                .map((id) => catalog.combosById.get(id))
                .filter((combo): combo is NonNullable<typeof combo> => combo !== undefined),
        [catalog, product],
    );

    const [picked, setPicked] = useState<Record<number, number[]>>({});

    if (dialog?.kind !== 'combo' || !product || orderUuid === null) return null;

    const missing = combos.filter((combo) => (picked[combo.id] ?? []).length < Math.max(1, combo.qty_free));

    const toggle = (comboId: number, variantId: number, max: number): void => {
        setPicked((current) => {
            const list = current[comboId] ?? [];
            if (list.includes(variantId)) {
                return { ...current, [comboId]: list.filter((id) => id !== variantId) };
            }
            const next = max <= 1 ? [variantId] : [...list, variantId].slice(-max);
            return { ...current, [comboId]: next };
        });
    };

    const confirm = (): void => {
        const parentVariant = catalog.defaultVariantByProduct.get(product.id);
        if (!parentVariant) return;

        const components = combos.flatMap((combo) =>
            (picked[combo.id] ?? []).map((variantId) => {
                const item = (catalog.comboItemsByCombo.get(combo.id) ?? []).find(
                    (candidate) => candidate.product_variant_id === variantId,
                );
                return {
                    id: `${combo.id}:${variantId}`,
                    comboBasePrice: baseListPrice(catalog, variantId),
                    quantity: '1',
                    extraPrice: item?.extra_price ?? '0',
                    comboId: combo.id,
                    variantId,
                    comboItemId: item?.id ?? null,
                };
            }),
        );

        const parentPrice = baseListPrice(catalog, parentVariant.id);
        const shares = distributeComboPrice({
            parentPrice,
            precision: catalog.currency?.rounding ?? '0.01',
            components: components.map((component) => ({
                id: component.id,
                comboBasePrice: component.comboBasePrice,
                quantity: component.quantity,
                extraPrice: component.extraPrice,
            })),
        });

        const parentUuid = addLine({
            orderUuid,
            variantId: parentVariant.id,
            quantity,
            priceUnit: '0',
            priceType: 'manual',
            skipMerge: true,
        });

        for (const component of components) {
            const share = shares.find((row) => row.id === component.id);
            addLine({
                orderUuid,
                variantId: component.variantId,
                quantity,
                priceUnit: share?.priceUnit ?? '0',
                priceType: 'manual',
                comboParentUuid: parentUuid,
                comboId: component.comboId,
                comboItemId: component.comboItemId,
                skipMerge: true,
            });
        }

        setPicked({});
        close();
    };

    return (
        <Dialog
            open
            onClose={close}
            title={product.name}
            description={t('reg.products.comboTitle')}
            size="lg"
            footer={
                <>
                    <Button variant="ghost" onClick={close}>
                        {t('common.cancel')}
                    </Button>
                    <Button disabled={missing.length > 0} onClick={confirm}>
                        {t('reg.products.addToOrder')}
                    </Button>
                </>
            }
        >
            <div className="space-y-5">
                {combos.map((combo) => {
                    const max = Math.max(1, combo.qty_max || combo.qty_free || 1);
                    const items = catalog.comboItemsByCombo.get(combo.id) ?? [];
                    const selected = picked[combo.id] ?? [];

                    return (
                        <fieldset key={combo.id}>
                            <legend className="mb-2 font-semibold">
                                {t('reg.products.comboChoose', { count: max, name: combo.name })}
                            </legend>
                            <div className="grid grid-cols-2 gap-2 till:grid-cols-3">
                                {items.map((item) => {
                                    const variant = catalog.variantsById.get(item.product_variant_id);
                                    const active = selected.includes(item.product_variant_id);
                                    return (
                                        <button
                                            key={item.id}
                                            type="button"
                                            onClick={() => toggle(combo.id, item.product_variant_id, max)}
                                            className={cn(
                                                'min-h-touch-lg rounded-pos px-3 py-2 text-start font-semibold ring-1 ring-inset',
                                                active
                                                    ? 'bg-brand-600 text-white ring-brand-700'
                                                    : 'bg-white text-slate-800 ring-slate-300',
                                            )}
                                        >
                                            {variant?.display_name ?? '—'}
                                            {item.extra_price !== '0' && item.extra_price !== '0.0000' ? (
                                                <span className="block text-sm font-normal">
                                                    + {money(item.extra_price)}
                                                </span>
                                            ) : null}
                                        </button>
                                    );
                                })}
                            </div>
                        </fieldset>
                    );
                })}
            </div>
        </Dialog>
    );
}
