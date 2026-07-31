/**
 * A QR code, rendered client-side from `lib/qr`.
 *
 * One `<path>` for the whole symbol, a white quiet zone of the mandatory four modules, and the
 * encoded text exposed as the accessible name — a screen-reader user gets the URL, which is the
 * only thing the picture actually contains.
 *
 * `shapeRendering="crispEdges"` matters: without it a browser antialiases module boundaries and a
 * QR printed at 25 mm stops scanning.
 */

import { cn } from '@shared/ui';
import { useMemo, type JSX } from 'react';

import { QrTooLongError, encodeQr, qrPath } from '../../lib/qr';

export function QrCode({
    value,
    size = 160,
    className,
    label,
}: {
    value: string;
    /** Rendered pixel size; the SVG itself is resolution-independent. */
    size?: number;
    className?: string;
    label?: string;
}): JSX.Element {
    const encoded = useMemo(() => {
        try {
            const matrix = encodeQr(value);
            return { matrix, path: qrPath(matrix), error: null as string | null };
        } catch (error) {
            return {
                matrix: null,
                path: '',
                error: error instanceof QrTooLongError ? error.message : 'QR encoding failed',
            };
        }
    }, [value]);

    if (encoded.matrix === null) {
        return (
            <div
                className={cn('flex items-center justify-center rounded-pos bg-slate-100 p-3 text-xs text-slate-500', className)}
                style={{ width: size, height: size }}
            >
                {encoded.error}
            </div>
        );
    }

    const quiet = 4;
    const total = encoded.matrix.size + quiet * 2;

    return (
        <svg
            role="img"
            aria-label={label ?? value}
            viewBox={`0 0 ${total} ${total}`}
            width={size}
            height={size}
            shapeRendering="crispEdges"
            className={cn('rounded bg-white', className)}
        >
            <rect width={total} height={total} fill="#ffffff" />
            <g transform={`translate(${quiet} ${quiet})`}>
                <path d={encoded.path} fill="#000000" />
            </g>
        </svg>
    );
}
