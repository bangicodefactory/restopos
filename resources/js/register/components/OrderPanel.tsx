import { Decimal } from '@domain/money/decimal';
import type { CourseRow, OrderLineRow } from '@domain/types';
import { useCan } from '@shared/auth';
import { Button, cn } from '@shared/ui';
import type { JSX } from 'react';
import { useMemo } from 'react';

import { useT } from '../i18n';
import { currentDelta } from '../domain/kitchen-send';
import { addCourse, prepKeyOf, reduceQuantity, removeLine, setPreset, setPricelist } from '../domain/order-actions';
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
    onSend: () => void;
    onFireCourse: (courseUuid: string) => void;
    onBill: () => void;
    onSplit: () => void;
    onTransfer: () => void;
    className?: string;
};

export function OrderPanel({
    orderUuid,
    onPay,
    onSend,
    onFireCourse,
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

    const table =
        order?.restaurant_table_id != null ? catalog.tablesById.get(order.restaurant_table_id) : undefined;

    const unsent = order ? currentDelta(order.uuid).nbrOfChanges : 0;

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
                        <select
                            aria-label={t('reg.order.preset')}
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
                    ) : null}
                    {catalog.pricelists.length > 0 ? (
                        // Re-prices every non-manual line (REG-173).
                        <select
                            aria-label={t('reg.order.pricelist')}
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
                        onClick={onPay}
                        className={restaurant ? '' : 'col-span-2'}
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
                <button type="button" className="min-h-touch text-brand-700 underline" onClick={onFire}>
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
