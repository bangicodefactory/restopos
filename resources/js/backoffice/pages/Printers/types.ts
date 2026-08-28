/**
 * `Printers/Index` props — spec 05 §12.
 *
 * `queue` is `Inertia::defer()`ed: it is a live look at `preparation_print_jobs` in the `queued`
 * and `failed` states and has no business delaying the printer list.
 */

import type { Deferred } from '../../types/inertia';

export type PrinterRow = {
    id: number;
    name: string;
    printer_type: string;
    proxy_ip: string | null;
    printer_ip: string | null;
    printer_port: number | null;
    serial_number: string | null;
    profile: string | null;
    epos_device_id: string | null;
    is_receipt_printer: boolean;
    print_all_categories: boolean;
    characters_per_line: number;
    copies: number;
    sequence: number;
    active: boolean;
    category_ids: number[];
};

export type PrinterCategory = {
    id: number;
    name: string;
    parent_id: number | null;
};

export type PrintJobRow = {
    id: number;
    uuid: string;
    pos_printer_id: number;
    job_type: string;
    state: string;
    attempts: number;
    last_error: string | null;
    queued_at: string | null;
};

export type PrintersIndexProps = {
    printers: PrinterRow[];
    categories: PrinterCategory[];
    queue: Deferred<PrintJobRow[]>;
};

/**
 * `PATCH /printers/{printer}` validates these. `printer_type` is **not** among them, so the
 * connection kind is displayed and locked rather than edited.
 */
export const WRITABLE_PRINTER_KEYS = [
    'name',
    // BAN-432 — the transport, and the field that identifies the physical device. Both columns have
    // always existed; neither was in the PATCH rule set, so the one thing about a seeded printer
    // nobody could change was the thing that decides whether it prints at all.
    'printer_type',
    'serial_number',
    'proxy_ip',
    'printer_ip',
    'printer_port',
    // BAN-426 — both are declared on the register's `PosPrinterRow` and read by its transports:
    // `profile` picks the ESC/POS dialect, `epos_device_id` picks the port on a multi-port TM-i.
    // Neither had a column, so both could only ever be null on the wire.
    'profile',
    'epos_device_id',
    'is_receipt_printer',
    'print_all_categories',
    'characters_per_line',
    'copies',
    'sequence',
    'active',
    'category_ids',
] as const;

/**
 * ESC/POS dialects the shared renderer knows ({@link packages/domain/src/escpos/profiles.ts}).
 * An empty value means `generic`, which prints but may cut and kick the drawer wrongly.
 */
export const PRINTER_PROFILE_OPTIONS: { value: string; label: string }[] = [
    { value: '', label: 'Générique' },
    { value: 'epson-tm-t20', label: 'Epson TM-T20' },
    { value: 'epson-tm-t88', label: 'Epson TM-T88' },
    { value: 'star-tsp100', label: 'Star TSP100' },
    { value: 'bixolon-srp350', label: 'Bixolon SRP-350' },
];

export const PRINTER_TYPE_LABEL: Record<string, string> = {
    iot: 'Boîtier IoT',
    epson_epos: 'Epson ePOS (réseau)',
    network_escpos: 'ESC/POS réseau brut',
    browser: 'Navigateur',
};

/**
 * Which connection fields a printer type actually uses. A network printer with no IP prints
 * nothing and says nothing, so the form marks the field required for its type instead of
 * accepting an empty value.
 */
export const CONNECTION_FIELDS: Record<string, { proxy: boolean; ip: boolean; port: boolean }> = {
    iot: { proxy: true, ip: false, port: false },
    epson_epos: { proxy: false, ip: true, port: true },
    network_escpos: { proxy: false, ip: true, port: true },
    browser: { proxy: false, ip: false, port: false },
};

export const JOB_STATE_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'neutral' | 'info'> = {
    queued: 'info',
    printing: 'warn',
    printed: 'ok',
    failed: 'danger',
    skipped: 'neutral',
};

export type PrinterForm = {
    name: string;
    printer_type: string;
    proxy_ip: string;
    printer_ip: string;
    printer_port: number | null;
    serial_number: string;
    profile: string;
    epos_device_id: string;
    is_receipt_printer: boolean;
    print_all_categories: boolean;
    characters_per_line: number | null;
    copies: number | null;
    sequence: number | null;
    active: boolean;
    category_ids: number[];
};

export function toForm(printer: PrinterRow): PrinterForm {
    return {
        name: printer.name,
        printer_type: printer.printer_type,
        proxy_ip: printer.proxy_ip ?? '',
        printer_ip: printer.printer_ip ?? '',
        printer_port: printer.printer_port,
        serial_number: printer.serial_number ?? '',
        profile: printer.profile ?? '',
        epos_device_id: printer.epos_device_id ?? '',
        is_receipt_printer: printer.is_receipt_printer,
        print_all_categories: printer.print_all_categories,
        characters_per_line: printer.characters_per_line,
        copies: printer.copies,
        sequence: printer.sequence,
        active: printer.active,
        category_ids: printer.category_ids,
    };
}

/** Indented `{value,label}` options for a nested POS-category list. */
export function categoryOptions(categories: readonly PrinterCategory[]): { value: string; label: string }[] {
    const byParent = new Map<number | null, PrinterCategory[]>();
    for (const category of categories) {
        const bucket = byParent.get(category.parent_id);
        if (bucket) bucket.push(category);
        else byParent.set(category.parent_id, [category]);
    }

    const out: { value: string; label: string }[] = [];
    const walk = (parent: number | null, depth: number): void => {
        for (const category of byParent.get(parent) ?? []) {
            out.push({ value: String(category.id), label: `${'— '.repeat(depth)}${category.name}` });
            if (depth < 6) walk(category.id, depth + 1);
        }
    };
    walk(null, 0);

    // Anything whose parent is outside the list would otherwise vanish silently.
    if (out.length < categories.length) {
        const seen = new Set(out.map((option) => option.value));
        for (const category of categories) {
            if (!seen.has(String(category.id))) out.push({ value: String(category.id), label: category.name });
        }
    }

    return out;
}
