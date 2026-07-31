import { Button, Dialog, cn } from '@shared/ui';
import type { JSX } from 'react';
import { useMemo, useState } from 'react';

import { useT } from '../../i18n';
import { attributeExtraOf, addLine } from '../../domain/order-actions';
import { excludedValueIds, matchVariant } from '../../domain/product-flow';
import { fullProductName } from '../../data/catalog';
import { useCatalog, useMoney, useSelectedOrderUuid } from '../../hooks/use-register';
import { useUiStore } from '../../state/ui-store';

/**
 * The product configurator (REG-073).
 *
 * Exclusions are honoured **live**: choosing "Large" greys out the sauces that cannot go with it,
 * rather than letting the cashier build an impossible combination and refusing at the end. Custom
 * values get a free-text input whose content rides on the line.
 */

export function VariantDialog(): JSX.Element | null {
    const t = useT();
    const money = useMoney();
    const catalog = useCatalog();
    const orderUuid = useSelectedOrderUuid();
    const dialog = useUiStore((state) => state.dialog);
    const close = useUiStore((state) => state.closeDialog);

    const productId = typeof dialog?.payload?.['productId'] === 'number' ? dialog.payload['productId'] : null;
    const quantity = typeof dialog?.payload?.['quantity'] === 'number' ? dialog.payload['quantity'] : 1;

    const lines = useMemo(
        () => (productId === null ? [] : (catalog.attributeLinesByProduct.get(productId) ?? [])),
        [catalog, productId],
    );

    const [chosen, setChosen] = useState<Record<number, number>>({});
    const [custom, setCustom] = useState<Record<number, string>>({});

    if (dialog?.kind !== 'variant' || productId === null || orderUuid === null) return null;

    const product = catalog.productsById.get(productId);
    const selectedIds = Object.values(chosen);
    const excluded = excludedValueIds(selectedIds);
    const missing = lines.filter((line) => line.is_required && chosen[line.id] === undefined);

    const confirm = (): void => {
        const variantId = matchVariant(productId, selectedIds);
        if (variantId === null) return;
        addLine({
            orderUuid,
            variantId,
            quantity,
            attributeLineValueIds: selectedIds,
            priceExtra: attributeExtraOf(selectedIds, catalog),
            customAttributeValues: Object.entries(custom)
                .filter(([, value]) => value.trim() !== '')
                .map(([valueId, value]) => ({
                    uuid: `${valueId}` as never,
                    value_id: Number.parseInt(valueId, 10),
                    custom_value: value,
                })),
            fullProductName: fullProductName(catalog, variantId, selectedIds),
            skipMerge: Object.keys(custom).length > 0,
        });
        setChosen({});
        setCustom({});
        close();
    };

    return (
        <Dialog
            open
            onClose={close}
            title={product?.name ?? t('reg.products.variantTitle')}
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
                {lines.map((line) => {
                    const attribute = catalog.attributes.get(line.product_attribute_id);
                    const values = catalog.attributeLineValuesByLine.get(line.id) ?? [];

                    return (
                        <fieldset key={line.id}>
                            <legend className="mb-2 font-semibold">
                                {attribute?.name}
                                {line.is_required ? ' *' : ''}
                            </legend>
                            <div className="flex flex-wrap gap-2">
                                {values.map((lineValue) => {
                                    const value = catalog.attributeValues.get(lineValue.product_attribute_value_id);
                                    const disabled = excluded.has(lineValue.id);
                                    const active = chosen[line.id] === lineValue.id;
                                    return (
                                        <button
                                            key={lineValue.id}
                                            type="button"
                                            disabled={disabled}
                                            onClick={() =>
                                                setChosen((current) => ({ ...current, [line.id]: lineValue.id }))
                                            }
                                            className={cn(
                                                'min-h-touch-lg rounded-pos px-4 font-semibold ring-1 ring-inset',
                                                active
                                                    ? 'bg-brand-600 text-white ring-brand-700'
                                                    : 'bg-white text-slate-800 ring-slate-300',
                                                disabled && 'cursor-not-allowed opacity-40',
                                            )}
                                            style={
                                                value?.html_color
                                                    ? { borderInlineStart: `8px solid ${value.html_color}` }
                                                    : undefined
                                            }
                                        >
                                            {value?.name}
                                            {lineValue.price_extra !== '0' && lineValue.price_extra !== '0.0000'
                                                ? ` (+${money(lineValue.price_extra)})`
                                                : ''}
                                        </button>
                                    );
                                })}
                            </div>

                            {values.some(
                                (lineValue) =>
                                    catalog.attributeValues.get(lineValue.product_attribute_value_id)?.is_custom &&
                                    chosen[line.id] === lineValue.id,
                            ) ? (
                                <input
                                    type="text"
                                    className="mt-2 min-h-touch w-full rounded-pos border border-slate-300 px-3"
                                    placeholder={t('reg.products.customValue')}
                                    value={custom[chosen[line.id] ?? 0] ?? ''}
                                    onChange={(event) =>
                                        setCustom((current) => ({
                                            ...current,
                                            [chosen[line.id] ?? 0]: event.target.value,
                                        }))
                                    }
                                />
                            ) : null}
                        </fieldset>
                    );
                })}

                {missing.length > 0 ? (
                    <p className="text-warn-fg">
                        {t('reg.products.variantRequired', {
                            name: catalog.attributes.get(missing[0]?.product_attribute_id ?? 0)?.name ?? '',
                        })}
                    </p>
                ) : null}
            </div>
        </Dialog>
    );
}
