/**
 * Four SVG charts: bar, line, sparkline, donut.
 *
 * Accessibility is not an afterthought here, it is the reason they are hand-written. Every chart
 * is a `<figure>` containing:
 *
 *   - an `<svg role="img">` with `<title>` and `<desc>` referenced by `aria-labelledby`, so a
 *     screen reader announces what the picture is *about*;
 *   - a real `<table>` of the same data, visually hidden but fully navigable, so the numbers are
 *     reachable rather than merely described.
 *
 * The tabular fallback is also what makes these charts survive printing and high-contrast modes.
 */

import { cn } from '@shared/ui';
import { useId, type JSX } from 'react';

import { useT } from '../../i18n';

import {
    areaPath,
    colorAt,
    compactNumber,
    donutSlice,
    linePath,
    niceScale,
    scalePoints,
    type ChartPoint,
} from './chart-utils';

type BaseProps = {
    title: string;
    description?: string;
    data: readonly ChartPoint[];
    className?: string;
    /** Header for the first column of the tabular fallback. */
    categoryLabel?: string;
    valueLabel?: string;
};

function DataTableFallback({
    id,
    data,
    categoryLabel,
    valueLabel,
}: {
    id: string;
    data: readonly ChartPoint[];
    categoryLabel: string;
    valueLabel: string;
}): JSX.Element {
    return (
        <table id={id} className="sr-only">
            <caption>{categoryLabel}</caption>
            <thead>
                <tr>
                    <th scope="col">{categoryLabel}</th>
                    <th scope="col">{valueLabel}</th>
                </tr>
            </thead>
            <tbody>
                {data.map((point) => (
                    <tr key={point.label}>
                        <th scope="row">{point.label}</th>
                        <td>{point.display}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

function EmptyChart({ label }: { label: string }): JSX.Element {
    return (
        <div className="flex h-32 items-center justify-center rounded-pos bg-slate-50 text-sm text-slate-500">
            {label}
        </div>
    );
}

// ───────────────────────────────────────────────────────────── bar

export function BarChart({
    title,
    description,
    data,
    className,
    categoryLabel,
    valueLabel,
    height = 220,
    horizontal = false,
}: BaseProps & { height?: number; horizontal?: boolean }): JSX.Element {
    const t = useT();
    const base = useId();
    const titleId = `${base}-title`;
    const descId = `${base}-desc`;
    const tableId = `${base}-table`;

    if (data.length === 0) return <EmptyChart label={t('chart.noData')} />;

    const { max, ticks } = niceScale(Math.max(...data.map((d) => d.value), 0));
    const width = 100;

    return (
        <figure className={cn('m-0', className)} aria-labelledby={`${titleId} ${descId}`}>
            {horizontal ? (
                <div className="space-y-2" role="img" aria-labelledby={`${titleId} ${descId}`}>
                    <span id={titleId} className="sr-only">
                        {title}
                    </span>
                    <span id={descId} className="sr-only">
                        {description ?? title}
                    </span>
                    {data.map((point, index) => (
                        <div key={point.label} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3">
                            <span className="truncate text-sm text-slate-700" title={point.label}>
                                {point.label}
                            </span>
                            <span className="h-3 overflow-hidden rounded-full bg-slate-100">
                                <span
                                    className="block h-full rounded-full"
                                    style={{
                                        width: `${max === 0 ? 0 : (point.value / max) * 100}%`,
                                        backgroundColor: point.color ?? colorAt(index),
                                    }}
                                />
                            </span>
                            <span className="text-sm font-semibold tabular-nums text-slate-900">{point.display}</span>
                        </div>
                    ))}
                </div>
            ) : (
                <svg
                    role="img"
                    aria-labelledby={`${titleId} ${descId}`}
                    viewBox={`0 0 ${width} ${height}`}
                    preserveAspectRatio="none"
                    className="h-56 w-full"
                >
                    <title id={titleId}>{title}</title>
                    <desc id={descId}>{description ?? title}</desc>

                    {ticks.map((tick) => {
                        const y = height - (max === 0 ? 0 : (tick / max) * (height - 24)) - 20;
                        return (
                            <line
                                key={tick}
                                x1={0}
                                x2={width}
                                y1={y}
                                y2={y}
                                stroke="#e2e8f0"
                                strokeWidth={0.4}
                                vectorEffect="non-scaling-stroke"
                            />
                        );
                    })}

                    {data.map((point, index) => {
                        const slot = width / data.length;
                        const barWidth = slot * 0.62;
                        const x = index * slot + (slot - barWidth) / 2;
                        const barHeight = max === 0 ? 0 : (point.value / max) * (height - 24);
                        return (
                            <rect
                                key={point.label}
                                x={x}
                                y={height - 20 - barHeight}
                                width={barWidth}
                                height={Math.max(barHeight, 0.5)}
                                rx={1}
                                fill={point.color ?? colorAt(index)}
                            >
                                <title>{`${point.label} — ${point.display}`}</title>
                            </rect>
                        );
                    })}
                </svg>
            )}

            {!horizontal ? (
                <div className="mt-1 flex justify-between text-xs text-slate-500">
                    <span>{data[0]?.label}</span>
                    <span>{data[data.length - 1]?.label}</span>
                </div>
            ) : null}

            <figcaption className="sr-only">{description ?? title}</figcaption>
            <DataTableFallback
                id={tableId}
                data={data}
                categoryLabel={categoryLabel ?? t('chart.day')}
                valueLabel={valueLabel ?? t('chart.value')}
            />
        </figure>
    );
}

// ───────────────────────────────────────────────────────────── line

export function LineChart({
    title,
    description,
    data,
    className,
    categoryLabel,
    valueLabel,
    height = 200,
}: BaseProps & { height?: number }): JSX.Element {
    const t = useT();
    const base = useId();
    const titleId = `${base}-title`;
    const descId = `${base}-desc`;

    if (data.length === 0) return <EmptyChart label={t('chart.noData')} />;

    const width = 300;
    const padding = { top: 8, right: 4, bottom: 18, left: 34 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const { max, ticks } = niceScale(Math.max(...data.map((d) => d.value), 0));
    const points = scalePoints(
        data.map((d) => d.value),
        plotWidth,
        plotHeight,
        max,
    );

    return (
        <figure className={cn('m-0', className)}>
            <svg role="img" aria-labelledby={`${titleId} ${descId}`} viewBox={`0 0 ${width} ${height}`} className="w-full">
                <title id={titleId}>{title}</title>
                <desc id={descId}>{description ?? title}</desc>

                <g transform={`translate(${padding.left} ${padding.top})`}>
                    {ticks.map((tick) => {
                        const y = plotHeight - (max === 0 ? 0 : (tick / max) * plotHeight);
                        return (
                            <g key={tick}>
                                <line x1={0} x2={plotWidth} y1={y} y2={y} stroke="#e2e8f0" strokeWidth={1} />
                                <text x={-6} y={y + 3} textAnchor="end" fontSize={8} fill="#64748b">
                                    {compactNumber(tick)}
                                </text>
                            </g>
                        );
                    })}

                    <path d={areaPath(points, plotHeight)} fill="#2563eb" fillOpacity={0.08} />
                    <path d={linePath(points)} fill="none" stroke="#2563eb" strokeWidth={2} strokeLinejoin="round" />

                    {points.map((point, index) => (
                        <circle key={index} cx={point.x} cy={point.y} r={2.5} fill="#2563eb">
                            <title>{`${data[index]?.label ?? ''} — ${data[index]?.display ?? ''}`}</title>
                        </circle>
                    ))}
                </g>

                <text x={padding.left} y={height - 4} fontSize={8} fill="#64748b">
                    {data[0]?.label}
                </text>
                <text x={width - padding.right} y={height - 4} fontSize={8} fill="#64748b" textAnchor="end">
                    {data[data.length - 1]?.label}
                </text>
            </svg>

            <figcaption className="sr-only">{description ?? title}</figcaption>
            <DataTableFallback
                id={`${base}-table`}
                data={data}
                categoryLabel={categoryLabel ?? t('chart.day')}
                valueLabel={valueLabel ?? t('chart.value')}
            />
        </figure>
    );
}

// ───────────────────────────────────────────────────────────── sparkline

export function Sparkline({
    title,
    description,
    data,
    className,
    categoryLabel,
    valueLabel,
}: BaseProps): JSX.Element {
    const t = useT();
    const base = useId();
    const titleId = `${base}-title`;
    const descId = `${base}-desc`;

    if (data.length === 0) return <EmptyChart label={t('chart.noData')} />;

    const width = 160;
    const height = 40;
    const max = Math.max(...data.map((d) => d.value), 0);
    const points = scalePoints(
        data.map((d) => d.value),
        width,
        height - 2,
        max === 0 ? 1 : max,
    );
    const last = points[points.length - 1];

    return (
        <figure className={cn('m-0', className)}>
            <svg
                role="img"
                aria-labelledby={`${titleId} ${descId}`}
                viewBox={`0 0 ${width} ${height}`}
                className="h-10 w-full"
                preserveAspectRatio="none"
            >
                <title id={titleId}>{title}</title>
                <desc id={descId}>{description ?? title}</desc>
                <path d={areaPath(points, height)} fill="#2563eb" fillOpacity={0.1} />
                <path
                    d={linePath(points)}
                    fill="none"
                    stroke="#2563eb"
                    strokeWidth={1.5}
                    vectorEffect="non-scaling-stroke"
                    strokeLinejoin="round"
                />
                {last ? <circle cx={last.x} cy={last.y} r={2} fill="#2563eb" vectorEffect="non-scaling-stroke" /> : null}
            </svg>
            <figcaption className="sr-only">{description ?? title}</figcaption>
            <DataTableFallback
                id={`${base}-table`}
                data={data}
                categoryLabel={categoryLabel ?? t('chart.day')}
                valueLabel={valueLabel ?? t('chart.value')}
            />
        </figure>
    );
}

// ───────────────────────────────────────────────────────────── donut

export function DonutChart({
    title,
    description,
    data,
    className,
    categoryLabel,
    valueLabel,
    centreLabel,
    centreValue,
}: BaseProps & { centreLabel?: string; centreValue?: string }): JSX.Element {
    const t = useT();
    const base = useId();
    const titleId = `${base}-title`;
    const descId = `${base}-desc`;

    const total = data.reduce((sum, point) => sum + Math.max(0, point.value), 0);
    if (data.length === 0 || total === 0) return <EmptyChart label={t('chart.noData')} />;

    const radius = 60;
    const inner = 38;
    let cursor = 0;

    return (
        <figure className={cn('m-0 flex flex-wrap items-center gap-6', className)}>
            <svg
                role="img"
                aria-labelledby={`${titleId} ${descId}`}
                viewBox={`0 0 ${radius * 2} ${radius * 2}`}
                className="h-40 w-40 shrink-0"
            >
                <title id={titleId}>{title}</title>
                <desc id={descId}>{description ?? title}</desc>
                {data.map((point, index) => {
                    const fraction = Math.max(0, point.value) / total;
                    const path = donutSlice(cursor, cursor + fraction, radius, inner);
                    cursor += fraction;
                    return (
                        <path key={point.label} d={path} fill={point.color ?? colorAt(index)}>
                            <title>{`${point.label} — ${point.display}`}</title>
                        </path>
                    );
                })}
                {centreValue ? (
                    <>
                        <text
                            x={radius}
                            y={radius - 2}
                            textAnchor="middle"
                            fontSize={13}
                            fontWeight={700}
                            fill="#0f172a"
                        >
                            {centreValue}
                        </text>
                        {centreLabel ? (
                            <text x={radius} y={radius + 12} textAnchor="middle" fontSize={8} fill="#64748b">
                                {centreLabel}
                            </text>
                        ) : null}
                    </>
                ) : null}
            </svg>

            <ul className="min-w-0 flex-1 space-y-1.5">
                {data.map((point, index) => (
                    <li key={point.label} className="flex items-center gap-2 text-sm">
                        <span
                            aria-hidden
                            className="h-3 w-3 shrink-0 rounded-sm"
                            style={{ backgroundColor: point.color ?? colorAt(index) }}
                        />
                        <span className="min-w-0 flex-1 truncate text-slate-700">{point.label}</span>
                        <span className="font-semibold tabular-nums text-slate-900">{point.display}</span>
                    </li>
                ))}
            </ul>

            <figcaption className="sr-only">{description ?? title}</figcaption>
            <DataTableFallback
                id={`${base}-table`}
                data={data}
                categoryLabel={categoryLabel ?? t('chart.value')}
                valueLabel={valueLabel ?? t('chart.value')}
            />
        </figure>
    );
}

export { colorAt, compactNumber, niceScale } from './chart-utils';
export type { ChartPoint } from './chart-utils';
