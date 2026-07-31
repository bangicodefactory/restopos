/**
 * Geometry for the hand-rolled SVG charts.
 *
 * No charting dependency: four small chart types, drawn as SVG paths, cost less than the
 * accessibility work needed to make a canvas-based library usable — and every one of these
 * charts renders a real `<table>` for screen readers anyway (see the components).
 *
 * A note on numbers: chart *geometry* is floating point, and that is fine — a pixel is not a
 * cent. The **displayed** value never comes from these numbers; every point carries its own
 * pre-formatted `display` string produced by the money formatter.
 */

export type ChartPoint = {
    /** Category label (x axis / legend). */
    label: string;
    /** Geometry only. Never rendered as text. */
    value: number;
    /** What the user reads — already formatted by `lib/money`. */
    display: string;
    /** Optional per-slice colour override. */
    color?: string;
};

/** Deterministic palette. Distinguishable in the default and in a mono print. */
export const CHART_COLORS = [
    '#2563eb',
    '#0d9488',
    '#b45309',
    '#7c3aed',
    '#be123c',
    '#0891b2',
    '#65a30d',
    '#c2410c',
] as const;

export function colorAt(index: number): string {
    return CHART_COLORS[index % CHART_COLORS.length] ?? '#2563eb';
}

/**
 * Axis maximum rounded up to a "nice" number, plus the tick values.
 *
 * A y-axis that reads 0 / 2 500 / 5 000 is legible; one that reads 0 / 2 483.33 / 4 966.66 is
 * noise dressed as precision.
 */
export function niceScale(max: number, tickCount = 4): { max: number; ticks: number[] } {
    if (!Number.isFinite(max) || max <= 0) return { max: 1, ticks: [0, 1] };

    const rough = max / tickCount;
    const magnitude = 10 ** Math.floor(Math.log10(rough));
    const normalised = rough / magnitude;
    const step =
        (normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 2.5 ? 2.5 : normalised <= 5 ? 5 : 10) *
        magnitude;

    const top = Math.ceil(max / step) * step;
    const ticks: number[] = [];
    for (let value = 0; value <= top + step / 2; value += step) ticks.push(Number(value.toFixed(6)));
    return { max: top, ticks };
}

/** Map a series to SVG points inside a box. */
export function scalePoints(
    values: readonly number[],
    width: number,
    height: number,
    max: number,
): { x: number; y: number }[] {
    if (values.length === 0) return [];
    const step = values.length === 1 ? 0 : width / (values.length - 1);
    return values.map((value, index) => ({
        x: values.length === 1 ? width / 2 : index * step,
        y: max === 0 ? height : height - (Math.max(0, value) / max) * height,
    }));
}

export function linePath(points: readonly { x: number; y: number }[]): string {
    if (points.length === 0) return '';
    return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${round(p.x)} ${round(p.y)}`).join(' ');
}

export function areaPath(points: readonly { x: number; y: number }[], height: number): string {
    if (points.length === 0) return '';
    const first = points[0];
    const last = points[points.length - 1];
    if (!first || !last) return '';
    return `${linePath(points)} L${round(last.x)} ${round(height)} L${round(first.x)} ${round(height)} Z`;
}

/** One donut slice as a path, drawn clockwise from 12 o'clock. */
export function donutSlice(
    startFraction: number,
    endFraction: number,
    radius: number,
    innerRadius: number,
    centre = radius,
): string {
    const full = endFraction - startFraction >= 1;
    // A full circle cannot be drawn with one arc: split it into two halves.
    if (full) {
        return [
            donutSlice(0, 0.5, radius, innerRadius, centre),
            donutSlice(0.5, 1, radius, innerRadius, centre),
        ].join(' ');
    }

    const start = polar(startFraction, radius, centre);
    const end = polar(endFraction, radius, centre);
    const innerStart = polar(startFraction, innerRadius, centre);
    const innerEnd = polar(endFraction, innerRadius, centre);
    const largeArc = endFraction - startFraction > 0.5 ? 1 : 0;

    return [
        `M${round(start.x)} ${round(start.y)}`,
        `A${round(radius)} ${round(radius)} 0 ${largeArc} 1 ${round(end.x)} ${round(end.y)}`,
        `L${round(innerEnd.x)} ${round(innerEnd.y)}`,
        `A${round(innerRadius)} ${round(innerRadius)} 0 ${largeArc} 0 ${round(innerStart.x)} ${round(innerStart.y)}`,
        'Z',
    ].join(' ');
}

function polar(fraction: number, radius: number, centre: number): { x: number; y: number } {
    const angle = fraction * Math.PI * 2 - Math.PI / 2;
    return { x: centre + radius * Math.cos(angle), y: centre + radius * Math.sin(angle) };
}

function round(value: number): number {
    return Math.round(value * 100) / 100;
}

/** Short axis labels: 12 480 → "12,5 k". */
export function compactNumber(value: number): string {
    const abs = Math.abs(value);
    if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace('.', ',')} M`;
    if (abs >= 1_000) return `${(value / 1_000).toFixed(abs >= 10_000 ? 0 : 1).replace('.', ',')} k`;
    return String(Math.round(value));
}
