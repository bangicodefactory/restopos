import io

BS = chr(92)

# ── routes ──────────────────────────────────────────────────────────────────
p = 'routes/web.php'
s = io.open(p, encoding='utf-8', newline='').read()
anchor = "    // Bringing a catalogue in from a spreadsheet (BOF-093, BAN-491)."
assert anchor in s, 'route anchor'
s = s.replace(anchor, """    // What a till employee may do — axis 2 (BOF-118, BAN-451).
    Route::post('till-roles', [TillRoleController::class, 'store'])->name('till-roles.store');
    Route::patch('till-roles/{role}', [TillRoleController::class, 'update'])->name('till-roles.update');
    Route::delete('till-roles/{role}', [TillRoleController::class, 'destroy'])->name('till-roles.destroy');

""" + anchor, 1)
imp = 'use App' + BS + 'Http' + BS + 'Controllers' + BS + 'Backoffice' + BS + 'TillRoleController;'
if imp not in s:
    i = s.index('use App' + BS + 'Http' + BS + 'Controllers' + BS + 'Backoffice' + BS)
    s = s[:i] + imp + chr(10) + s[i:]
io.open(p, 'w', encoding='utf-8', newline='').write(s)

# ── policy ──────────────────────────────────────────────────────────────────
p = 'app/Providers/PosServiceProvider.php'
s = io.open(p, encoding='utf-8', newline='').read()
anchor = "        Gate::policy(Customer::class, CustomerPolicy::class);"
assert anchor in s, 'policy anchor'
s = s.replace(anchor, "        Gate::policy(TillRole::class, TillRolePolicy::class);\n" + anchor, 1)
for imp in ('use App' + BS + 'Models' + BS + 'Identity' + BS + 'TillRole;',
            'use App' + BS + 'Policies' + BS + 'TillRolePolicy;'):
    if imp not in s:
        i = s.index('use App' + BS + 'Policies' + BS + 'CustomerPolicy;')
        s = s[:i] + imp + chr(10) + s[i:]
io.open(p, 'w', encoding='utf-8', newline='').write(s)

# ── the seeder runs with the rest ───────────────────────────────────────────
p = 'database/seeders/DatabaseSeeder.php'
s = io.open(p, encoding='utf-8', newline='').read()
anchor = "        RoleSeeder::class,"
assert anchor in s, 'seeder anchor'
# After RoleSeeder (axis 1) and before EmployeeSeeder, which needs the slugs to exist.
s = s.replace(anchor, anchor + "\n        TillRoleSeeder::class,", 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)

# ── route helpers ───────────────────────────────────────────────────────────
p = 'resources/js/backoffice/lib/routes.ts'
s = io.open(p, encoding='utf-8', newline='').read()
anchor = "    catalogImport: {"
assert anchor in s, 'routes.ts anchor'
s = s.replace(anchor, """    tillRoles: {
        store: (): string => '/till-roles',
        update: (id: number): string => `/till-roles/${id}`,
        destroy: (id: number): string => `/till-roles/${id}`,
    },

""" + anchor, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)

print('wired')
