import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react';

import { cn } from './cn';

/**
 * Windowed product grid.
 *
 * A 5 000-product catalog rendered as 5 000 DOM nodes costs about 400 ms of layout on the tablets
 * this runs on, and every scroll frame after that. This renders only the rows in view plus an
 * overscan margin, which keeps it at a few dozen nodes regardless of catalog size.
 *
 * Deliberately hand-rolled rather than a virtualisation library: the requirements are a fixed row
 * height, a responsive column count and nothing else. That is ~90 lines, versus a dependency whose
 * API surface we would use 5 % of and whose bundle sits on the cold-boot path.
 */

export type VirtualGridProps<T> = {
    items: readonly T[];
    /** Fixed cell height in pixels — uniform cells are what make the maths exact. */
    rowHeight: number;
    /** Minimum cell width; the column count is derived from the container. */
    minColumnWidth: number;
    gap?: number;
    overscanRows?: number;
    renderItem: (item: T, index: number) => ReactNode;
    keyOf: (item: T, index: number) => string | number;
    className?: string;
    empty?: ReactNode;
    /** Scroll the grid so this index is visible (e.g. after a barcode scan). */
    scrollToIndex?: number | null;
};

export function VirtualGrid<T>({
    items,
    rowHeight,
    minColumnWidth,
    gap = 8,
    overscanRows = 2,
    renderItem,
    keyOf,
    className,
    empty,
    scrollToIndex = null,
}: VirtualGridProps<T>): JSX.Element {
    const viewport = useRef<HTMLDivElement>(null);
    const [size, setSize] = useState({ width: 0, height: 0 });
    const [scrollTop, setScrollTop] = useState(0);

    useLayoutEffect(() => {
        const element = viewport.current;
        if (!element) return;

        const measure = (): void =>
            setSize({ width: element.clientWidth, height: element.clientHeight });
        measure();

        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const columns = Math.max(1, Math.floor((size.width + gap) / (minColumnWidth + gap)));
    const rows = Math.ceil(items.length / columns);
    const totalHeight = rows * rowHeight + Math.max(0, rows - 1) * gap;

    const { firstRow, lastRow } = useMemo(() => {
        const stride = rowHeight + gap;
        const first = Math.max(0, Math.floor(scrollTop / stride) - overscanRows);
        const visible = Math.ceil((size.height || stride) / stride) + overscanRows * 2;
        return { firstRow: first, lastRow: Math.min(rows, first + visible) };
    }, [gap, overscanRows, rowHeight, rows, scrollTop, size.height]);

    const onScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
        setScrollTop(event.currentTarget.scrollTop);
    }, []);

    useEffect(() => {
        if (scrollToIndex === null || columns === 0) return;
        const element = viewport.current;
        if (!element) return;
        const row = Math.floor(scrollToIndex / columns);
        element.scrollTo({ top: row * (rowHeight + gap), behavior: 'smooth' });
    }, [columns, gap, rowHeight, scrollToIndex]);

    const start = firstRow * columns;
    const end = Math.min(items.length, lastRow * columns);
    const slice = items.slice(start, end);

    if (items.length === 0 && empty) {
        return <div className={cn('flex flex-1 items-center justify-center', className)}>{empty}</div>;
    }

    return (
        <div
            ref={viewport}
            onScroll={onScroll}
            className={cn('relative flex-1 overflow-auto overscroll-contain', className)}
            // Momentum scrolling on iOS, and no rubber-band pulling the whole page.
            style={{ WebkitOverflowScrolling: 'touch' }}
            role="grid"
            aria-rowcount={rows}
        >
            <div style={{ height: totalHeight, position: 'relative' }}>
                <div
                    style={{
                        position: 'absolute',
                        top: firstRow * (rowHeight + gap),
                        left: 0,
                        right: 0,
                        display: 'grid',
                        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                        gap,
                    }}
                >
                    {slice.map((item, offset) => (
                        <div key={keyOf(item, start + offset)} style={{ height: rowHeight }}>
                            {renderItem(item, start + offset)}
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
