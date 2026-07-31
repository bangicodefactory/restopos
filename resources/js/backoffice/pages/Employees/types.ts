/**
 * `Employees/Index` props — spec 05 §12.
 *
 * PIN and badge are **write-only**. The list carries `has_pin` / `has_badge` booleans and never
 * the hash; `PATCH /employees/{employee}` takes a plaintext `pin` / `badge` and stores only
 * `sha256(value)` — the same hash the per-device offline verifiers are derived from (spec 03
 * §2.3). Nothing in this module ever holds a secret it did not just receive from an input.
 *
 * `abilities` is `config('pos.role_abilities')`: role → list of ability strings. It is
 * configuration, not data, and the contract exposes no write for it, so the matrix is a reader.
 */

import type { EnumOption } from '../../types/inertia';

export type EmployeeRow = {
    id: number;
    name: string;
    job_title: string | null;
    default_role: string;
    color: number;
    has_pin: boolean;
    has_badge: boolean;
    user_id: number | null;
    active: boolean;
};

export type EmployeesIndexProps = {
    employees: EmployeeRow[];
    roles: EnumOption[];
    /** role value → ability strings, from `config/pos.php`. */
    abilities: Record<string, string[]>;
};

/** The keys `PATCH /employees/{employee}` validates. */
export const WRITABLE_EMPLOYEE_KEYS = [
    'name',
    'job_title',
    'default_role',
    'color',
    'active',
    'pin',
    'badge',
] as const;

export type EmployeeForm = {
    name: string;
    job_title: string;
    default_role: string;
    color: number;
    active: boolean;
};

export function toForm(employee: EmployeeRow): EmployeeForm {
    return {
        name: employee.name,
        job_title: employee.job_title ?? '',
        default_role: employee.default_role,
        color: employee.color,
        active: employee.active,
    };
}

/**
 * Every ability mentioned by any role, in a stable order: the matrix's rows.
 *
 * Grouped by the segment before the first dot (`order`, `cash`, `session`…) because that is how
 * an operator reasons about them — "can a cashier do anything with the drawer" is one glance at
 * one group, not a hunt through forty alphabetical rows.
 */
export function abilityGroups(abilities: Record<string, string[]>): { group: string; items: string[] }[] {
    const all = new Set<string>();
    for (const list of Object.values(abilities)) {
        for (const ability of list) all.add(ability);
    }

    const byGroup = new Map<string, string[]>();
    for (const ability of [...all].sort()) {
        const group = ability.split('.')[0] ?? ability;
        const bucket = byGroup.get(group);
        if (bucket) bucket.push(ability);
        else byGroup.set(group, [ability]);
    }

    return [...byGroup.entries()]
        .sort(([a], [b]) => a.localeCompare(b, 'fr'))
        .map(([group, items]) => ({ group, items }));
}

/** Role ranking for the matrix's column order: least privileged first. */
export const ROLE_ORDER: Record<string, number> = {
    minimal: 0,
    cashier: 1,
    manager: 2,
};

/** The swatch palette `ColorIndexField` renders, mirrored here for the list cell. */
export const EMPLOYEE_SWATCHES: readonly string[] = [
    '#94a3b8',
    '#ef4444',
    '#f97316',
    '#f59e0b',
    '#84cc16',
    '#10b981',
    '#06b6d4',
    '#3b82f6',
    '#8b5cf6',
    '#ec4899',
    '#78716c',
    '#0f172a',
];

export function swatchFor(index: number): string {
    return EMPLOYEE_SWATCHES[index % EMPLOYEE_SWATCHES.length] ?? '#94a3b8';
}
