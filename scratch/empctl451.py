import io

BS = chr(92)

p = 'app/Http/Controllers/Backoffice/EmployeeController.php'
s = io.open(p, encoding='utf-8', newline='').read()

old = """            'roles' => array_map(static fn (EmployeeRole $r): array => ['value' => $r->value, 'label' => $r->label()], EmployeeRole::cases()),
            'abilities' => config('pos.role_abilities'),
        ]);"""

new = """            // Roles are rows now, not enum cases (BAN-451). The enum still names the three the
            // product ships with — `employees.default_role` defaults to one and `AccessLevel` maps
            // onto all three — but it is no longer the whole list, and rendering from it would hide
            // every role the venue added.
            'roles' => TillRole::query()
                ->orderBy('sequence')
                ->orderBy('name')
                ->get()
                ->map(static fn (TillRole $r): array => [
                    'id' => (int) $r->getKey(),
                    'value' => (string) $r->slug,
                    'label' => (string) $r->name,
                    'is_system' => (bool) $r->is_system,
                    'active' => (bool) $r->active,
                ])->values()->all(),
            'abilities' => TillRole::query()->get()
                ->mapWithKeys(static fn (TillRole $r): array => [$r->slug => $r->grantedAbilities()])
                ->all(),
            // The fixed set the matrix offers. An operator picks from these; a typed ability would
            // save cleanly, read as granted, and be checked by nothing.
            'abilityGroups' => EmployeeAbilities::grouped(),
            // Which of them this particular user may hand out. The matrix greys the rest rather than
            // letting the save be the first time anyone finds out.
            'grantable' => array_values(array_filter(
                EmployeeAbilities::all(),
                fn (string $ability): bool => ($needs = EmployeeAbilities::grantRequires($ability)) === null
                    || $request->user()?->hasPermission($needs) === true,
            )),
        ]);"""

assert old in s, 'index anchor'
s = s.replace(old, new, 1)

old = "    public function index(): Response"
new = "    public function index(Request $request): Response"
assert old in s, 'signature anchor'
s = s.replace(old, new, 1)

for imp in ('use App' + BS + 'Models' + BS + 'Identity' + BS + 'TillRole;',
            'use App' + BS + 'Support' + BS + 'Auth' + BS + 'EmployeeAbilities;'):
    if imp not in s:
        i = s.index('use App' + BS + 'Models' + BS + 'Identity' + BS + 'Employee;')
        s = s[:i] + imp + chr(10) + s[i:]

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('employee controller updated')
