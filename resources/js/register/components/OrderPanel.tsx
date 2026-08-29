import { Decimal } from '@domain/money/decimal';
import type { CourseRow, OrderLineRow, PaymentMethodRow } from '@domain/types';
import { useCan } from '@shared/auth';
import { Button, cn } from '@shared/ui';
import type { JSX } from 'react';
import { useCallback, useMemo } from 'react';

import { tryRuntime } from '../data/runtime';
import { useT } from '../i18n';
import { fastPayVerdict, fastPaymentMethods } from '../domain/fast-payment';
import { currentDelta, hasReprintablePrep } from '../domain/kitchen-send';
import {
    addCourse,
    addPayment,
    commitPaidOrder,
    prepKeyOf,
    reduceQuantity,
    removeLine,
    setPreset,
    setPricelist,
} from '../domain/order-actions';
import { prefillAmount } from '../screens/PaymentScreen';
import { effectiveUnitPrice } from '../domain/totals';
import {
    useCatalog,
    useMoney,
    useOrder,
    useOrderCourses,
    useOrderLines,
    useTotals,
} from '../hooks/use-register';
import { useOrderStore } from '../state/order-store';
import { useUiStore } from '../state/ui-store';

/**
 * The order panel: lines, courses, totals and the action pad.
 *
 * Everything a line displays comes out of the single memoised `OrderTotalsView.perLine` map rather
 * than being recomputed per row (spec 03 §3.4.5). With a 60-line tab that is the difference between
 * one tax computation per keystroke and sixty.
 */

export type OrderPanelProps = {
    orderUuid: string | null;
    onPay: () => void;
    /** REG-209 — a one-tap tender settled without a trip to the payment screen. */
    onFastPaid: () => void;
    onSend: () => void;
    onFireCourse: (courseUuid: string) => void;
    /** KDS-059 — reprint the last kitchen ticket, without recomputing or re-sending the delta. */
    onReprintPrep: () => void;
    onBill: () => void;
    onSplit: () => void;
    onTransfer: () => void;
    className?: string;
};

export function OrderPanel({
    orderUuid,
    onPay,
    onFastPaid,
    onSend,
    onFireCourse,
    onReprintPrep,
    onBill,
    onSplit,
    onTransfer,
    className,
}: OrderPanelProps): JSX.Element {
    const t = useT();
    const can = useCan();
    const money = useMoney();
    const catalog = useCatalog();
    const order = useOrder(orderUuid);
    const lines = useOrderLines(orderUuid);
    const courses = useOrderCourses(orderUuid);
    const totals = useTotals(orderUuid);
    const selectedLineUuid = useOrderStore((state) => state.selectedLineUuid);
    const selectLine = useOrderStore((state) => state.selectLine);
    const openDialog = useUiStore((state) => state.openDialog);

    const restaurant = catalog.config?.is_restaurant === true;

    const changed = useMemo(() => {
        if (!order) return new Set<string>();
        const delta = currentDelta(order.uuid);
        return new Set(delta.changes.map((change) => change.lineUuid));
    }, [order]);

    const grouped = useMemo(() => {
        if (courses.length === 0) return [{ course: null as CourseRow | null, lines }];
        const groups = courses.map((course) => ({
            course: course as CourseRow | null,
            lines: lines.filter((line) => line.course_uuid === course.uuid),
        }));
        const orphans = lines.filter((line) => line.course_uuid === null);
        if (orphans.length > 0) groups.push({ course: null, lines: orphans });
        return groups;
    }, [courses, lines]);

    /**
     * The course the waiter is most likely to want next (RST-090): the first unfired one that has
     * something on it.
     *
     * Firing lives on the course header, which is fine while you are looking at the lines and no use
     * at all once the order is long enough to scroll — the header is off screen exactly when the
     * kitchen is waiting. Promoted here so the action is where the hands already are.
     */
    const nextCourse = useMemo(
        () => grouped.find((group) => group.course && !group.course.fired && group.lines.length > 0)?.course ?? null,
        [grouped],
    );

    const table =
        order?.restaurant_table_id != null ? catalog.tablesById.get(order.restaurant_table_id) : undefined;

    const unsent = order ? currentDelta(order.uuid).nbrOfChanges : 0;

    const payNeedsPrompt = needsKitchenPromptBeforePay({ restaurant, unsent });

    // REG-209 — the config flag and the pivot behind these have been in the schema and the back
    // office since the config tables were written; nothing read them until now.
    const fastMethods = fastPaymentMethods(catalog.config, catalog.paymentMethods);

    /**
     * Settle in one tap.
     *
     * Runs the same RST-143 gate as Pay, deliberately: fast payment is the easiest possible way to
     * settle for food the kitchen was never told about, which is the failure that prompt exists to
     * prevent. Awaited to the flush for the REG-217 reason — a crash between "paid" and "written"
     * loses the sale, and the 250 ms debounce is exactly long enough for that.
     */
    const fastPay = useCallback(
        async (method: PaymentMethodRow) => {
            if (order === null) return;

            const verdict = fastPayVerdict({ lines, restaurant, unsent });

            if (!verdict.ok) {
                if (verdict.reason === 'ask_kitchen') openDialog('sendBeforePay', {});

                return;
            }

            addPayment(order.uuid, method.id, prefillAmount(totals.due, method, catalog.cashRounding));

            const runtime = tryRuntime();
            const flushed = await commitPaidOrder(
                order.uuid,
                runtime
                    ? { flushNow: runtime.persistence.flushNow, drain: () => runtime.syncer.drain() }
                    : null,
            );

            if (flushed) onFastPaid();
        },
        [catalog.cashRounding, lines, onFastPaid, openDialog, order, restaurant, totals.due, unsent],
    );

    return (
        <section className={cn('flex min-h-0 flex-col bg-white', className)} aria-label={t('reg.nav.order')}>
            <header className="flex items-center gap-2 border-b border-slate-200 px-3 py-2">
                <div className="min-w-0 flex-1">
                    <p className="truncate text-base font-semibold">
                        {table
                            ? t('reg.order.tableName', { name: table.table_number })
                            : (order?.floating_order_name ?? t('reg.order.directSale'))}
                    </p>
                    <p className="truncate text-xs text-slate-500">{order?.receipt_number ?? '—'}</p>
                </div>

                <Button size="sm" variant="secondary" onClick={() => openDialog('customer')}>
                    {order?.customer_id ? '👤 ✓' : t('reg.customer.title')}
                </Button>

                {restaurant ? (
                    <Button size="sm" variant="secondary" onClick={() => openDialog('guests')}>
                        {t('reg.order.guests')}: {order?.guest_count ?? 0}
                    </Button>
                ) : null}
            </header>

            {orderUuid !== null && (catalog.presets.length > 0 || catalog.pricelists.length > 0) ? (
                <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-1.5 text-sm">
                    {restaurant && catalog.presets.length > 0 ? (
                        // Dine-in / takeaway. Switching re-applies the preset's pricelist + fiscal
                        // position, which changes the VAT charged (REG-335/336).
                        <label className="flex min-w-0 flex-1 items-center gap-1">
                            <span className="shrink-0 text-slate-500">{t('reg.order.preset')}</span>
                            <select
                                className="min-h-touch min-w-0 flex-1 rounded-pos border border-slate-300 bg-white px-2"
                                value={order?.pos_preset_id ?? ''}
                                onChange={(event) => setPreset(orderUuid, event.target.value === '' ? null : Number(event.target.value))}
                            >
                                <option value="">{t('reg.order.presetNone')}</option>
                                {catalog.presets.map((preset) => (
                                    <option key={preset.id} value={preset.id}>
                                        {preset.name}
                                    </option>
                                ))}
                            </select>
                        </label>
                    ) : null}
                    {catalog.pricelists.length > 0 ? (
                        // Re-prices every non-manual line (REG-173).
                        <label className="flex min-w-0 flex-1 items-center gap-1">
                            <span className="shrink-0 text-slate-500">{t('reg.order.pricelist')}</span>
                            <select
                                className="min-h-touch min-w-0 flex-1 rounded-pos border border-slate-300 bg-white px-2"
                                value={order?.pricelist_id ?? ''}
                                onChange={(event) => setPricelist(orderUuid, event.target.value === '' ? null : Number(event.target.value))}
                            >
                                <option value="">{t('reg.order.pricelistDefault')}</option>
                                {catalog.pricelists.map((pricelist) => (
                                    <option key={pricelist.id} value={pricelist.id}>
                                        {pricelist.name}
                                    </option>
                                ))}
                            </select>
                        </label>
                    ) : null}
                </div>
            ) : null}

            <div className="min-h-0 flex-1 overflow-auto">
                {lines.length === 0 ? (
                    <p className="p-6 text-center text-slate-500">{t('reg.order.empty')}</p>
                ) : (
                    grouped.map((group, index) => {
                        const course = group.course;
                        return (
                            <div key={course?.uuid ?? `plain-${index}`}>
                                {course ? (
                                    <CourseHeader course={course} onFire={() => onFireCourse(course.uuid)} />
                                ) : null}
                            <ul>
                                {group.lines.map((line) => (
                                    <LineRow
                                        key={line.uuid}
                                        line={line}
                                        selected={line.uuid === selectedLineUuid}
                                        changed={changed.has(line.uuid)}
                                        sent={
                                            (order?.last_prep_snapshot?.lines[prepKeyOf(line)] ?? 0) > 0
                                        }
                                        total={money(
                                            catalog.config?.iface_tax_included === 'total'
                                                ? (totals.perLine[line.uuid]?.priceTotal ?? '0')
                                                : (totals.perLine[line.uuid]?.priceSubtotal ?? '0'),
                                        )}
                                        unitPrice={money(effectiveUnitPrice(line))}
                                        onSelect={() => selectLine(line.uuid)}
                                        onNotes={() => {
                                            selectLine(line.uuid);
                                            openDialog('notes', { lineUuid: line.uuid });
                                        }}
                                        onRemove={() => removeLine(line.uuid)}
                                        onDecrement={() => reduceQuantity(line.uuid, line.quantity - 1)}
                                    />
                                ))}
                            </ul>
                            </div>
                        );
                    })
                )}
            </div>

            <footer className="border-t border-slate-200 px-3 py-2">
                <dl className="mb-2 space-y-0.5 text-sm">
                    <Row label={t('reg.order.subtotal')} value={money(totals.subtotal)} />
                    {Decimal.of(totals.discountTotal).isZero() ? null : (
                        <Row label={t('reg.order.discountTotal')} value={`- ${money(totals.discountTotal)}`} />
                    )}
                    <Row label={t('reg.order.taxes')} value={money(totals.tax)} />
                    {Decimal.of(totals.rounding).isZero() ? null : (
                        <Row label={t('reg.order.rounding')} value={money(totals.rounding)} />
                    )}
                    <div className="flex items-baseline justify-between pt-1">
                        <dt className="text-lg font-semibold">{t('reg.order.total')}</dt>
                        <dd className="text-2xl font-bold tabular-nums">{money(totals.roundedTotal)}</dd>
                    </div>
                </dl>

                {restaurant && nextCourse ? (
                    <Button
                        size="md"
                        className="mb-2 w-full"
                        data-testid="fire-next-course"
                        onClick={() => onFireCourse(nextCourse.uuid)}
                    >
                        {t('reg.order.fireCourse', { index: nextCourse.index })}
                    </Button>
                ) : null}

                {restaurant ? (
                    <Button
                        size="md"
                        variant="secondary"
                        className="mb-2 w-full"
                        disabled={orderUuid === null || lines.length === 0}
                        onClick={() => orderUuid !== null && addCourse(orderUuid)}
                    >
                        {t('reg.order.addCourse')}
                    </Button>
                ) : null}

                {/*
                 * KDS-059 — the printer jammed and the kitchen never got the paper.
                 *
                 * Disabled until this till has actually rendered a prep ticket for the order:
                 * offering "reprint" for an order that was never sent promises the cashier a piece
                 * of paper that does not exist. Read straight rather than memoised, because the
                 * retention lives in module memory and a stale `false` here is a button that will
                 * not work when it is needed.
                 */}
                {restaurant ? (
                    <Button
                        size="md"
                        variant="secondary"
                        className="mb-2 w-full"
                        data-testid="reprint-prep"
                        disabled={orderUuid === null || !hasReprintablePrep(orderUuid)}
                        onClick={onReprintPrep}
                    >
                        {t('reg.order.reprintPrep')}
                    </Button>
                ) : null}

                <div className="grid grid-cols-4 gap-2">
                    <Button size="md" variant="secondary" onClick={() => openDialog('notes', {})}>
                        {t('reg.order.orderNote')}
                    </Button>
                    <Button size="md" variant="secondary" onClick={onBill}>
                        {t('reg.order.bill')}
                    </Button>
                    {restaurant ? (
                        <Button
                            size="md"
                            variant="secondary"
                            disabled={!can('bill.split') || lines.length === 0}
                            onClick={onSplit}
                        >
                            {t('reg.order.split')}
                        </Button>
                    ) : (
                        <span />
                    )}
                    {restaurant ? (
                        <Button
                            size="md"
                            variant="secondary"
                            disabled={!can('table.transfer')}
                            onClick={onTransfer}
                        >
                            {t('reg.order.transfer')}
                        </Button>
                    ) : (
                        <span />
                    )}
                </div>

                {fastMethods.length > 0 ? (
                    <div className="mt-2 grid grid-cols-2 gap-2" data-testid="fast-payment">
                        {fastMethods.map((method) => (
                            <Button
                                key={method.id}
                                size="xl"
                                variant="secondary"
                                disabled={lines.length === 0}
                                onClick={() => void fastPay(method)}
                            >
                                {method.name}
                            </Button>
                        ))}
                    </div>
                ) : null}

                <div className="mt-2 grid grid-cols-2 gap-2">
                    {restaurant ? (
                        <Button size="xl" variant={unsent > 0 ? 'primary' : 'secondary'} onClick={onSend}>
                            {t('reg.order.sendToKitchen')}
                            {unsent > 0 ? ` (${unsent})` : ''}
                        </Button>
                    ) : (
                        <span />
                    )}
                    <Button
                        size="xl"
                        variant="success"
                        disabled={lines.length === 0}
                        onClick={() => (payNeedsPrompt ? openDialog('sendBeforePay', {}) : onPay())}
                        className={restaurant ? '' : 'col-span-2'}
                        // Doubles as the order's running total, which is the cheapest thing for a
                        // spec to assert — and `data-order-total` carries the raw value, so an
                        // assertion need not parse a localised, currency-formatted string.
                        data-testid="order-total"
                        data-order-total={totals.roundedTotal}
                    >
                        {t('reg.order.pay')} · {money(totals.roundedTotal)}
                    </Button>
                </div>
            </footer>
        </section>
    );
}

function Row({ label, value }: { label: string; value: string }): JSX.Element {
    return (
        <div className="flex justify-between text-slate-600">
            <dt>{label}</dt>
            <dd className="tabular-nums">{value}</dd>
        </div>
    );
}

function CourseHeader({ course, onFire }: { course: CourseRow; onFire: () => void }): JSX.Element {
    const t = useT();
    return (
        <div className="flex items-center justify-between bg-slate-100 px-3 py-1.5 text-sm font-semibold">
            <span>{course.name ?? t('reg.order.course', { index: course.index })}</span>
            {course.fired ? (
                <span className="rounded-full bg-ok-soft px-2 py-0.5 text-xs text-ok-fg">{t('reg.order.fired')}</span>
            ) : (
                <button
                    type="button"
                    className="min-h-touch text-brand-700 underline"
                    onClick={onFire}
                    // The label is "Lancer le service N" here but the whole-order button reads
                    // "Envoyer (N)", and which one exists depends on how many courses there are —
                    // so a spec written against either label is wrong half the time (BAN-505).
                    data-testid="course-fire"
                    data-course-index={course.index}
                >
                    {t('reg.order.fireCourse', { index: course.index })}
                </button>
            )}
        </div>
    );
}

function LineRow({
    line,
    selected,
    changed,
    sent,
    total,
    unitPrice,
    onSelect,
    onNotes,
    onRemove,
    onDecrement,
}: {
    line: OrderLineRow;
    selected: boolean;
    changed: boolean;
    sent: boolean;
    total: string;
    unitPrice: string;
    onSelect: () => void;
    onNotes: () => void;
    onRemove: () => void;
    onDecrement: () => void;
}): JSX.Element {
    const t = useT();
    const notes = [line.customer_note, ...(line.internal_note ?? []).map((note) => note.text)].filter(
        (value): value is string => typeof value === 'string' && value !== '',
    );

    return (
        <li
            data-testid="order-line"
            data-line-uuid={line.uuid}
            data-product-id={line.product_id}
            className={cn(
                'flex items-start gap-2 border-b border-slate-100 px-3 py-2',
                selected && 'bg-brand-50 ring-1 ring-inset ring-brand-300',
                changed && 'border-l-4 border-l-warn',
                line.combo_parent_uuid !== null && 'ps-8',
            )}
        >
            <button type="button" className="min-w-0 flex-1 text-left" onClick={onSelect}>
                <p className="truncate font-semibold text-slate-900">{line.full_product_name}</p>
                <p className="text-sm text-slate-600 tabular-nums">
                    {line.quantity} × {unitPrice}
                    {Decimal.of(line.discount_percent).isZero() ? '' : ` · −${line.discount_percent} %`}
                    {sent ? ' · ✓' : ''}
                </p>
                {notes.length > 0 ? (
                    <p className="truncate text-sm italic text-warn-fg">{notes.join(' · ')}</p>
                ) : null}
            </button>

            <span className="w-24 shrink-0 text-right font-semibold tabular-nums">{total}</span>

            <div className="flex shrink-0 flex-col gap-1">
                <button
                    type="button"
                    aria-label={t('reg.order.notesTitle')}
                    className="min-h-touch min-w-touch rounded-pos text-lg hover:bg-slate-100"
                    onClick={onNotes}
                >
                    ✎
                </button>
                <button
                    type="button"
                    aria-label={t('reg.order.deleteLine')}
                    className="min-h-touch min-w-touch rounded-pos text-lg text-danger hover:bg-danger-soft"
                    onClick={sent ? onDecrement : onRemove}
                >
                    {sent ? '−' : '×'}
                </button>
            </div>
        </li>
    );
}

/**
 * RST-143 — should Pay ask before skipping the kitchen?
 *
 * Paying went straight to the payment screen, so a table could settle for food the kitchen was
 * never told about: the delta stays unsent, the order is marked paid, and nothing is cooked. The
 * count was already on screen next to Send; it just never gated anything.
 *
 * Only in restaurant mode — a counter sale has no kitchen step to skip.
 *
 * Exported as a plain predicate so it is testable without rendering, which is the house pattern
 * (`quickAmountsFor`, `settlesOrder`, `aggregateState`): keep the decision out of the JSX and
 * unit-test it directly. `OrderPanel.test.tsx` then covers the wiring through the DOM — the claim
 * that once stood here, that the repo has no component-testing library, stopped being true when
 * that file was added.
 */
export function needsKitchenPromptBeforePay({
    restaurant,
    unsent,
}: {
    restaurant: boolean;
    unsent: number;
}): boolean {
    return restaurant && unsent > 0;
}
