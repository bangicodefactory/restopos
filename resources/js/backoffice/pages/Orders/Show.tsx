/**
 * `Orders/Show` — `GET /orders/{order}` (BOF-131…BOF-149).
 *
 * A settled order is an audit record, not a document you edit, so this screen is read-only apart
 * from the manager-gated actions at the top. Everything an operator asks of it — "what was on
 * this ticket", "who took the money", "why does the tax not match", "was it touched after it was
 * rung up" — is answerable without leaving the page.
 *
 * Three details that are easy to get wrong and matter:
 *
 *  - **Two different `tax_details`.** The order carries one row per tax *group* (what the ticket
 *    prints); each line carries one row per *tax*. They are shown as two tables, labelled, rather
 *    than merged into a single "taxes" block that would silently double-count a compound chain.
 *  - **Change is a payment.** `pos_payments` stores the change given as a negative row with
 *    `is_change`. The payments table shows it as such and the reconciliation strip below adds
 *    them the way the drawer does, so paid − change = net, always from the stored decimals.
 *  - **Edit history is what the schema records**, no more: `is_edited`, `has_deleted_line`,
 *    `print_count`, and the client/sync timestamps. There is no per-field audit log in the
 *    contract, so none is invented.
 *
 * **Actions.** `can.void` and `can.refund` arrive from the policy, but `routes/web.php` exposes
 * no endpoint for void, refund, reprint or invoice (spec 05 §15). Rather than post to a URL that
 * 404s, those buttons are rendered disabled with the reason on them and behind a confirmation
 * dialog wired and ready, so the day the route lands only the handler changes. "Imprimer" does
 * work: it prints this page, which needs no server route at all.
 */

import { Head, Link } from '@inertiajs/react';
import { Button, FOCUS_RING, cn } from '@shared/ui';
import { useMemo, useState, type JSX, type ReactNode } from 'react';

import { ConfirmAction } from '../../components/ui/ConfirmAction';
import { AppLayout } from '../../components/layout/AppLayout';
import { Tabs, type TabItem } from '../../components/ui/Tabs';
import {
    Badge,
    Card,
    CardBody,
    CardHeader,
    DefinitionList,
    EmptyState,
    Notice,
    Stat,
} from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { dateTime } from '../../lib/format';
import { EUR, money, percent, quantity, subtractMoney, sumMoney, toDecimal } from '../../lib/money';
import { routes } from '../../lib/routes';

import {
    ORDER_SOURCE_LABEL,
    ORDER_STATE_TONE,
    type LineTaxDetail,
    type OrderLineRecord,
    type OrderShowProps,
} from './types';

export default function OrderShow({ order, lines, payments, courses, can }: OrderShowProps): JSX.Element {
    const t = useT();
    const [tab, setTab] = useState('lines');

    const visibleLines = useMemo(() => lines.filter((line) => line.deleted_at === null), [lines]);
    const deletedLines = useMemo(() => lines.filter((line) => line.deleted_at !== null), [lines]);

    /** Per-tax roll-up across the lines: the "why does the group total say that" answer. */
    const byTax = useMemo(() => {
        const buckets = new Map<number, { base: string; amount: string }>();
        for (const line of visibleLines) {
            for (const detail of line.tax_details ?? []) {
                const current = buckets.get(detail.taxId) ?? { base: '0', amount: '0' };
                buckets.set(detail.taxId, {
                    base: sumMoney([current.base, detail.base]),
                    amount: sumMoney([current.amount, detail.amount]),
                });
            }
        }
        return [...buckets.entries()].map(([taxId, value]) => ({ taxId, ...value }));
    }, [visibleLines]);

    const changeTotal = useMemo(
        () => sumMoney(payments.filter((payment) => payment.is_change).map((payment) => payment.amount)),
        [payments],
    );
    const grossPaid = useMemo(
        () => sumMoney(payments.filter((payment) => !payment.is_change).map((payment) => payment.amount)),
        [payments],
    );

    const title = t('order.detail', { name: order.name ?? `#${order.id}` });

    const tabs: TabItem[] = [
        { id: 'lines', label: t('order.lines'), badge: <Badge>{visibleLines.length}</Badge> },
        { id: 'payments', label: t('order.payments'), badge: <Badge>{payments.length}</Badge> },
        { id: 'taxes', label: t('order.taxes') },
        { id: 'courses', label: t('order.courses'), badge: <Badge>{courses.length}</Badge> },
        { id: 'audit', label: t('order.audit') },
    ];

    return (
        <AppLayout
            title={title}
            breadcrumbs={[{ label: t('order.title'), href: routes.orders.index() }]}
            actions={<OrderActions can={can} />}
        >
            <Head title={title} />

            <div className="space-y-6">
                <OrderHeader
                    stateBadge={
                        <Badge tone={ORDER_STATE_TONE[order.state] ?? 'neutral'}>{order.state}</Badge>
                    }
                    order={order}
                />

                {/* headline amounts */}
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                    <Stat label={t('report.total')} value={money(order.amount_total, EUR)} tone="ok" icon="€" />
                    <Stat
                        label={t('report.base')}
                        value={money(order.amount_untaxed, EUR)}
                        hint={`${t('report.taxAmount')} ${money(order.amount_tax, EUR)}`}
                    />
                    <Stat
                        label={t('order.payments')}
                        value={money(order.amount_paid, EUR)}
                        hint={`${t('order.change')} ${money(order.amount_change, EUR)}`}
                        tone="info"
                    />
                    <Stat
                        label={t('order.due')}
                        value={money(order.amount_due, EUR)}
                        tone={toDecimal(order.amount_due).isZero() ? 'neutral' : 'danger'}
                        hint={
                            toDecimal(order.amount_rounding).isZero()
                                ? undefined
                                : `${t('order.rounding')} ${money(order.amount_rounding, EUR)}`
                        }
                    />
                </div>

                {order.is_edited || order.has_deleted_line ? (
                    <Notice tone="warn">
                        <span className="flex flex-wrap gap-2">
                            {order.is_edited ? <Badge tone="warn">{t('order.edited')}</Badge> : null}
                            {order.has_deleted_line ? <Badge tone="warn">{t('order.hasDeletedLine')}</Badge> : null}
                        </span>
                    </Notice>
                ) : null}

                <Card>
                    <CardBody>
                        <Tabs items={tabs} active={tab} onChange={setTab} label={title}>
                            {tab === 'lines' ? (
                                <LinesTable lines={visibleLines} deleted={deletedLines} order={order} />
                            ) : null}

                            {tab === 'payments' ? (
                                <PaymentsTable
                                    payments={payments}
                                    grossPaid={grossPaid}
                                    changeTotal={changeTotal}
                                />
                            ) : null}

                            {tab === 'taxes' ? <TaxTables order={order} byTax={byTax} /> : null}

                            {tab === 'courses' ? <CoursesTable courses={courses} /> : null}

                            {tab === 'audit' ? <AuditPanel order={order} /> : null}
                        </Tabs>
                    </CardBody>
                </Card>
            </div>
        </AppLayout>
    );
}

// ───────────────────────────────────────────────────────────── header

function OrderHeader({
    order,
    stateBadge,
}: {
    order: OrderShowProps['order'];
    stateBadge: ReactNode;
}): JSX.Element {
    const t = useT();

    return (
        <Card>
            <CardHeader
                title={
                    <span className="flex flex-wrap items-center gap-2">
                        {order.name ?? `#${order.id}`}
                        {stateBadge}
                        {order.is_refund ? <Badge tone="danger">{t('report.refunds')}</Badge> : null}
                        {order.split_letter ? <Badge tone="info">{order.split_letter}</Badge> : null}
                    </span>
                }
                description={`${ORDER_SOURCE_LABEL[order.source] ?? order.source} · ${dateTime(order.ordered_at)}`}
                actions={
                    <Link
                        href={routes.sessions.show(order.pos_session_id)}
                        className={cn('rounded-pos px-2 py-1 text-sm text-brand-700 hover:underline', FOCUS_RING)}
                    >
                        {t('session.detail', { name: `#${order.pos_session_id}` })}
                    </Link>
                }
            />
            <CardBody>
                <DefinitionList
                    columns={3}
                    items={[
                        { label: t('order.receipt'), value: order.receipt_number ?? '—' },
                        { label: t('order.tracking'), value: order.tracking_number ?? '—' },
                        { label: t('order.table'), value: order.restaurant_table_id ?? '—' },
                        { label: t('order.guests'), value: order.guest_count },
                        { label: 'Employé', value: order.employee_id ?? '—' },
                        { label: 'Client', value: order.customer_id ?? order.customer_email ?? '—' },
                        { label: 'Payée le', value: dateTime(order.paid_at) },
                        { label: 'Clôturée le', value: dateTime(order.closed_at) },
                        { label: 'Annulée le', value: dateTime(order.cancelled_at) },
                        ...(order.cancel_reason
                            ? [{ label: 'Motif d’annulation', value: order.cancel_reason, wide: true }]
                            : []),
                        ...(order.general_customer_note
                            ? [{ label: 'Note client', value: order.general_customer_note, wide: true }]
                            : []),
                        ...(order.internal_note
                            ? [{ label: 'Note interne', value: order.internal_note, wide: true }]
                            : []),
                    ]}
                />
            </CardBody>
        </Card>
    );
}

// ───────────────────────────────────────────────────────────── actions

function OrderActions({ can }: { can: OrderShowProps['can'] }): JSX.Element {
    const t = useT();
    const unavailable = t('order.actionsUnavailable');
    const noop = (): void => undefined;

    return (
        <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="md" onClick={() => globalThis.print()}>
                {t('action.print')}
            </Button>

            <ConfirmAction
                label={t('order.refund')}
                title={t('order.refund')}
                message={unavailable}
                onConfirm={noop}
                disabled={!can.refund}
                destructive={false}
                variant="secondary"
            />

            <ConfirmAction
                label={t('order.void')}
                title={t('order.void')}
                message={`${t('confirm.irreversible')} ${unavailable}`}
                onConfirm={noop}
                disabled={!can.void}
            />

            <ConfirmAction
                label={t('order.invoice')}
                title={t('order.invoice')}
                message={unavailable}
                onConfirm={noop}
                disabled
                destructive={false}
                variant="secondary"
            />
        </div>
    );
}

// ───────────────────────────────────────────────────────────── lines

const TH = 'px-3 py-2 text-start text-xs font-semibold uppercase tracking-wide text-slate-600';
const TD = 'px-3 py-2 align-top';

function LinesTable({
    lines,
    deleted,
    order,
}: {
    lines: OrderLineRecord[];
    deleted: OrderLineRecord[];
    order: OrderShowProps['order'];
}): JSX.Element {
    const t = useT();

    if (lines.length === 0 && deleted.length === 0) {
        return <EmptyState title={t('order.noLines')} />;
    }

    const render = (row: OrderLineRecord, removed: boolean): JSX.Element => (
        <tr key={row.id} className={cn(removed && 'bg-danger-soft/40 line-through opacity-70')}>
            <td className={TD}>
                <span className="flex flex-col">
                    <span className={cn('font-medium', row.combo_parent_line_id !== null && 'ps-4 text-slate-600')}>
                        {row.full_product_name}
                    </span>
                    {row.customer_note ? (
                        <span className="text-xs text-slate-500">✎ {row.customer_note}</span>
                    ) : null}
                    {(row.internal_note ?? []).map((note, index) => (
                        <span key={index} className="text-xs text-slate-500">
                            ⚑ {note.text ?? ''}
                        </span>
                    ))}
                    <span className="flex flex-wrap gap-1 pt-0.5">
                        {row.is_reward_line ? <Badge tone="brand">Récompense</Badge> : null}
                        {row.is_edited ? <Badge tone="warn">{t('order.edited')}</Badge> : null}
                        {toDecimal(row.refunded_quantity).isZero() ? null : (
                            <Badge tone="danger">
                                {t('report.refunds')} {quantity(row.refunded_quantity)}
                            </Badge>
                        )}
                    </span>
                </span>
            </td>
            <td className={cn(TD, 'text-end tabular-nums')}>{quantity(row.quantity)}</td>
            <td className={cn(TD, 'text-end tabular-nums')}>{money(row.price_unit, EUR)}</td>
            <td className={cn(TD, 'text-end tabular-nums')}>
                {toDecimal(row.discount_percent).isZero() && toDecimal(row.discount_amount).isZero() ? (
                    <span className="text-slate-400">—</span>
                ) : (
                    <span className="flex flex-col items-end">
                        <span>{percent(row.discount_percent)}</span>
                        <span className="text-xs text-slate-500">−{money(row.discount_amount, EUR)}</span>
                    </span>
                )}
            </td>
            <td className={cn(TD, 'text-end tabular-nums')}>
                <TaxCell details={row.tax_details} />
            </td>
            <td className={cn(TD, 'text-end tabular-nums')}>{money(row.price_subtotal, EUR)}</td>
            <td className={cn(TD, 'text-end font-semibold tabular-nums')}>
                {money(row.price_subtotal_incl, EUR)}
            </td>
        </tr>
    );

    return (
        <div className="space-y-4">
            <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                    <caption className="sr-only">{t('order.lines')}</caption>
                    <thead className="bg-slate-50">
                        <tr>
                            <th scope="col" className={TH}>
                                {t('nav.products')}
                            </th>
                            <th scope="col" className={cn(TH, 'text-end')}>
                                {t('report.quantity')}
                            </th>
                            <th scope="col" className={cn(TH, 'text-end')}>
                                {t('product.listPrice')}
                            </th>
                            <th scope="col" className={cn(TH, 'text-end')}>
                                {t('order.discount')}
                            </th>
                            <th scope="col" className={cn(TH, 'text-end')}>
                                {t('order.taxes')}
                            </th>
                            <th scope="col" className={cn(TH, 'text-end')}>
                                {t('report.base')}
                            </th>
                            <th scope="col" className={cn(TH, 'text-end')}>
                                {t('report.total')}
                            </th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {lines.map((row) => render(row, false))}
                        {deleted.map((row) => render(row, true))}
                    </tbody>
                    <tfoot className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                        <tr>
                            <td className={TD} colSpan={3}>
                                {t('report.total')}
                            </td>
                            <td className={cn(TD, 'text-end tabular-nums')}>
                                −{money(order.amount_discount, EUR)}
                            </td>
                            <td className={cn(TD, 'text-end tabular-nums')}>{money(order.amount_tax, EUR)}</td>
                            <td className={cn(TD, 'text-end tabular-nums')}>{money(order.amount_untaxed, EUR)}</td>
                            <td className={cn(TD, 'text-end tabular-nums')}>{money(order.amount_total, EUR)}</td>
                        </tr>
                    </tfoot>
                </table>
            </div>

            <Notice tone="info">{t('order.lineProductIdsHint')}</Notice>
        </div>
    );
}

function TaxCell({ details }: { details: LineTaxDetail[] | null }): JSX.Element {
    if (!details || details.length === 0) return <span className="text-slate-400">—</span>;
    return (
        <span className="flex flex-col items-end">
            {details.map((detail) => (
                <span key={detail.taxId} className="text-xs">
                    <span className="text-slate-500">#{detail.taxId}</span> {money(detail.amount, EUR)}
                </span>
            ))}
        </span>
    );
}

// ───────────────────────────────────────────────────────────── payments

function PaymentsTable({
    payments,
    grossPaid,
    changeTotal,
}: {
    payments: OrderShowProps['payments'];
    grossPaid: string;
    changeTotal: string;
}): JSX.Element {
    const t = useT();

    if (payments.length === 0) return <EmptyState title={t('order.noPayments')} />;

    return (
        <div className="space-y-4">
            <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                    <caption className="sr-only">{t('order.payments')}</caption>
                    <thead className="bg-slate-50">
                        <tr>
                            <th scope="col" className={TH}>
                                {t('payment.title')}
                            </th>
                            <th scope="col" className={TH}>
                                {t('report.period')}
                            </th>
                            <th scope="col" className={TH}>
                                {t('payment.terminal')}
                            </th>
                            <th scope="col" className={cn(TH, 'text-end')}>
                                {t('report.total')}
                            </th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {payments.map((payment) => (
                            <tr key={payment.id}>
                                <td className={TD}>
                                    <span className="flex flex-col">
                                        <span className="font-medium">
                                            {payment.label ?? `#${payment.payment_method_id}`}
                                        </span>
                                        <span className="flex flex-wrap gap-1 pt-0.5">
                                            <Badge tone={payment.payment_status === 'done' ? 'ok' : 'warn'}>
                                                {payment.payment_status}
                                            </Badge>
                                            {payment.is_change ? <Badge tone="info">{t('order.change')}</Badge> : null}
                                            {payment.is_refund ? (
                                                <Badge tone="danger">{t('report.refunds')}</Badge>
                                            ) : null}
                                        </span>
                                    </span>
                                </td>
                                <td className={cn(TD, 'tabular-nums')}>{dateTime(payment.paid_at)}</td>
                                <td className={cn(TD, 'text-xs text-slate-600')}>
                                    {payment.card_brand || payment.card_last4 ? (
                                        <span>
                                            {payment.card_brand ?? ''} ••••{payment.card_last4 ?? '????'}
                                        </span>
                                    ) : (
                                        <span className="text-slate-400">—</span>
                                    )}
                                    {payment.auth_code ? (
                                        <span className="block font-mono">{payment.auth_code}</span>
                                    ) : null}
                                </td>
                                <td className={cn(TD, 'text-end font-semibold tabular-nums')}>
                                    {money(payment.amount, EUR)}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
                <Stat label={t('order.payments')} value={money(grossPaid, EUR)} />
                <Stat label={t('order.change')} value={money(changeTotal, EUR)} />
                <Stat
                    label="Net encaissé"
                    value={money(subtractMoney(grossPaid, changeTotal), EUR)}
                    tone="ok"
                />
            </div>

            <Notice tone="info">{t('order.paymentMethodNamesHint')}</Notice>
        </div>
    );
}

// ───────────────────────────────────────────────────────────── taxes

function TaxTables({
    order,
    byTax,
}: {
    order: OrderShowProps['order'];
    byTax: { taxId: number; base: string; amount: string }[];
}): JSX.Element {
    const t = useT();
    const groups = order.tax_details ?? [];

    return (
        <div className="grid gap-6 lg:grid-cols-2">
            <section>
                <h3 className="mb-2 text-base font-semibold text-slate-900">{t('order.taxGroupBreakdown')}</h3>
                {groups.length === 0 ? (
                    <EmptyState title={t('state.empty')} />
                ) : (
                    <table className="w-full border-collapse text-sm">
                        <caption className="sr-only">{t('order.taxGroupBreakdown')}</caption>
                        <thead className="bg-slate-50">
                            <tr>
                                <th scope="col" className={TH}>
                                    {t('tax.groups')}
                                </th>
                                <th scope="col" className={cn(TH, 'text-end')}>
                                    {t('report.base')}
                                </th>
                                <th scope="col" className={cn(TH, 'text-end')}>
                                    {t('report.taxAmount')}
                                </th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                            {groups.map((group) => (
                                <tr key={group.taxGroupId}>
                                    <td className={TD}>#{group.taxGroupId}</td>
                                    <td className={cn(TD, 'text-end tabular-nums')}>{money(group.base, EUR)}</td>
                                    <td className={cn(TD, 'text-end tabular-nums')}>{money(group.amount, EUR)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </section>

            <section>
                <h3 className="mb-2 text-base font-semibold text-slate-900">{t('order.taxLineBreakdown')}</h3>
                {byTax.length === 0 ? (
                    <EmptyState title={t('state.empty')} />
                ) : (
                    <table className="w-full border-collapse text-sm">
                        <caption className="sr-only">{t('order.taxLineBreakdown')}</caption>
                        <thead className="bg-slate-50">
                            <tr>
                                <th scope="col" className={TH}>
                                    {t('nav.taxes')}
                                </th>
                                <th scope="col" className={cn(TH, 'text-end')}>
                                    {t('report.base')}
                                </th>
                                <th scope="col" className={cn(TH, 'text-end')}>
                                    {t('report.taxAmount')}
                                </th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                            {byTax.map((row) => (
                                <tr key={row.taxId}>
                                    <td className={TD}>#{row.taxId}</td>
                                    <td className={cn(TD, 'text-end tabular-nums')}>{money(row.base, EUR)}</td>
                                    <td className={cn(TD, 'text-end tabular-nums')}>{money(row.amount, EUR)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </section>
        </div>
    );
}

// ───────────────────────────────────────────────────────────── courses

function CoursesTable({ courses }: { courses: OrderShowProps['courses'] }): JSX.Element {
    const t = useT();

    if (courses.length === 0) return <EmptyState title={t('state.empty')} />;

    return (
        <ul className="divide-y divide-slate-100">
            {courses
                .slice()
                .sort((a, b) => a.course_index - b.course_index)
                .map((course) => (
                    <li key={course.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                        <Badge tone="brand">{course.course_index}</Badge>
                        <span className="font-medium">{course.name ?? `Service ${course.course_index}`}</span>
                        <span className="text-slate-500">{course.line_count} ligne(s)</span>
                        <Badge tone={course.fired ? 'ok' : 'neutral'}>
                            {course.fired ? dateTime(course.fired_at) : t('state.no')}
                        </Badge>
                    </li>
                ))}
        </ul>
    );
}

// ───────────────────────────────────────────────────────────── audit

function AuditPanel({ order }: { order: OrderShowProps['order'] }): JSX.Element {
    const t = useT();

    return (
        <div className="space-y-4">
            <DefinitionList
                columns={3}
                items={[
                    { label: 'UUID', value: <span className="font-mono text-xs">{order.uuid}</span> },
                    { label: t('order.edited'), value: order.is_edited ? t('state.yes') : t('state.no') },
                    {
                        label: t('order.hasDeletedLine'),
                        value: order.has_deleted_line ? t('state.yes') : t('state.no'),
                    },
                    { label: 'Impressions', value: order.print_count },
                    { label: 'Créée sur l’appareil', value: dateTime(order.client_created_at) },
                    { label: 'Synchronisée', value: dateTime(order.synced_at) },
                    { label: 'Créée', value: dateTime(order.created_at) },
                    { label: 'Modifiée', value: dateTime(order.updated_at) },
                    { label: 'Supprimée', value: dateTime(order.deleted_at) },
                    { label: 'Appareil', value: order.pos_device_id ?? '—' },
                    { label: 'Préparation', value: order.prep_state },
                    { label: 'Modifs non envoyées', value: order.unsent_change_count },
                    { label: 'Remboursement de', value: order.refunded_order_id ?? '—' },
                    { label: 'Scindée depuis', value: order.split_from_order_id ?? '—' },
                    { label: 'Fusionnée dans', value: order.merged_into_order_id ?? '—' },
                ]}
            />

            <Notice tone="info">{t('order.auditHint')}</Notice>
        </div>
    );
}
