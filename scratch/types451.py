import io

p = 'resources/js/backoffice/pages/Employees/types.ts'
s = io.open(p, encoding='utf-8', newline='').read()

old = """ * `abilities` is `config('pos.role_abilities')`: role → list of ability strings. It is
 * configuration, not data, and the contract exposes no write for it, so the matrix is a reader.
 */"""
new = """ * `abilities` is role slug → ability strings, read from `till_roles` since BAN-451. It was
 * `config('pos.role_abilities')` and therefore a reader; roles are rows now and the matrix writes.
 *
 * `grantable` is the subset **this user** may hand out. Three abilities reach back into the back
 * office — `config.manage` most of all — and granting one needs the matching axis-1 permission, so
 * the matrix greys the rest rather than letting the save be the first time anyone finds out.
 */"""
assert old in s, 'docblock'
s = s.replace(old, new, 1)

old = """export type EmployeesIndexProps = {
    employees: EmployeeRow[];
    roles: EnumOption[];
    /** role value → ability strings, from `config/pos.php`. */
    abilities: Record<string, string[]>;
};"""
new = """/** One of the venue's till roles. `is_system` marks the three the product ships with. */
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
};"""
assert old in s, 'props'
s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('types updated')
