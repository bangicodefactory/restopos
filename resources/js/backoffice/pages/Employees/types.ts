/**
 * `Employees/Index` props — spec 05 §12.
 *
 * PIN and badge are **write-only**. The list carries `has_pin` / `has_badge` booleans and never
 * the hash; `PATCH /employees/{employee}` takes a plaintext `pin` / `badge` and stores only
 * `sha256(value)` — the same hash the per-device offline verifiers are derived from (spec 03
 * §2.3). Nothing in this module ever holds a secret it did not just receive from an input.
 *
 * `abilities` is role slug → ability strings, read from `till_roles` since BAN-451. It was
 * `config('pos.role_abilities')` and therefore a reader; roles are rows now and the matrix writes.
 *
 * `grantable` is the subset **this user** may hand out. Three abilities reach back into the back
 * office — `config.manage` most of all — and granting one needs the matching axis-1 permission, so
 * the matrix greys the rest rather than letting the save be the first time anyone finds out.
 */

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

/** One of the venue's till roles. `is_system` marks the three the product ships with. */
export type TillRoleRow = {
    id: number;
    value: string;
    label: string;
    is_system: boolean;
    active: boolean;
};

export type EmployeesIndexProps = {
    employees: EmployeeRow[];
    roles: TillRoleRow[];
    /** role slug → ability strings, from `till_roles`. */
    abilities: Record<string, string[]>;
    /** The fixed set an operator picks from, grouped as a shift reads. */
    abilityGroups: Record<string, string[]>;
    /** Which of them this user may grant. */
    grantable: string[];
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
