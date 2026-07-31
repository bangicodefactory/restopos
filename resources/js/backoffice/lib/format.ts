/**
 * Dates, durations and small text helpers.
 *
 * Deliberately hand-rolled rather than `Intl`, for the same reason `@domain/receipt` is: the
 * back-office and the printed session report must show the same timestamp for the same session,
 * and two ICU builds are not required to agree.
 */

import { formatDateTime } from '@domain/receipt/index';

/** `2026-07-28T09:12:44.512345Z` → `28/07/2026 09:12`. */
export function dateTime(value: string | null | undefined): string {
    if (!value) return '—';
    return formatDateTime(normalise(value), { date: true, time: true });
}

/** `2026-07-28` → `28/07/2026`. */
export function date(value: string | null | undefined): string {
    if (!value) return '—';
    return formatDateTime(normalise(value), { date: true, time: false });
}

/** `2026-07-28T09:12:44Z` → `09:12`. */
export function time(value: string | null | undefined): string {
    if (!value) return '—';
    return formatDateTime(normalise(value), { date: false, time: true });
}

/**
 * Laravel serialises some timestamps as `2026-07-28 09:31:02` (no `T`, no zone). Safari parses
 * that as `Invalid Date`; every browser parses the ISO form. One replace fixes an entire class
 * of "—" cells.
 */
function normalise(value: string): string {
    return value.includes(' ') && !value.includes('T') ? value.replace(' ', 'T') : value;
}

/** Epoch-safe parse used for sorting and chart axes. Returns 0 for unparseable input. */
export function timestamp(value: string | null | undefined): number {
    if (!value) return 0;
    const ms = Date.parse(normalise(value));
    return Number.isNaN(ms) ? 0 : ms;
}

/** "il y a 3 h", "dans 2 j". Coarse on purpose — nobody needs seconds on a device list. */
export function relative(value: string | null | undefined, now = Date.now()): string {
    if (!value) return '—';
    const ms = timestamp(value);
    if (ms === 0) return '—';

    const deltaSeconds = Math.round((ms - now) / 1000);
    const past = deltaSeconds < 0;
    const abs = Math.abs(deltaSeconds);

    const scale: [number, string][] = [
        [60, 's'],
        [3600, 'min'],
        [86_400, 'h'],
        [Number.POSITIVE_INFINITY, 'j'],
    ];

    let amount = abs;
    let unit = 's';
    if (abs < 60) {
        amount = abs;
        unit = scale[0]?.[1] ?? 's';
    } else if (abs < 3600) {
        amount = Math.round(abs / 60);
        unit = scale[1]?.[1] ?? 'min';
    } else if (abs < 86_400) {
        amount = Math.round(abs / 3600);
        unit = scale[2]?.[1] ?? 'h';
    } else {
        amount = Math.round(abs / 86_400);
        unit = scale[3]?.[1] ?? 'j';
    }

    return past ? `il y a ${amount} ${unit}` : `dans ${amount} ${unit}`;
}

/** Whole numbers with a thin space every three digits: `12 480`. */
export function integer(value: number | string | null | undefined): string {
    const n = typeof value === 'string' ? Number.parseInt(value, 10) : (value ?? 0);
    if (!Number.isFinite(n)) return '0';
    const negative = n < 0;
    const digits = Math.abs(Math.trunc(n)).toString();
    let out = '';
    for (let i = 0; i < digits.length; i++) {
        const fromEnd = digits.length - i;
        out += digits[i];
        if (fromEnd > 1 && (fromEnd - 1) % 3 === 0) out += ' ';
    }
    return negative ? `-${out}` : out;
}

/** `14.5` (decimal hours, as `pos_categories.hour_after` stores them) → `14:30`. */
export function decimalHour(value: string | number | null | undefined): string {
    if (value === null || value === undefined || value === '') return '—';
    const n = typeof value === 'string' ? Number.parseFloat(value) : value;
    if (!Number.isFinite(n)) return '—';
    const hours = Math.floor(n);
    const minutes = Math.round((n - hours) * 60);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** `14:30` → `14.5`. The inverse of `decimalHour`, for the service-window editor. */
export function toDecimalHour(value: string): number | null {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 24 || minutes > 59) return null;
    return hours + minutes / 60;
}

/** Minutes → `1 h 25`. */
export function duration(minutes: number | null | undefined): string {
    if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return '—';
    if (minutes < 60) return `${Math.round(minutes)} min`;
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, '0')}`;
}

/** Today as `YYYY-MM-DD` in the browser's zone — the format every date filter expects. */
export function todayIso(offsetDays = 0): string {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Truncate for a table cell without breaking a word mid-accent. */
export function ellipsis(value: string | null | undefined, max = 60): string {
    if (!value) return '';
    return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Initials for the avatar chip: "Amina Benali" → "AB". */
export function initials(name: string | null | undefined): string {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/).slice(0, 2);
    return parts.map((p) => (p[0] ?? '').toUpperCase()).join('') || '?';
}
