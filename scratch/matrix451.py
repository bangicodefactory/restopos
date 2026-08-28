import io

p = 'resources/js/backoffice/pages/Employees/Index.tsx'
s = io.open(p, encoding='utf-8', newline='').read()

# ── the page passes the new props through ──────────────────────────────────
old = "export default function EmployeesIndex({ employees, roles, abilities }: EmployeesIndexProps): JSX.Element {"
new = """export default function EmployeesIndex({
    employees,
    roles,
    abilities,
    abilityGroups: catalogue,
    grantable,
}: EmployeesIndexProps): JSX.Element {"""
assert old in s, 'signature'
s = s.replace(old, new, 1)

old = "                <PermissionMatrix abilities={abilities} roles={roles} />"
new = "                <PermissionMatrix abilities={abilities} roles={roles} catalogue={catalogue} grantable={grantable} />"
assert old in s, 'render'
s = s.replace(old, new, 1)

# ── the matrix writes ──────────────────────────────────────────────────────
start = s.index("function PermissionMatrix({")
end = s.index("\n}\n", s.index("</Card>\n    );", start)) + 3

matrix = """function PermissionMatrix({
    abilities,
    roles,
    catalogue,
    grantable,
}: {
    abilities: EmployeesIndexProps['abilities'];
    roles: EmployeesIndexProps['roles'];
    catalogue: EmployeesIndexProps['abilityGroups'];
    grantable: EmployeesIndexProps['grantable'];
}): JSX.Element {
    const t = useT();
    const [busy, setBusy] = useState<string | null>(null);

    const columns = useMemo(
        () => [...roles].sort((a, b) => (ROLE_ORDER[a.value] ?? 99) - (ROLE_ORDER[b.value] ?? 99)),
        [roles],
    );

    const may = useMemo(() => new Set(grantable), [grantable]);

    /*
     * One cell, one request.
     *
     * A save button over the whole grid would batch a manager's revoke with a cashier's grant, and
     * the escalation guard refuses per ability — so one refused cell would roll back changes the
     * operator had already been shown as applied. A cell at a time makes what was refused, and what
     * was not, exactly what the screen says.
     */
    const toggle = (role: EmployeesIndexProps['roles'][number], ability: string): void => {
        const held = abilities[role.value] ?? [];
        const next = held.includes(ability)
            ? held.filter((a) => a !== ability)
            : [...held, ability];

        setBusy(`${role.value}:${ability}`);

        router.patch(
            routes.tillRoles.update(role.id),
            { abilities: next },
            { preserveScroll: true, onFinish: () => setBusy(null) },
        );
    };

    return (
        <Card>
            <CardHeader title={t('employee.matrix')} description={t('employee.matrixHint')} />
            <CardBody className="p-0">
                {columns.length === 0 ? (
                    <EmptyState title={t('state.empty')} />
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full border-collapse text-sm">
                            <caption className="sr-only">{t('employee.matrix')}</caption>
                            <thead className="bg-slate-50">
                                <tr>
                                    <th scope="col" className="px-4 py-2 text-start text-xs uppercase text-slate-600">
                                        {t('employee.ability')}
                                    </th>
                                    {columns.map((role) => (
                                        <th
                                            key={role.value}
                                            scope="col"
                                            className="px-4 py-2 text-center text-xs uppercase text-slate-600"
                                        >
                                            {role.label}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {Object.entries(catalogue).map(([group, items]) => (
                                    <Fragment key={group}>
                                        <tr className="bg-slate-100/60">
                                            <th
                                                scope="colgroup"
                                                colSpan={columns.length + 1}
                                                className="px-4 py-1.5 text-start text-xs font-semibold uppercase tracking-wide text-slate-600"
                                            >
                                                {t(`employee.abilityGroup.${group}` as never)}
                                            </th>
                                        </tr>
                                        {items.map((ability) => {
                                            const grantableHere = may.has(ability);

                                            return (
                                                <tr key={ability}>
                                                    <th
                                                        scope="row"
                                                        className="px-4 py-1.5 text-start font-mono text-xs font-normal text-slate-700"
                                                    >
                                                        {ability}
                                                        {grantableHere ? null : (
                                                            <span className="ms-2 font-sans text-[11px] text-slate-500">
                                                                {t('employee.abilityLocked')}
                                                            </span>
                                                        )}
                                                    </th>
                                                    {columns.map((role) => {
                                                        const granted = (abilities[role.value] ?? []).includes(ability);
                                                        const key = `${role.value}:${ability}`;

                                                        return (
                                                            <td key={role.value} className="px-4 py-1.5 text-center">
                                                                <button
                                                                    type="button"
                                                                    disabled={!grantableHere || busy !== null}
                                                                    aria-pressed={granted}
                                                                    aria-label={`${role.label} — ${ability}`}
                                                                    onClick={() => toggle(role, ability)}
                                                                    className={cn(
                                                                        'rounded-pos px-2 text-base leading-6',
                                                                        granted ? 'text-ok-fg' : 'text-slate-300',
                                                                        grantableHere
                                                                            ? 'hover:bg-slate-100'
                                                                            : 'cursor-not-allowed opacity-60',
                                                                        busy === key && 'animate-pulse',
                                                                        FOCUS_RING,
                                                                    )}
                                                                >
                                                                    <span aria-hidden>{granted ? '✓' : '·'}</span>
                                                                    <span className="sr-only">
                                                                        {granted ? t('state.yes') : t('state.no')}
                                                                    </span>
                                                                </button>
                                                            </td>
                                                        );
                                                    })}
                                                </tr>
                                            );
                                        })}
                                    </Fragment>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </CardBody>
        </Card>
    );
}
"""

s = s[:start] + matrix + s[end:]
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('matrix is an editor')
