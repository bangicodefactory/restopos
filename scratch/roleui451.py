import io

p = 'resources/js/backoffice/pages/Employees/Index.tsx'
s = io.open(p, encoding='utf-8', newline='').read()

old = "                <PermissionMatrix abilities={abilities} roles={roles} catalogue={catalogue} grantable={grantable} />"
new = """                <TillRoles roles={roles} />

                <PermissionMatrix abilities={abilities} roles={roles} catalogue={catalogue} grantable={grantable} />"""
assert old in s, 'render anchor'
s = s.replace(old, new, 1)

# Appended after the matrix.
s = s.rstrip() + """

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
        .replace(/[\\u0300-\\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 32);
}
"""

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('role editor added')
