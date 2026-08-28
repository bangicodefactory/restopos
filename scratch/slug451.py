import io

BS = chr(92)

# ── the column is a slug, not an enum case ──────────────────────────────────
p = 'app/Models/Identity/Employee.php'
s = io.open(p, encoding='utf-8', newline='').read()

old = "            'default_role' => EmployeeRole::class,"
new = """            // A plain string since BAN-451, not the enum. A venue can author "Shift lead", and an
            // enum cast would throw `ValueError` the moment such a row was read back — on the
            // bootstrap payload, so the till would fail to load rather than fail to grant.
            // `roleFor()` still answers in the enum for the callers typed on it, falling back to the
            // employee's system role when the slug is one the enum does not know.
            'default_role' => 'string',"""
assert old in s, 'cast anchor'
s = s.replace(old, new, 1)

old = """        return $this->default_role;
    }"""
new = """        return EmployeeRole::tryFrom((string) $this->default_role) ?? EmployeeRole::Cashier;
    }"""
assert old in s, 'roleFor tail anchor'
s = s.replace(old, new, 1)

old = """    public function roleSlugFor(PosConfig $config): string
    {
        $pivot = $this->posConfigs->firstWhere('id', $config->getKey())?->pivot;

        $custom = $pivot?->role_slug;

        if (is_string($custom) && $custom !== '') {
            return $custom;
        }

        return $this->roleFor($config)->value;
    }"""
new = """    public function roleSlugFor(PosConfig $config): string
    {
        $pivot = $this->posConfigs->firstWhere('id', $config->getKey())?->pivot;

        $custom = $pivot?->role_slug;

        if (is_string($custom) && $custom !== '') {
            return $custom;
        }

        // No pivot row at all means this register has not been given a staff list, and every active
        // employee may log in on their own default — which is where a custom `default_role` has to
        // survive rather than being flattened onto the nearest enum case.
        if ($pivot === null && is_string($this->default_role) && $this->default_role !== '') {
            return $this->default_role;
        }

        return $this->roleFor($config)->value;
    }"""
assert old in s, 'roleSlugFor anchor'
s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)

# ── the employee form accepts any of the venue's roles ──────────────────────
p = 'app/Http/Controllers/Backoffice/EmployeeController.php'
s = io.open(p, encoding='utf-8', newline='').read()

old = "            'default_role' => [$required, Rule::enum(EmployeeRole::class)],"
new = """            // Any role this venue has, not just the three the product ships with (BAN-451).
            // Resolved through the scoped model rather than `Rule::exists`, which runs on the query
            // builder where `CompanyScope` cannot reach — it would accept another venue's role slug
            // and hand this employee whatever *that* venue had granted it.
            'default_role' => [$required, 'string', 'max:32', static function (string $attribute, mixed $value, callable $fail): void {
                if (! TillRole::query()->where('slug', (string) $value)->where('active', true)->exists()) {
                    $fail('No such role at this venue.');
                }
            }],"""
assert old in s, 'rule anchor'
s = s.replace(old, new, 1)

old = "                'default_role' => (string) ($e->default_role?->value ?? $e->default_role),"
new = "                'default_role' => (string) $e->default_role,"
assert old in s, 'index map anchor'
s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('slugged')
