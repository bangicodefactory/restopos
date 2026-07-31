import { Button, Keyboard, Sheet, cn } from '@shared/ui';
import { useMemo, useState, type JSX } from 'react';

import { Price, ProductImage } from './Brand';
import { useT } from '../i18n';
import type { Catalog, MenuProduct } from '../catalog';
import { productImageUrl, resolveVariant, taxIdsFor, variantUnitPrice } from '../catalog';
import type { CartDraft } from '../logic/cart';
import { displayUnitPrice } from '../logic/cart';
import {
    autoSelect,
    buildSteps,
    comboLineName,
    comboTotalPrice,
    isCombo,
    missingRequiredAttributes,
    toCartLines,
    toSimpleCartLine,
    togglePick,
    validateSelections,
    type ComboSelection,
    type ComboStep,
} from '../logic/combo';

/**
 * The product detail sheet and the combo stepper (SLF-027, SLF-029, SLF-030).
 *
 * One sheet, two behaviours, because a customer does not distinguish "this pizza has a size" from
 * "this menu has a main course" — both are "answer some questions, then add".
 *
 * Kiosk accessibility is not a variant here: every option is a ≥ 56 px button, nothing depends on
 * hover, the quantity stepper is two large targets rather than a slider, and the note field opens an
 * on-screen keyboard because a kiosk has no other one.
 */

export type ProductSheetProps = {
    catalog: Catalog;
    product: MenuProduct;
    ordering: boolean;
    kiosk: boolean;
    editing: boolean;
    onAdd: (draft: CartDraft, children: readonly CartDraft[]) => void;
    onClose: () => void;
};

export function ProductSheet(props: ProductSheetProps): JSX.Element {
    return isCombo(props.product) ? <ComboSheet {...props} /> : <SimpleSheet {...props} />;
}

// ─────────────────────────────────────────────────────────────────────────────

function SimpleSheet({ catalog, product, ordering, kiosk, editing, onAdd, onClose }: ProductSheetProps): JSX.Element {
    const t = useT();
    const [selected, setSelected] = useState<number[]>([]);
    const [quantity, setQuantity] = useState(1);
    const [note, setNote] = useState('');
    const [showKeyboard, setShowKeyboard] = useState(false);
    const [attempted, setAttempted] = useState(false);

    const lines = catalog.attributeLinesByProduct.get(product.id) ?? [];
    const missing = missingRequiredAttributes(catalog, product, selected);

    const variant = resolveVariant(catalog, product.id, selected);
    const rideAlong = selected.filter((id) => !(variant?.attributeLineValueIds ?? []).includes(id));
    const unit = variantUnitPrice(catalog, variant, product, rideAlong);
    const total = displayUnitPrice(unit, taxIdsFor(variant, product), catalog);

    const toggle = (lineId: number, valueId: number, multi: boolean): void => {
        setSelected((current) => {
            if (multi) {
                return current.includes(valueId)
                    ? current.filter((id) => id !== valueId)
                    : [...current, valueId];
            }
            const siblings = lines.find((line) => line.id === lineId)?.values.map((value) => value.id) ?? [];
            return [...current.filter((id) => !siblings.includes(id)), valueId];
        });
    };

    const add = (): void => {
        setAttempted(true);
        if (missing.length > 0) return;
        const draft = toSimpleCartLine(catalog, product, selected, quantity, note.trim() === '' ? null : note);
        if (draft) onAdd(draft, []);
    };

    return (
        <Sheet open onClose={onClose} title={product.name} side="bottom">
            <div className="flex flex-col gap-4">
                <div className="h-40 w-full overflow-hidden rounded-pos">
                    <ProductImage url={productImageUrl(catalog, product)} name={product.name} />
                </div>

                {product.description && <p className="text-lg text-slate-600">{product.description}</p>}

                {lines.map((line) => {
                    const attribute = catalog.attributesById.get(line.attributeId);
                    const multi = attribute?.displayType === 'multi';
                    const invalid = attempted && missing.includes(line.id);
                    return (
                        <fieldset key={line.id} className={cn(invalid && 'rounded-pos ring-2 ring-danger')}>
                            <legend className="pb-1 text-lg font-bold">
                                {attribute?.name}
                                {line.required && (
                                    <span className="ms-2 rounded bg-danger-soft px-2 py-0.5 text-sm font-bold text-danger-fg">
                                        {t('so.product.required')}
                                    </span>
                                )}
                            </legend>
                            <div className="flex flex-wrap gap-2">
                                {line.values.map((value) => {
                                    const active = selected.includes(value.id);
                                    return (
                                        <button
                                            key={value.id}
                                            type="button"
                                            onClick={() => toggle(line.id, value.id, multi)}
                                            aria-pressed={active}
                                            className={cn(
                                                'min-h-touch-lg rounded-pos px-4 text-lg font-bold ring-1 ring-inset',
                                                active
                                                    ? 'bg-brand-600 text-white ring-brand-600'
                                                    : 'bg-white text-slate-800 ring-slate-300',
                                            )}
                                        >
                                            {value.name}
                                            {Number.parseFloat(value.priceExtra) !== 0 && (
                                                <span className="ms-2 opacity-80">
                                                    +<Price amount={value.priceExtra} />
                                                </span>
                                            )}
                                        </button>
                                    );
                                })}
                            </div>
                        </fieldset>
                    );
                })}

                {ordering && (
                    <>
                        <div>
                            <p className="pb-1 text-lg font-bold">{t('so.product.note')}</p>
                            <textarea
                                value={note}
                                onFocus={() => kiosk && setShowKeyboard(true)}
                                onChange={(event) => setNote(event.target.value.slice(0, 240))}
                                placeholder={t('so.product.notePlaceholder')}
                                readOnly={kiosk}
                                rows={2}
                                className="w-full rounded-pos border border-slate-300 p-3 text-lg"
                            />
                            {kiosk && showKeyboard && (
                                <Keyboard
                                    value={note}
                                    onChange={setNote}
                                    onSubmit={() => setShowKeyboard(false)}
                                    layout="azerty"
                                    submitLabel={t('common.ok')}
                                />
                            )}
                        </div>

                        <QuantityStepper value={quantity} onChange={setQuantity} />
                    </>
                )}

                {attempted && missing.length > 0 && (
                    <p role="alert" className="rounded-pos bg-danger-soft px-3 py-2 text-lg font-bold text-danger-fg">
                        {t('so.product.chooseRequired', {
                            name:
                                catalog.attributesById.get(
                                    lines.find((line) => line.id === missing[0])?.attributeId ?? 0,
                                )?.name ?? '',
                        })}
                    </p>
                )}

                {ordering && (
                    <Button size="xl" block onClick={add}>
                        <span className="flex w-full items-center justify-between">
                            <span>{editing ? t('so.product.update') : t('so.product.add')}</span>
                            <Price amount={multiply(total, quantity)} />
                        </span>
                    </Button>
                )}
            </div>
        </Sheet>
    );
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * The combo stepper.
 *
 * Only choices that need a decision become steps: a choice with one non-configurable option and a
 * cap of one is auto-selected, so a "menu" whose drink is always water does not make anybody press
 * Next on a screen with a single button.
 */
function ComboSheet({ catalog, product, kiosk, editing, onAdd, onClose }: ProductSheetProps): JSX.Element {
    const t = useT();
    const steps = useMemo(() => buildSteps(catalog, product), [catalog, product]);
    const interactive = useMemo(() => steps.filter((step) => step.interactive), [steps]);

    const [selections, setSelections] = useState<ComboSelection[]>(() =>
        steps.flatMap((step) => autoSelect(step)),
    );
    const [index, setIndex] = useState(0);
    const [quantity, setQuantity] = useState(1);

    const step: ComboStep | undefined = interactive[index];
    const validity = validateSelections(steps, selections);
    const price = comboTotalPrice(catalog, product, steps, selections);
    const last = index >= interactive.length - 1;

    const pickFor = (option: ComboStep['options'][number]): ComboSelection => ({
        comboId: step?.combo.id ?? 0,
        comboItemId: option.item.id,
        variantId: option.item.variantId,
        productId: option.productId,
        name: option.name,
        attributeValueIds: [],
    });

    const add = (): void => {
        if (!validity.valid) return;
        const { parent, children } = toCartLines(catalog, product, steps, selections, quantity);
        onAdd({ ...parent, name: comboLineName(product, selections) }, children);
    };

    return (
        <Sheet open onClose={onClose} title={product.name} side="bottom">
            <div className="flex flex-col gap-4">
                {step ? (
                    <>
                        <p className="text-base font-semibold uppercase tracking-wide text-slate-500">
                            {t('so.combo.step', { current: index + 1, total: interactive.length })}
                        </p>
                        <h3 className="text-2xl font-black">
                            {step.qtyMax > 1
                                ? t('so.combo.chooseUpTo', { count: step.qtyMax })
                                : t('so.combo.choose', { name: step.combo.name })}
                        </h3>

                        <ul className={cn('grid gap-2', kiosk ? 'grid-cols-2' : 'grid-cols-1')}>
                            {step.options.map((option) => {
                                const picked = selections.some(
                                    (selection) =>
                                        selection.comboId === step.combo.id &&
                                        selection.comboItemId === option.item.id,
                                );
                                const free =
                                    selections.filter((selection) => selection.comboId === step.combo.id).length <
                                    step.qtyFree;
                                return (
                                    <li key={option.item.id}>
                                        <button
                                            type="button"
                                            disabled={!option.available}
                                            onClick={() => setSelections(togglePick(step, selections, pickFor(option)))}
                                            aria-pressed={picked}
                                            className={cn(
                                                'flex min-h-touch-xl w-full items-center justify-between gap-3 rounded-pos px-4 py-3',
                                                'text-start text-lg font-bold ring-1 ring-inset disabled:opacity-40',
                                                picked
                                                    ? 'bg-brand-600 text-white ring-brand-600'
                                                    : 'bg-white text-slate-900 ring-slate-300',
                                            )}
                                        >
                                            <span>{option.name}</span>
                                            <span className="shrink-0 text-base opacity-90">
                                                {Number.parseFloat(option.extraPrice) !== 0 ? (
                                                    <>
                                                        +<Price amount={option.extraPrice} />
                                                    </>
                                                ) : free ? (
                                                    t('so.combo.included')
                                                ) : null}
                                            </span>
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    </>
                ) : (
                    <>
                        <h3 className="text-2xl font-black">{t('so.combo.summary')}</h3>
                        <ul className="rounded-pos bg-slate-100 p-3">
                            {selections.map((selection) => (
                                <li key={`${selection.comboId}-${selection.comboItemId}`} className="py-1 text-lg">
                                    {selection.name}
                                </li>
                            ))}
                        </ul>
                    </>
                )}

                <QuantityStepper value={quantity} onChange={setQuantity} />

                <div className="flex gap-2">
                    {index > 0 && (
                        <Button variant="secondary" size="xl" onClick={() => setIndex(index - 1)}>
                            {t('common.back')}
                        </Button>
                    )}
                    {!last && interactive.length > 0 ? (
                        <Button size="xl" block onClick={() => setIndex(index + 1)}>
                            <span className="flex w-full items-center justify-between">
                                <span>{t('so.combo.next')}</span>
                                <Price amount={price} />
                            </span>
                        </Button>
                    ) : (
                        <Button size="xl" block onClick={add} disabled={!validity.valid}>
                            <span className="flex w-full items-center justify-between">
                                <span>{editing ? t('so.product.update') : t('so.product.add')}</span>
                                <Price amount={multiply(price, quantity)} />
                            </span>
                        </Button>
                    )}
                </div>
            </div>
        </Sheet>
    );
}

// ─────────────────────────────────────────────────────────────────────────────

export function QuantityStepper({
    value,
    onChange,
    min = 1,
}: {
    value: number;
    onChange: (next: number) => void;
    min?: number;
}): JSX.Element {
    const t = useT();
    return (
        <div className="flex items-center justify-between gap-4">
            <span className="text-lg font-bold">{t('so.product.quantity')}</span>
            <div className="flex items-center gap-3">
                <StepperButton label="−" onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min} />
                <span className="min-w-[3ch] text-center text-2xl font-black tabular-nums" aria-live="polite">
                    {value}
                </span>
                <StepperButton label="+" onClick={() => onChange(Math.min(99, value + 1))} disabled={value >= 99} />
            </div>
        </div>
    );
}

function StepperButton({
    label,
    onClick,
    disabled,
}: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
}): JSX.Element {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            aria-label={label === '+' ? 'plus' : 'minus'}
            className="size-touch-lg rounded-full bg-slate-100 text-3xl font-black text-slate-800 ring-1 ring-inset ring-slate-300 disabled:opacity-40"
        >
            {label}
        </button>
    );
}

/** Multiplying a decimal string by a small integer count, without floats in the result. */
function multiply(amount: string, quantity: number): string {
    const value = Number.parseFloat(amount);
    if (!Number.isFinite(value)) return amount;
    const decimals = (amount.split('.')[1] ?? '').length;
    return (value * quantity).toFixed(decimals);
}
