import { Button, Keyboard, NumPad, cn } from '@shared/ui';
import { useState, type JSX } from 'react';

import { Notice, Price, Screen } from './Brand';
import { QuantityStepper } from './ProductSheet';
import { useT } from '../i18n';
import type { Catalog } from '../catalog';
import type { Cart, CartIssue, CartTotals } from '../logic/cart';
import { childrenOf } from '../logic/cart';
import type { SelfOrderConfig } from '../types';

/**
 * The basket (SLF-031, SLF-033, SLF-095).
 *
 * Combo children are shown indented under their parent and are not independently editable — a
 * customer who wants a different drink in their meal deal re-opens the meal deal, because editing
 * one component in place would need a whole second stepper for no gain.
 *
 * The totals block obeys the venue's `iface_tax_included`: a tax-inclusive venue shows one number
 * and the tax as information; a tax-exclusive one shows base, tax and total as three lines.
 */

export type CartScreenProps = {
    catalog: Catalog;
    config: SelfOrderConfig;
    cart: Cart;
    totals: CartTotals;
    issues: CartIssue[];
    standNumber: string;
    customerNote: string;
    kiosk: boolean;
    submitting: boolean;
    error: string | null;
    onQuantity: (uuid: string, quantity: number) => void;
    onRemove: (uuid: string) => void;
    onEdit: (productId: number, uuid: string) => void;
    onStandNumber: (value: string) => void;
    onCustomerNote: (value: string) => void;
    onDismissIssues: () => void;
    onCheckout: () => void;
    onBack: () => void;
};

export function CartScreen(props: CartScreenProps): JSX.Element {
    const t = useT();
    const { cart, totals, catalog, config } = props;
    const [noteOpen, setNoteOpen] = useState(false);

    const parents = cart.lines.filter((line) => line.comboParentUuid === null);
    const empty = parents.length === 0;

    /** Kiosk table-tracker number (SLF-095): only asked for when a kiosk serves to a table. */
    const needsStand = props.kiosk && config.service_mode === 'table';

    return (
        <Screen
            title={t('so.cart.title')}
            onBack={props.onBack}
            footer={
                empty ? undefined : (
                    <Button
                        size="xl"
                        block
                        loading={props.submitting}
                        disabled={needsStand && props.standNumber === ''}
                        onClick={props.onCheckout}
                    >
                        <span className="flex w-full items-center justify-between">
                            <span>{t('so.cart.checkout')}</span>
                            <Price amount={totals.display} />
                        </span>
                    </Button>
                )
            }
        >
            {props.issues.length > 0 && (
                <div className="bg-warn-soft px-3 py-3 text-warn-fg">
                    <p className="text-lg font-bold">{t('so.cart.removedTitle')}</p>
                    <p className="text-base">
                        {t('so.cart.removedBody', { names: props.issues.map((issue) => issue.name).join(', ') })}
                    </p>
                    <Button variant="ghost" size="sm" onClick={props.onDismissIssues} className="mt-1">
                        {t('common.ok')}
                    </Button>
                </div>
            )}

            {props.error && <Notice tone="danger">{t(props.error)}</Notice>}

            {empty ? (
                <div className="flex flex-col items-center gap-3 px-6 py-20 text-center">
                    <p className="text-2xl font-bold">{t('so.cart.empty')}</p>
                    <p className="text-lg text-slate-500">{t('so.cart.emptyHint')}</p>
                    <Button size="lg" onClick={props.onBack}>
                        {t('so.cart.addMore')}
                    </Button>
                </div>
            ) : (
                <>
                    <ul className="divide-y divide-slate-200 bg-white">
                        {parents.map((line) => {
                            const children = childrenOf(cart, line.uuid);
                            return (
                                <li key={line.uuid} className="px-3 py-3">
                                    <div className="flex items-start gap-3">
                                        <div className="min-w-0 flex-1">
                                            <p className="text-lg font-bold leading-tight">{line.name}</p>
                                            {children.map((child) => (
                                                <p key={child.uuid} className="ps-3 text-base text-slate-500">
                                                    · {child.name}
                                                </p>
                                            ))}
                                            {line.note && (
                                                <p className="mt-1 rounded bg-warn-soft px-2 py-1 text-base font-semibold text-warn-fg">
                                                    {line.note}
                                                </p>
                                            )}
                                            <button
                                                type="button"
                                                onClick={() => props.onEdit(line.productId, line.uuid)}
                                                className="mt-1 min-h-touch text-base font-bold text-brand-700 underline"
                                            >
                                                {t('so.product.update')}
                                            </button>
                                        </div>
                                        <Price
                                            amount={lineTotal(totals, line.uuid, children.map((child) => child.uuid))}
                                            className="text-lg font-black"
                                        />
                                    </div>

                                    <div className="mt-2 flex items-center justify-between">
                                        <QuantityStepper
                                            value={line.quantity}
                                            onChange={(next) => props.onQuantity(line.uuid, next)}
                                        />
                                        <button
                                            type="button"
                                            onClick={() => props.onRemove(line.uuid)}
                                            className="min-h-touch px-3 text-base font-bold text-danger"
                                        >
                                            {t('so.cart.remove')}
                                        </button>
                                    </div>
                                </li>
                            );
                        })}
                    </ul>

                    <section className="mt-3 bg-white px-3 py-3">
                        {catalog.taxDisplay === 'subtotal' ? (
                            <>
                                <TotalRow label={t('so.cart.subtotal')} amount={totals.totalExcluded} />
                                <TotalRow label={t('so.cart.tax')} amount={totals.totalTax} />
                                <TotalRow label={t('so.cart.total')} amount={totals.totalIncluded} strong />
                            </>
                        ) : (
                            <>
                                <TotalRow label={t('so.cart.total')} amount={totals.totalIncluded} strong />
                                <p className="pt-1 text-end text-base text-slate-500">
                                    {t('so.cart.taxIncluded')} · <Price amount={totals.totalTax} />
                                </p>
                            </>
                        )}
                    </section>

                    {needsStand && (
                        <section className="mt-3 bg-white px-3 py-3">
                            <p className="text-lg font-bold">{t('so.cart.stand')}</p>
                            <p className="pb-2 text-base text-slate-500">{t('so.cart.standHint')}</p>
                            <p className="mb-2 min-h-touch-lg rounded-pos bg-slate-100 px-4 py-2 text-center font-mono text-3xl font-black">
                                {props.standNumber || '—'}
                            </p>
                            <NumPad
                                value={props.standNumber}
                                onChange={props.onStandNumber}
                                mode="plain"
                                decimals={0}
                            />
                        </section>
                    )}

                    <section className="mb-6 mt-3 bg-white px-3 py-3">
                        <button
                            type="button"
                            onClick={() => setNoteOpen((open) => !open)}
                            className="min-h-touch w-full text-start text-lg font-bold text-brand-700"
                        >
                            {t('so.product.note')}
                        </button>
                        {noteOpen && (
                            <>
                                <textarea
                                    value={props.customerNote}
                                    onChange={(event) => props.onCustomerNote(event.target.value)}
                                    readOnly={props.kiosk}
                                    rows={2}
                                    placeholder={t('so.product.notePlaceholder')}
                                    className="mt-2 w-full rounded-pos border border-slate-300 p-3 text-lg"
                                />
                                {props.kiosk && (
                                    <Keyboard
                                        value={props.customerNote}
                                        onChange={props.onCustomerNote}
                                        onSubmit={() => setNoteOpen(false)}
                                        layout="azerty"
                                    />
                                )}
                            </>
                        )}
                    </section>
                </>
            )}
        </Screen>
    );
}

function TotalRow({
    label,
    amount,
    strong,
}: {
    label: string;
    amount: string;
    strong?: boolean;
}): JSX.Element {
    return (
        <p className={cn('flex items-baseline justify-between py-1', strong ? 'text-2xl font-black' : 'text-lg')}>
            <span>{label}</span>
            <Price amount={amount} />
        </p>
    );
}

/** A combo's price lives on its children, so the row total is parent + children. */
function lineTotal(totals: CartTotals, uuid: string, childUuids: readonly string[]): string {
    const parts = [uuid, ...childUuids]
        .map((key) => Number.parseFloat(totals.lineTotals[key] ?? '0'))
        .filter((value) => Number.isFinite(value));
    const sum = parts.reduce((total, value) => total + value, 0);
    return sum.toFixed(2);
}
