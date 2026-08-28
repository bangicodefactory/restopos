import io

BS = chr(92)

# ── EmployeeAuthService resolves through the table ──────────────────────────
p = 'app/Services/Identity/EmployeeAuthService.php'
s = io.open(p, encoding='utf-8', newline='').read()

old = """    /**
     * Role → ability list. `config/pos.php` holds the defaults; a config may
     * override them through its `role_abilities` JSON column when present.
     *
     * @return list<string>
     */
    public function abilitiesFor(EmployeeRole $role, ?PosConfig $config = null): array
    {
        /** @var array<string, list<string>> $defaults */
        $defaults = (array) $this->config->get('pos.role_abilities', []);

        /** @var array<string, list<string>>|null $override */
        $override = is_array($config?->getAttribute('role_abilities'))
            ? $config->getAttribute('role_abilities')
            : null;

        $abilities = $override[$role->value] ?? $defaults[$role->value] ?? [];

        return array_values(array_unique(array_map(strval(...), $abilities)));
    }"""

new = """    /**
     * Role → ability list, in three tiers (BAN-451).
     *
     *  1. **The register's own override** (`pos_configs.role_abilities`) when it names this role.
     *     Per-register, and it wins over everything: "the closing manager on till 3 may void".
     *  2. **The venue's role** (`till_roles`), which is what the back office now edits.
     *  3. **`config/pos.php`**, the shipping default, reached only when the venue has no row for
     *     this slug at all — a fresh install before `TillRoleSeeder`, or a test fixture.
     *
     * The order of 2 and 3 matters more than it looks. A role row with an **empty** ability list
     * means "this role gets nothing", and falling through to the config there would hand every
     * ability back the moment an operator revoked the last one — the same null-versus-empty trap the
     * per-register override documents. So the fallback is on the row's *absence*, never on its
     * contents.
     *
     * Filtered through `EmployeeAbilities` on the way out: a stored ability the code no longer
     * checks would otherwise reach the client's own gate, which would then allow at the till what
     * the server refuses on sync.
     *
     * @return list<string>
     */
    public function abilitiesFor(EmployeeRole|string $role, ?PosConfig $config = null): array
    {
        $slug = $role instanceof EmployeeRole ? $role->value : $role;

        /** @var array<string, list<string>>|null $override */
        $override = is_array($config?->getAttribute('role_abilities'))
            ? $config->getAttribute('role_abilities')
            : null;

        if (isset($override[$slug])) {
            return EmployeeAbilities::only((array) $override[$slug]);
        }

        $stored = TillRole::query()
            ->where('slug', $slug)
            ->when($config !== null, fn ($query) => $query->where('company_id', $config->company_id))
            ->first();

        if ($stored !== null) {
            return $stored->grantedAbilities();
        }

        /** @var array<string, list<string>> $defaults */
        $defaults = (array) $this->config->get('pos.role_abilities', []);

        return EmployeeAbilities::only((array) ($defaults[$slug] ?? []));
    }"""

assert old in s, 'abilitiesFor anchor'
s = s.replace(old, new, 1)

old = """    /** Does an employee hold an ability on this config? Used by the ingest guard. */
    public function can(Employee $employee, PosConfig $config, string $ability): bool
    {
        return in_array($ability, $this->abilitiesFor($this->roleFor($employee, $config), $config), true);
    }"""
new = """    /** Does an employee hold an ability on this config? Used by the ingest guard. */
    public function can(Employee $employee, PosConfig $config, string $ability): bool
    {
        return in_array($ability, $this->abilitiesFor($this->roleSlugFor($employee, $config), $config), true);
    }"""
assert old in s, 'can anchor'
s = s.replace(old, new, 1)

old = """    /** The resolved register role for this employee on this config. */
    public function roleFor(Employee $employee, PosConfig $config): EmployeeRole
    {
        if (! $employee->relationLoaded('posConfigs')) {
            $employee->load('posConfigs');
        }

        return $employee->roleFor($config);
    }"""
new = """    /** The resolved register role for this employee on this config. */
    public function roleFor(Employee $employee, PosConfig $config): EmployeeRole
    {
        if (! $employee->relationLoaded('posConfigs')) {
            $employee->load('posConfigs');
        }

        return $employee->roleFor($config);
    }

    /**
     * The same answer as `roleFor()`, as a slug that may name a custom role.
     *
     * `roleFor()` returns the enum and therefore cannot say "Shift lead". It is kept because the
     * bootstrap payload and several callers are typed on it, and because for the three system roles
     * the two agree exactly — this one just does not flatten a custom role onto the nearest enum
     * case, which is what made a custom role look like a cashier to every check.
     */
    public function roleSlugFor(Employee $employee, PosConfig $config): string
    {
        if (! $employee->relationLoaded('posConfigs')) {
            $employee->load('posConfigs');
        }

        return $employee->roleSlugFor($config);
    }"""
assert old in s, 'roleFor anchor'
s = s.replace(old, new, 1)

old = """            'role' => $role->value,
            'has_pin' => $employee->hasPin(),
            'abilities' => $this->abilitiesFor($role, $config),"""
new = """            'role' => $slug,
            'has_pin' => $employee->hasPin(),
            'abilities' => $this->abilitiesFor($slug, $config),"""
assert old in s, 'verifier anchor'
s = s.replace(old, new, 1)

old = """        $secret = $this->tokens->deviceSecret($device);
        $role = $this->roleFor($employee, $config);"""
new = """        $secret = $this->tokens->deviceSecret($device);
        // The slug, not the enum: a custom role has to reach the till under its own name, or the
        // client's gate resolves it to whatever enum case it was flattened onto.
        $slug = $this->roleSlugFor($employee, $config);"""
assert old in s, 'verifier head anchor'
s = s.replace(old, new, 1)

for imp in (
    'use App' + BS + 'Models' + BS + 'Identity' + BS + 'TillRole;',
    'use App' + BS + 'Support' + BS + 'Auth' + BS + 'EmployeeAbilities;',
):
    if imp not in s:
        i = s.index('use App' + BS + 'Enums' + BS + 'EmployeeRole;')
        s = s[:i] + imp + chr(10) + s[i:]

io.open(p, 'w', encoding='utf-8', newline='').write(s)

# ── Employee::roleSlugFor ───────────────────────────────────────────────────
p = 'app/Models/Identity/Employee.php'
s = io.open(p, encoding='utf-8', newline='').read()

old = """    public function roleFor(PosConfig $config): EmployeeRole
    {"""
new = """    /**
     * The role slug for this employee on this register, custom roles included (BAN-451).
     *
     * `roleFor()` below answers the same question in the enum, which by construction cannot name a
     * role a venue invented. The pivot's `role_slug` wins when set, then `access_level`, then the
     * employee's own default — the same order as before, with one rung added at the top.
     *
     * That rung is the whole reason the column exists: `access_level` defaults to `basic` and is
     * therefore *always* set once an employee is attached to a register, so `roleFor()` never
     * reached `default_role` for an attached employee. A custom role written to `default_role`
     * alone would have applied to exactly the employees no register had been given.
     */
    public function roleSlugFor(PosConfig $config): string
    {
        $pivot = $this->posConfigs->firstWhere('id', $config->getKey())?->pivot;

        $custom = $pivot?->role_slug;

        if (is_string($custom) && $custom !== '') {
            return $custom;
        }

        return $this->roleFor($config)->value;
    }

    public function roleFor(PosConfig $config): EmployeeRole
    {"""
assert old in s, 'employee roleFor anchor'
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)

print('resolution wired')
