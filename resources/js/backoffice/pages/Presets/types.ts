/**
 * `Presets/Index` and `Presets/Edit` props — spec §2.D (BOF-113).
 *
 * Hours are `decimal(5,2)` and arrive as decimal strings: `"18.50"` is half past six. That is how
 * Odoo spells an attendance and how the register reads one back, so the editor converts at the edge
 * rather than storing a second representation.
 */

export type PresetIdentification = 'none' | 'name' | 'address';
export type PresetServiceAt = 'counter' | 'table' | 'delivery';
export type DayPeriod = 'morning' | 'afternoon' | 'evening';

export type PresetListRow = {
    id: number;
    name: string;
    identification: PresetIdentification;
    service_at: PresetServiceAt;
    pricelist_id: number | null;
    fiscal_position_id: number | null;
    use_timing: boolean;
    slots_per_interval: number;
    interval_minutes: number;
    available_in_self: boolean;
    /** The modes the product ships with. Renameable, re-priceable, never removable. */
    is_system: boolean;
    sequence: number;
    active: boolean;
    window_count: number;
};

export type NamedRow = { id: number; name: string };

export type PresetsIndexProps = {
    presets: PresetListRow[];
    pricelists: NamedRow[];
    fiscalPositions: NamedRow[];
};

export type PresetRecord = {
    id: number;
    company_id: number;
    name: string;
    pricelist_id: number | null;
    fiscal_position_id: number | null;
    identification: PresetIdentification;
    is_return: boolean;
    use_guest: boolean;
    color: number;
    image_media_id: number | null;
    sequence: number;
    use_timing: boolean;
    slots_per_interval: number;
    interval_minutes: number;
    available_in_self: boolean;
    service_at: PresetServiceAt;
    notification_template_id: number | null;
    is_system: boolean;
    active: boolean;
};

export type ServiceWindowRecord = {
    id: number;
    pos_preset_id: number;
    /** 0 = Monday … 6 = Sunday, matching the column comment and `scopeOnDay`. */
    day_of_week: number;
    hour_from: string;
    hour_to: string;
    day_period: DayPeriod | null;
};

export type PresetEditProps = {
    preset: PresetRecord;
    windows: ServiceWindowRecord[];
    pricelists: NamedRow[];
    fiscalPositions: NamedRow[];
};

/** `"18.50"` → `"18:30"`. The stored form is a fraction of an hour, not minutes. */
export function hourToClock(decimalHour: string | number): string {
    const value = Number(decimalHour);
    if (!Number.isFinite(value)) return '00:00';

    const hours = Math.floor(value);
    const minutes = Math.round((value - hours) * 60);

    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** `"18:30"` → `18.5`. Returns null for anything a time input would not produce. */
export function clockToHour(clock: string): number | null {
    const match = /^(\d{1,2}):(\d{2})$/.exec(clock);
    if (!match) return null;

    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 24 || minutes > 59) return null;

    return hours + minutes / 60;
}
