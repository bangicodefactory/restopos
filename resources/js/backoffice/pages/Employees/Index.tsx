/**
 * `Employees/Index` — `GET /employees` (BOF-120…BOF-129).
 *
 * The list and editor, plus the role/permission matrix.
 *
 * **Secrets are write-only, and the UI is built around that** rather than working against it. The
 * list shows `has_pin` / `has_badge`, never a value; the editor's PIN and badge fields start
 * empty and stay empty; leaving them empty changes nothing, and clearing a PIN is a separate,
 * confirmed action that sends an explicit `null`. There is deliberately no "show current PIN":
 * the server only ever had the sha256, so there is nothing to show, and a control implying
 * otherwise would be a lie about how the offline verifiers work.
 *
 * **The matrix is a reader.** Abilities per role come from `config/pos.php`, which is
 * configuration rather than data, and the contract exposes no write for it. Presenting it as a
 * grid of checkboxes that cannot be saved would be worse than presenting it as what it is — so it
 * is a table, grouped by ability family, with the reason stated once.
 */

import { Head, router, useForm } from '@inertiajs/react';
import { Button, FOCUS_RING, cn, useToast } from '@shared/ui';
import { Fragment, useMemo, useState, type JSX } from 'react';

import { DataTable, type Column } from '../../components/data-table/DataTable';
import {
    ColorIndexField,
    SaveBar,
    SelectField,
    TextField,
    ToggleField,
    useDirtyGuard,
} from '../../components/form';
import { FormSection } from '../../components/form/fields';
import { AppLayout } from '../../components/layout/AppLayout';
import { ConfirmAction } from '../../components/ui/ConfirmAction';
import { DeleteAction } from '../../components/ui/DeleteAction';
import { Badge, Card, CardBody, CardHeader, EmptyState } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { printBadge } from '../../lib/printBadge';
import { routes } from '../../lib/routes';

import {
    ROLE_ORDER,
    swatchFor,
    toForm,
    type EmployeeRow,
    type EmployeesIndexProps,
} from './types';

export default function EmployeesIndex({
    employees,
    roles,
    abilities,
    abilityGroups: catalogue,
    grantable,
}: EmployeesIndexProps): JSX.Element {
    const t = useT();
    const [search, setSearch] = useState('');
    const [selectedId, setSelectedId] = useState<number | null>(employees[0]?.id ?? null);

    const selected = employees.find((employee) => employee.id === selectedId) ?? null;
    const roleLabel = useMemo(() => new Map(roles.map((role) => [role.value, role.label])), [roles]);

    const columns: Column<EmployeeRow>[] = [
        {
            id: 'name',
            header: t('employee.title'),
            locked: true,
            cell: (row) => (
                <span className="flex items-center gap-2">
                    <span
                        aria-hidden
                        className="h-3 w-3 shrink-0 rounded-full"
                        style={{ backgroundColor: swatchFor(row.color) }}
                    />
                    <button
                        type="button"
                        onClick={() => setSelectedId(row.id)}
                        aria-pressed={row.id === selectedId}
                        className="text-start font-medium text-brand-700 hover:underline"
                    >
                        {row.name}
                    </button>
                </span>
            ),
            sortValue: (row) => row.name,
            searchValue: (row) => `${row.name} ${row.job_title ?? ''}`,
            exportValue: (row) => row.name,
        },
        {
            id: 'job_title',
            header: t('employee.jobTitle'),
            cell: (row) => row.job_title ?? '—',
            sortValue: (row) => row.job_title,
            exportValue: (row) => row.job_title,
        },
        {
            id: 'default_role',
            header: t('employee.role'),
            cell: (row) => <Badge tone="brand">{roleLabel.get(row.default_role) ?? row.default_role}</Badge>,
            sortValue: (row) => ROLE_ORDER[row.default_role] ?? 99,
            searchValue: (row) => roleLabel.get(row.default_role) ?? row.default_role,
            exportValue: (row) => row.default_role,
        },
        {
            id: 'has_pin',
            header: t('employee.pin'),
            align: 'center',
            cell: (row) => (
                <Badge tone={row.has_pin ? 'ok' : 'warn'}>
                    {row.has_pin ? t('employee.pinSet') : t('employee.pinNone')}
                </Badge>
            ),
            sortValue: (row) => row.has_pin,
            exportValue: (row) => (row.has_pin ? '1' : '0'),
        },
        {
            id: 'has_badge',
            header: t('employee.badge'),
            align: 'center',
            cell: (row) => (
                <Badge tone={row.has_badge ? 'ok' : 'neutral'}>
                    {row.has_badge ? t('employee.badgeSet') : t('employee.badgeNone')}
                </Badge>
            ),
            sortValue: (row) => row.has_badge,
            exportValue: (row) => (row.has_badge ? '1' : '0'),
        },
        {
            id: 'user_id',
            header: t('employee.linkedUser'),
            align: 'end',
            defaultHidden: true,
            cell: (row) => (row.user_id === null ? '—' : `#${row.user_id}`),
            sortValue: (row) => row.user_id,
            exportValue: (row) => row.user_id,
        },
        {
            id: 'active',
            header: t('state.active'),
            align: 'center',
            cell: (row) => (
                <Badge tone={row.active ? 'ok' : 'neutral'}>
                    {row.active ? t('state.active') : t('state.inactive')}
                </Badge>
            ),
            sortValue: (row) => row.active,
            exportValue: (row) => (row.active ? '1' : '0'),
        },
    ];

    return (
        <AppLayout title={t('employee.title')} description={t('employee.secretHint')}>
            <Head title={t('employee.title')} />

            <div className="space-y-6">
                <DataTable
                    columns={columns}
                    rows={employees}
                    getRowId={(row) => row.id}
                    storageKey="employees"
                    caption={t('employee.title')}
                    search={{ value: search, onChange: setSearch }}
                    exportFilename="employes"
                    perPage={50}
                    emptyTitle={t('state.empty')}
                    emptyHint={t('employee.hireHint')}
                    rowClassName={(row) => (row.id === selectedId ? 'bg-brand-50' : undefined)}
                />

                {selected === null ? (
                    <Card>
                        <EmptyState title={t('state.empty')} hint={t('employee.hireHint')} />
                    </Card>
                ) : (
                    <EmployeeEditor key={selected.id} employee={selected} roles={roles} />
                )}

                <HireForm roles={roles} />

                <TillRoles roles={roles} />

                <PermissionMatrix abilities={abilities} roles={roles} catalogue={catalogue} grantable={grantable} />
            </div>
        </AppLayout>
    );
}

// ───────────────────────────────────────────────────────────── editor

type EmployeeEditForm = ReturnType<typeof toForm> & { pin: string; badge: string };

function EmployeeEditor({
    employee,
    roles,
}: {
    employee: EmployeeRow;
    roles: EmployeesIndexProps['roles'];
}): JSX.Element {
    const t = useT();

    const form = useForm<EmployeeEditForm>({ ...toForm(employee), pin: '', badge: '' });
    const toast = useToast();
    const [printing, setPrinting] = useState(false);

    useDirtyGuard(form.isDirty, t('confirm.leave'));

    /** Empty secret fields must not be sent: `''` would hash to a valid, guessable PIN. */
    const submit = (): void => {
        form.transform((data) => {
            const payload: Record<string, unknown> = {
                name: data.name,
                job_title: data.job_title === '' ? null : data.job_title,
                default_role: data.default_role,
                color: data.color,
                active: data.active,
            };
            if (data.pin.trim() !== '') payload.pin = data.pin.trim();
            if (data.badge.trim() !== '') payload.badge = data.badge.trim();
            return payload;
        });
        form.patch(routes.employees.update(employee.id), {
            preserveScroll: true,
            onSuccess: () => form.setData((current) => ({ ...current, pin: '', badge: '' })),
        });
    };

    return (
        <Card>
            <CardHeader
                title={employee.name}
                description={employee.job_title ?? undefined}
                actions={
                    <>
                        <Badge tone={employee.has_pin ? 'ok' : 'warn'}>
                            {employee.has_pin ? t('employee.pinSet') : t('employee.pinNone')}
                        </Badge>
                        <Badge tone={employee.active ? 'ok' : 'neutral'}>
                            {employee.active ? t('state.active') : t('state.inactive')}
                        </Badge>
                        {/*
                          * Refused once they have rung anything up — the server says so and names
                          * the count. `DeleteAction` surfaces that refusal, which an Inertia delete
                          * otherwise drops on the floor: it arrives as `errors`, and a delete has no
                          * field to render one under.
                          */}
                        <DeleteAction
                            url={routes.employees.destroy(employee.id)}
                            name={employee.name}
                        />
                    </>
                }
            />
            <CardBody>
                <FormSection title={t('config.group.general')}>
                    <TextField
                        label="Nom"
                        required
                        value={form.data.name}
                        error={form.errors.name}
                        onChange={(value) => form.setData('name', value)}
                        maxLength={120}
                    />
                    <TextField
                        label={t('employee.jobTitle')}
                        value={form.data.job_title}
                        error={form.errors.job_title}
                        onChange={(value) => form.setData('job_title', value)}
                        maxLength={80}
                    />
                    <SelectField
                        label={t('employee.role')}
                        value={form.data.default_role}
                        error={form.errors.default_role}
                        onChange={(value) => form.setData('default_role', value)}
                        options={roles}
                        hint={t('employee.roleHint')}
                    />
                    <ToggleField
                        label={t('state.active')}
                        checked={form.data.active}
                        onChange={(checked) => form.setData('active', checked)}
                        description={t('employee.activeHint')}
                    />
                    <ColorIndexField
                        label={t('employee.colour')}
                        value={form.data.color}
                        error={form.errors.color}
                        onChange={(value) => form.setData('color', value)}
                    />
                </FormSection>

                <FormSection title={t('employee.secrets')} description={t('employee.secretHint')}>
                    <TextField
                        label={t('employee.pin')}
                        type="password"
                        autoComplete="new-password"
                        value={form.data.pin}
                        error={form.errors.pin}
                        onChange={(value) => form.setData('pin', value)}
                        maxLength={12}
                        hint={employee.has_pin ? t('employee.pinReplaceHint') : t('employee.pinNewHint')}
                    />
                    <TextField
                        label={t('employee.badge')}
                        type="password"
                        autoComplete="off"
                        value={form.data.badge}
                        error={form.errors.badge}
                        onChange={(value) => form.setData('badge', value)}
                        maxLength={64}
                        hint={employee.has_badge ? t('employee.badgeReplaceHint') : t('employee.badgeNewHint')}
                    />
                    <div className="md:col-span-2">
                        {/*
                          * Enabled only while the value is on screen, and that is not a UI nicety.
                          * `barcode_hash` is a SHA-256: there is nothing to reprint from a record,
                          * so the only moment a badge can be printed is the moment it is typed. A
                          * lost badge is reissued, not reprinted.
                          */}
                        <Button
                            variant="secondary"
                            disabled={form.data.badge.trim() === ''}
                            loading={printing}
                            onClick={() => {
                                setPrinting(true);
                                void printBadge({
                                    name: form.data.name,
                                    jobTitle: form.data.job_title,
                                    badge: form.data.badge,
                                })
                                    .then((ok) => {
                                        if (!ok) {
                                            toast.show({
                                                id: 'badge',
                                                tone: 'danger',
                                                title: t('employee.badgePrintFailed'),
                                            });
                                        }
                                    })
                                    .finally(() => setPrinting(false));
                            }}
                        >
                            {t('employee.printBadge')}
                        </Button>
                        <p className="mt-1 text-xs text-slate-500">{t('employee.printBadgeHint')}</p>
                    </div>
                    <div className="flex flex-wrap items-end gap-2 md:col-span-2">
                        <ConfirmAction
                            label={t('employee.clearPin')}
                            title={t('employee.clearPin')}
                            message={t('employee.clearPinConfirm', { name: employee.name })}
                            disabled={!employee.has_pin}
                            onConfirm={() =>
                                router.patch(
                                    routes.employees.update(employee.id),
                                    { pin: null },
                                    { preserveScroll: true },
                                )
                            }
                        />
                        <ConfirmAction
                            label={t('employee.clearBadge')}
                            title={t('employee.clearBadge')}
                            message={t('employee.clearBadgeConfirm', { name: employee.name })}
                            disabled={!employee.has_badge}
                            onConfirm={() =>
                                router.patch(
                                    routes.employees.update(employee.id),
                                    { badge: null },
                                    { preserveScroll: true },
                                )
                            }
                        />
                    </div>
                </FormSection>

                <SaveBar
                    dirty={form.isDirty}
                    processing={form.processing}
                    errorCount={Object.keys(form.errors).length}
                    onSave={submit}
                    onCancel={() => form.reset()}
                />
            </CardBody>
        </Card>
    );
}

// ───────────────────────────────────────────────────────────── hire

/**
 * Adding a starter (BOF-120, BAN-446).
 *
 * Name and role only. The PIN and the badge are set afterwards on the record, because both are
 * write-only credentials and a hire form that collects them invites writing them on the same piece
 * of paper as the name.
 */
function HireForm({ roles }: { roles: EmployeesIndexProps['roles'] }): JSX.Element {
    const t = useT();
    const form = useForm<{ name: string; default_role: string }>({
        name: '',
        default_role: roles[0]?.value ?? 'cashier',
    });

    return (
        <Card>
            <CardHeader title={t('employee.hire')} description={t('employee.hireHint')} />
            <CardBody className="space-y-4">
                <FormSection>
                    <TextField
                        label={t('employee.nameLabel')}
                        value={form.data.name}
                        error={form.errors.name}
                        onChange={(value) => form.setData('name', value)}
                    />
                    <SelectField
                        label={t('employee.role')}
                        value={form.data.default_role}
                        error={form.errors.default_role}
                        options={roles.map((role) => ({ value: role.value, label: role.label }))}
                        onChange={(value) => form.setData('default_role', value)}
                    />
                </FormSection>

                <Button
                    loading={form.processing}
                    disabled={form.data.name.trim() === ''}
                    onClick={() =>
                        form.post(routes.employees.store(), {
                            preserveScroll: true,
                            onSuccess: () => form.reset(),
                        })
                    }
                >
                    {t('employee.hire')}
                </Button>
            </CardBody>
        </Card>
    );
}

// ───────────────────────────────────────────────────────────── matrix

/**
 * The registry's groups, in the order it declares them.
 *
 * A `t()` key is a closed union, which is what stops a missing translation reaching a screen — so a
 * group name from the server resolves through this rather than being interpolated.
 */
const GROUP_LABEL: Record<string, 'employee.abilityGroup.order' | 'employee.abilityGroup.money' | 'employee.abilityGroup.cash' | 'employee.abilityGroup.receipt' | 'employee.abilityGroup.room' | 'employee.abilityGroup.kitchen' | 'employee.abilityGroup.admin'> = {
    order: 'employee.abilityGroup.order',
    money: 'employee.abilityGroup.money',
    cash: 'employee.abilityGroup.cash',
    receipt: 'employee.abilityGroup.receipt',
    room: 'employee.abilityGroup.room',
    kitchen: 'employee.abilityGroup.kitchen',
    admin: 'employee.abilityGroup.admin',
};

function PermissionMatrix({
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
                                                {t(GROUP_LABEL[group] ?? 'employee.ability')}
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

/**
 * The venue's till roles (BOF-118, BAN-451).
 *
 * Sits above the matrix because the matrix's columns *are* these rows: adding a role adds a column,
 * and there is no other way to discover that.
 *
 * The three the product ships with can be renamed and re-granted but not removed, and their
 * identifier is frozen — `employees.default_role` and the register pivot both name them by slug and
 * neither is a foreign key, so renaming `manager` would leave every manager pointing at nothing.
 */
function TillRoles({ roles }: { roles: EmployeesIndexProps['roles'] }): JSX.Element {
    const t = useT();
    const [open, setOpen] = useState(false);

    const form = useForm<{ slug: string; name: string }>({ slug: '', name: '' });

    return (
        <Card>
            <CardHeader title={t('employee.roles')} description={t('employee.rolesHint')} />
            <CardBody className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                    {roles.map((role) => (
                        <span key={role.value} className="flex items-center gap-1">
                            <Badge tone={role.is_system ? 'neutral' : 'brand'}>{role.label}</Badge>
                            {role.is_system ? (
                                <span className="text-[11px] text-slate-500">{t('employee.roleSystem')}</span>
                            ) : (
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() =>
                                        router.delete(routes.tillRoles.destroy(role.id), { preserveScroll: true })
                                    }
                                >
                                    {t('action.delete')}
                                </Button>
                            )}
                        </span>
                    ))}
                </div>

                {open ? (
                    <>
                        <FormSection>
                            <TextField
                                label={t('employee.roleName')}
                                value={form.data.name}
                                error={form.errors.name}
                                required
                                onChange={(value) =>
                                    form.setData((data) => ({
                                        ...data,
                                        name: value,
                                        // Suggested from the name, and editable: the slug is what
                                        // every stored assignment carries and it never changes
                                        // again, so it is worth getting right once rather than
                                        // asking for it twice.
                                        slug: data.slug === '' ? slugify(value) : data.slug,
                                    }))
                                }
                            />
                            <TextField
                                label={t('employee.roleSlug')}
                                hint={t('employee.roleSlugHint')}
                                value={form.data.slug}
                                error={form.errors.slug}
                                onChange={(value) => form.setData('slug', slugify(value))}
                            />
                        </FormSection>

                        <div className="flex gap-2">
                            <Button
                                loading={form.processing}
                                onClick={() =>
                                    form.post(routes.tillRoles.store(), {
                                        preserveScroll: true,
                                        onSuccess: () => {
                                            form.reset();
                                            setOpen(false);
                                        },
                                    })
                                }
                            >
                                {t('action.save')}
                            </Button>
                            <Button variant="ghost" onClick={() => setOpen(false)}>
                                {t('action.cancel')}
                            </Button>
                        </div>
                    </>
                ) : (
                    <Button variant="ghost" onClick={() => setOpen(true)}>
                        {t('employee.addRole')}
                    </Button>
                )}
            </CardBody>
        </Card>
    );
}

/** The shape the server's slug rule accepts, applied as the operator types rather than after. */
function slugify(value: string): string {
    return value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 32);
}
