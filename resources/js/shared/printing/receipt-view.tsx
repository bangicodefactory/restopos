import type { ReceiptDescriptor, ReceiptElement } from '@domain/receipt/index';
import { toDescriptor } from '@domain/receipt/index';
import type { EscPosDoc } from '@domain/escpos/index';
import type { JSX } from 'react';

import { cn } from '../ui/cn';

/**
 * On-screen rendering of the very same document the printer receives.
 *
 * The descriptor already carries character-exact line breaking, dot leaders and column layout
 * (computed by the same helpers the ESC/POS serializer uses), so this component's only job is to
 * pick a monospace font and apply the style flags. That is what makes the preview trustworthy and
 * what makes `window.print()` a usable fallback rather than a different-looking second receipt.
 */

const SIZE_CLASS = {
    sm: 'text-[0.6875rem] leading-tight',
    md: 'text-[0.8125rem] leading-snug',
    lg: 'text-[1.125rem] leading-snug font-semibold tracking-tight',
    xl: 'text-[1.5rem] leading-none font-bold tracking-tight',
} as const;

const ALIGN_CLASS = { left: 'text-left', center: 'text-center', right: 'text-right' } as const;

function Element({ element }: { element: ReceiptElement }): JSX.Element | null {
    switch (element.kind) {
        case 'line':
            return (
                <div
                    className={cn(
                        'whitespace-pre font-receipt',
                        SIZE_CLASS[element.size],
                        ALIGN_CLASS[element.align],
                        element.bold && 'font-bold',
                        element.underline && 'underline',
                        element.invert && 'bg-black text-white',
                    )}
                >
                    {element.text === '' ? ' ' : element.text}
                </div>
            );
        case 'rule':
            return <div className="whitespace-pre font-receipt text-[0.8125rem] leading-snug">{element.text}</div>;
        case 'space':
            return <div style={{ height: `${element.n * 0.9}em` }} aria-hidden />;
        case 'qr':
            return (
                <div className="my-2 flex justify-center">
                    <div
                        className="grid place-items-center border border-dashed border-current p-2 text-center font-receipt text-[0.625rem]"
                        style={{ width: `${element.size * 24}px`, height: `${element.size * 24}px` }}
                        aria-label={`QR code: ${element.data}`}
                    >
                        QR
                    </div>
                </div>
            );
        case 'barcode':
            return (
                <div className="my-2 text-center font-receipt text-[0.6875rem]">
                    <div className="mx-auto h-10 w-3/4 bg-[repeating-linear-gradient(90deg,currentColor_0_2px,transparent_2px_4px)]" />
                    <div>{element.data}</div>
                </div>
            );
        case 'image':
            return (
                <div className="my-2 flex justify-center">
                    <div className="h-12 w-32 border border-dashed border-current" aria-label={element.key ?? 'logo'} />
                </div>
            );
    }
}

export type ReceiptViewProps = {
    doc?: EscPosDoc;
    descriptor?: ReceiptDescriptor;
    className?: string;
};

/** Width in `ch` units so the preview is exactly as wide as the paper. */
export function ReceiptView({ doc, descriptor, className }: ReceiptViewProps): JSX.Element | null {
    const resolved = descriptor ?? (doc ? toDescriptor(doc) : null);
    if (!resolved) return null;

    return (
        <div
            className={cn('mx-auto bg-white p-3 text-black shadow-pos', className)}
            style={{ width: `${resolved.width + 2}ch` }}
            data-receipt-kind={resolved.kind}
            data-receipt-copy={resolved.copy}
        >
            {resolved.elements.map((element, index) => (
                <Element key={index} element={element} />
            ))}
        </div>
    );
}

/**
 * Static HTML for the print iframe.
 *
 * Rendered as a string rather than with `renderToString` so `BrowserPrintTransport` does not pull
 * in `react-dom/server` — the register bundle is loaded from a precache on a tablet and every
 * kilobyte on that path is a millisecond of cold boot.
 */
export function descriptorToPrintHtml(descriptor: ReceiptDescriptor, widthMm = 80): string {
    const rows = descriptor.elements
        .map((element) => {
            switch (element.kind) {
                case 'line': {
                    const styles = [
                        `text-align:${element.align}`,
                        element.bold ? 'font-weight:700' : '',
                        element.underline ? 'text-decoration:underline' : '',
                        element.invert ? 'background:#000;color:#fff' : '',
                        `font-size:${{ sm: 10, md: 12, lg: 18, xl: 24 }[element.size]}px`,
                    ]
                        .filter(Boolean)
                        .join(';');
                    return `<div style="${styles}">${escapeHtml(element.text) || '&nbsp;'}</div>`;
                }
                case 'rule':
                    return `<div>${escapeHtml(element.text)}</div>`;
                case 'space':
                    return `<div style="height:${element.n * 0.9}em"></div>`;
                case 'qr':
                    return `<div style="text-align:center;margin:6px 0">[QR] ${escapeHtml(element.data)}</div>`;
                case 'barcode':
                    return `<div style="text-align:center;margin:6px 0">${escapeHtml(element.data)}</div>`;
                case 'image':
                    return `<div style="text-align:center;margin:6px 0">[logo]</div>`;
            }
        })
        .join('');

    return [
        '<!DOCTYPE html><html><head><meta charset="utf-8">',
        `<style>@page{size:${widthMm}mm auto;margin:0}`,
        'html,body{margin:0;padding:0}',
        'body{font-family:ui-monospace,"Courier New",monospace;white-space:pre;padding:2mm}',
        '</style></head><body>',
        rows,
        '</body></html>',
    ].join('');
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
