/**
 * `Dashboard/Index` — `GET /` (BOF-001…BOF-005, BOF-008).
 *
 * One card per register with its live session, today's headline numbers, and the rescue-session
 * list. Rescue sessions are given a red block of their own rather than a badge: they exist only
 * because an order arrived after its session closed, and every one of them is money that is not
 * yet reconciled.
 *
 * `today` and `rescueSessions` are `Inertia::defer`ed — they render as skeletons and arrive in a
 * follow-up request, so the register cards paint immediately.
 */

import { Head, Link } from '@inertiajs/react';
import { Button, FOCUS_RING, cn } from '@shared/ui';
import { useMemo, useState, type JSX } from 'react';

import { Sparkline, type ChartPoint } from '../../components/charts';
import { AppLayout } from '../../components/layout/AppLayout';
import {
    Badge,
    Card,
    CardBody,
    CardHeader,
    DeferredRegion,
    DefinitionList,
    EmptyState,
    Notice,
    Stat,
    type BadgeTone,
} from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { dateTime, integer, relative } from '../../lib/format';
import { EUR, money, quantity, toDecimal } from '../../lib/money';
import { routes } from '../../lib/routes';
import { withQuery } from '../../lib/query';

import type { DashboardProps, DashboardRegister, DashboardSession } from './types';

const SESSION_TONE: Record<string, BadgeTone> = {
    opening_control: 'warn',
    opened: 'ok',
    closing_control: 'warn',
    closed: 'neutral',
};

export default function DashboardIndex({
    registers,
    today,
    rescueSessions,
    salesTrend,
    topProducts,
}: DashboardProps): JSX.Element {
    const t = useT();
    const [focusedRegisterId, setFocusedRegisterId] = useState<number | null>(
        registers.find((register) => register.session !== null)?.id ?? registers[0]?.id ?? null,
    );

    const focused = registers.find((register) => register.id === focusedRegisterId) ?? null;

    const trendPoints = useMemo<ChartPoint[]>(
        () =>
            (salesTrend ?? []).map((point) => ({
                label: point.day,
                value: Number(toDecimal(point.revenue).toString()),
                display: money(point.revenue, EUR),
            })),
        [salesTrend],
    );

    return (
        <AppLayout title={t('dashboard.title')} description={t('dashboard.subtitle')}>
            <Head title={t('dashboard.title')} />

            {/* headline numbers */}
            <DeferredRegion value={today} label={t('dashboard.title')} rows={1}>
                {(value) => (
                    <div className="mb-6 grid gap-4 sm:grid-cols-3">
                        <Stat label={t('dashboard.todayRevenue')} value={money(value.revenue, EUR)} tone="ok" icon="€" />
                        <Stat label={t('dashboard.todayOrders')} value={integer(value.order_count)} tone="info" icon="#" />
                        <Stat
                            label={t('dashboard.openSessions')}
                            value={integer(value.open_sessions)}
                            tone={value.open_sessions > 0 ? 'brand' : 'neutral'}
                            icon="⏻"
                        />
                    </div>
                )}
            </DeferredRegion>

            <div className="grid gap-6 xl:grid-cols-[2fr_1fr]">
                {/* registers */}
                <section aria-labelledby="dash-registers">
                    <h2 id="dash-registers" className="mb-3 text-lg font-semibold text-slate-900">
                        {t('dashboard.registers')}
                    </h2>

                    {registers.length === 0 ? (
                        <Card>
                            <EmptyState title={t('dashboard.noRegisters')} hint={t('state.emptyHint')} />
                        </Card>
                    ) : (
                        <ul className="grid gap-4 md:grid-cols-2">
                            {registers.map((register) => (
                                <li key={register.id}>
                                    <RegisterCard
                                        register={register}
                                        focused={register.id === focusedRegisterId}
                                        onFocus={() => setFocusedRegisterId(register.id)}
                                    />
                                </li>
                            ))}
                        </ul>
                    )}

                    {/* rescue sessions */}
                    <div className="mt-6">
                        <DeferredRegion value={rescueSessions} label={t('dashboard.rescue')} rows={2}>
                            {(sessions) =>
                                sessions.length === 0 ? (
                                    <></>
                                ) : (
                                    <Card className="ring-danger/40">
                                        <CardHeader
                                            title={
                                                <span className="flex items-center gap-2">
                                                    {t('dashboard.rescue')}
                                                    <Badge tone="danger">{sessions.length}</Badge>
                                                </span>
                                            }
                                            description={t('dashboard.rescueHint')}
                                        />
                                        <CardBody className="p-0">
                                            <ul className="divide-y divide-slate-100">
                                                {sessions.map((session) => (
                                                    <li
                                                        key={session.id}
                                                        className="flex flex-wrap items-center justify-between gap-2 px-5 py-3"
                                                    >
                                                        <div className="min-w-0">
                                                            <Link
                                                                href={routes.sessions.show(session.id)}
                                                                className={cn(
                                                                    'rounded-pos font-medium text-brand-700 hover:underline',
                                                                    FOCUS_RING,
                                                                )}
                                                            >
                                                                {session.name}
                                                            </Link>
                                                            <div className="text-xs text-slate-500">
                                                                {dateTime(session.opened_at)} ·{' '}
                                                                {integer(session.order_count)} {t('session.orders')}
                                                            </div>
                                                            {session.opening_notes ? (
                                                                <p className="mt-1 text-xs text-slate-600">
                                                                    {session.opening_notes}
                                                                </p>
                                                            ) : null}
                                                        </div>
                                                        <Button
                                                            variant="secondary"
                                                            size="sm"
                                                            onClick={() =>
                                                                (globalThis.location.href = routes.sessions.show(
                                                                    session.id,
                                                                ))
                                                            }
                                                        >
                                                            {t('action.details')}
                                                        </Button>
                                                    </li>
                                                ))}
                                            </ul>
                                        </CardBody>
                                    </Card>
                                )
                            }
                        </DeferredRegion>
                    </div>
                </section>

                {/* side column */}
                <div className="space-y-6">
                    <Card>
                        <CardHeader title={t('dashboard.livePanel')} />
                        <CardBody>
                            {focused === null ? (
                                <p className="text-sm text-slate-500">{t('dashboard.noRegisters')}</p>
                            ) : (
                                <LiveSessionPanel register={focused} />
                            )}
                        </CardBody>
                    </Card>

                    <Card>
                        <CardHeader
                            title={t('dashboard.last14Days')}
                            actions={
                                <Link
                                    href={routes.reports.orderAnalytics()}
                                    className={cn('rounded-pos text-sm text-brand-700 hover:underline', FOCUS_RING)}
                                >
                                    {t('nav.orderAnalytics')}
                                </Link>
                            }
                        />
                        <CardBody>
                            {trendPoints.length === 0 ? (
                                <Notice tone="info">{t('dashboard.needsData')}</Notice>
                            ) : (
                                <Sparkline
                                    title={t('dashboard.last14Days')}
                                    description={t('dashboard.sparklineDesc')}
                                    data={trendPoints}
                                    categoryLabel={t('chart.day')}
                                    valueLabel={t('report.revenue')}
                                />
                            )}
                        </CardBody>
                    </Card>

                    <Card>
                        <CardHeader
                            title={t('dashboard.topProducts')}
                            actions={
                                <Link
                                    href={routes.reports.salesDetails()}
                                    className={cn('rounded-pos text-sm text-brand-700 hover:underline', FOCUS_RING)}
                                >
                                    {t('nav.salesDetails')}
                                </Link>
                            }
                        />
                        <CardBody>
                            {!topProducts || topProducts.length === 0 ? (
                                <Notice tone="info">{t('dashboard.needsData')}</Notice>
                            ) : (
                                <ol className="space-y-2">
                                    {topProducts.slice(0, 8).map((product, index) => (
                                        <li
                                            key={product.product_id ?? index}
                                            className="flex items-baseline justify-between gap-3 text-sm"
                                        >
                                            <span className="min-w-0 truncate text-slate-700">
                                                {product.product_name ?? '—'}
                                            </span>
                                            <span className="shrink-0 tabular-nums text-slate-500">
                                                {quantity(product.quantity)}
                                            </span>
                                            <span className="shrink-0 font-semibold tabular-nums text-slate-900">
                                                {money(product.total_amount, EUR)}
                                            </span>
                                        </li>
                                    ))}
                                </ol>
                            )}
                        </CardBody>
                    </Card>
                </div>
            </div>
        </AppLayout>
    );
}

function RegisterCard({
    register,
    focused,
    onFocus,
}: {
    register: DashboardRegister;
    focused: boolean;
    onFocus: () => void;
}): JSX.Element {
    const t = useT();
    const session = register.session;

    return (
        <Card
            className={cn('h-full transition-shadow', focused && 'ring-2 ring-brand-400')}
            as="article"
        >
            <CardHeader
                title={
                    <button
                        type="button"
                        onClick={onFocus}
                        className={cn('rounded-pos text-start hover:text-brand-700', FOCUS_RING)}
                    >
                        {register.name}
                    </button>
                }
                description={
                    <span className="flex flex-wrap items-center gap-2">
                        {register.is_restaurant ? <Badge tone="info">{t('dashboard.restaurant')}</Badge> : null}
                        {register.self_ordering_mode !== 'nothing' ? (
                            <Badge tone="brand">
                                {t('dashboard.selfOrder', { mode: register.self_ordering_mode })}
                            </Badge>
                        ) : null}
                        <Badge>{t('dashboard.devices', { count: register.device_count })}</Badge>
                    </span>
                }
            />

            <CardBody className="space-y-3">
                {session === null ? (
                    <p className="text-sm text-slate-500">{t('dashboard.noSession')}</p>
                ) : (
                    <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                            <Badge tone={SESSION_TONE[session.state] ?? 'neutral'}>{session.state}</Badge>
                            <Link
                                href={routes.sessions.show(session.id)}
                                className={cn('rounded-pos text-sm font-medium text-brand-700 hover:underline', FOCUS_RING)}
                            >
                                {session.name}
                            </Link>
                        </div>
                        <div className="text-xs text-slate-500">
                            {t('dashboard.sessionOpenedAt', { date: dateTime(session.opened_at) })} ·{' '}
                            {relative(session.opened_at)}
                        </div>
                        <div className="flex items-baseline gap-3 pt-1">
                            <span className="text-xl font-bold tabular-nums text-slate-900">
                                {money(session.order_amount_total, EUR)}
                            </span>
                            <span className="text-sm text-slate-500">
                                {integer(session.order_count)} {t('session.orders')}
                            </span>
                        </div>
                    </div>
                )}

                <div className="flex flex-wrap gap-2 pt-1">
                    <a
                        href={routes.shells.register(register.id)}
                        className={cn(
                            'inline-flex min-h-touch items-center rounded-pos bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700',
                            FOCUS_RING,
                        )}
                    >
                        {session === null ? t('dashboard.openRegister') : t('dashboard.continueSelling')}
                    </a>

                    <Link
                        href={routes.posConfigs.edit(register.id)}
                        className={cn(
                            'inline-flex min-h-touch items-center rounded-pos px-4 text-sm font-semibold text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50',
                            FOCUS_RING,
                        )}
                    >
                        {t('nav.settings')}
                    </Link>

                    <Link
                        href={withQuery(routes.orders.index(), { config_id: register.id })}
                        className={cn(
                            'inline-flex min-h-touch items-center rounded-pos px-4 text-sm font-semibold text-slate-700 hover:bg-slate-100',
                            FOCUS_RING,
                        )}
                    >
                        {t('nav.orders')}
                    </Link>
                </div>
            </CardBody>
        </Card>
    );
}

function LiveSessionPanel({ register }: { register: DashboardRegister }): JSX.Element {
    const t = useT();
    const session: DashboardSession | null = register.session;

    if (session === null) {
        return (
            <div className="space-y-3">
                <p className="text-sm text-slate-500">{t('dashboard.noSession')}</p>
                <a
                    href={routes.shells.register(register.id)}
                    className={cn(
                        'inline-flex min-h-touch items-center rounded-pos bg-brand-600 px-4 text-sm font-semibold text-white',
                        FOCUS_RING,
                    )}
                >
                    {t('dashboard.openRegister')}
                </a>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            <DefinitionList
                columns={1}
                items={[
                    { label: t('dashboard.registers'), value: register.name },
                    { label: t('session.title'), value: session.name },
                    { label: t('order.filterState'), value: <Badge tone={SESSION_TONE[session.state] ?? 'neutral'}>{session.state}</Badge> },
                    { label: t('dashboard.sessionOpenedAt', { date: '' }).trim(), value: dateTime(session.opened_at) },
                    { label: t('session.orders'), value: integer(session.order_count) },
                    { label: t('report.revenue'), value: money(session.order_amount_total, EUR) },
                ]}
            />

            <Link
                href={routes.sessions.show(session.id)}
                className={cn(
                    'inline-flex min-h-touch items-center rounded-pos px-4 text-sm font-semibold text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50',
                    FOCUS_RING,
                )}
            >
                {t('dashboard.viewSession')}
            </Link>
        </div>
    );
}
