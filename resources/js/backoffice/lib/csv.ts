/**
 * Client-side CSV export (BOF-177).
 *
 * Spec 05 exposes no export endpoint, and the report pages already hold every row they display,
 * so the honest implementation is to serialise what is on screen rather than pretend a server
 * export exists. Two details that matter for the people who actually open these files:
 *
 *  - a UTF-8 BOM, or Excel on Windows renders "Crème brûlée" as mojibake;
 *  - `;` as the delimiter, because a French locale Excel splits on semicolons and every amount
 *    we write contains a comma.
 */

export type CsvColumn<T> = {
    header: string;
    value: (row: T) => string | number | null | undefined;
};

const BOM = '﻿';

export function toCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[], delimiter = ';'): string {
    const lines: string[] = [columns.map((c) => escapeCell(c.header, delimiter)).join(delimiter)];

    for (const row of rows) {
        lines.push(columns.map((c) => escapeCell(c.value(row), delimiter)).join(delimiter));
    }

    return BOM + lines.join('\r\n');
}

function escapeCell(value: string | number | null | undefined, delimiter: string): string {
    if (value === null || value === undefined) return '';
    const text = String(value);
    if (text.includes('"') || text.includes(delimiter) || text.includes('\n') || text.includes('\r')) {
        return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
}

/** Trigger a download without a server round trip. */
export function downloadCsv<T>(
    filename: string,
    rows: readonly T[],
    columns: readonly CsvColumn<T>[],
): void {
    const blob = new Blob([toCsv(rows, columns)], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    // Revoke on the next tick: Safari cancels an in-flight download if the URL dies too early.
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
