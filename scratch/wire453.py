import io

# routes
p = 'routes/web.php'
s = io.open(p, encoding='utf-8', newline='').read()
anchor = "    // Service modes and their opening hours (BOF-113, BAN-429)."
assert anchor in s
s = s.replace(anchor, """    // The customer base (BOF-119, BAN-453). Model-bound by uuid — `Customer` uses `HasUuid`.
    Route::get('customers', [CustomerController::class, 'index'])->name('customers.index');
    Route::post('customers', [CustomerController::class, 'store'])->name('customers.store');
    Route::get('customers/{customer}/edit', [CustomerController::class, 'edit'])->name('customers.edit');
    Route::patch('customers/{customer}', [CustomerController::class, 'update'])->name('customers.update');
    Route::delete('customers/{customer}', [CustomerController::class, 'destroy'])->name('customers.destroy');
    Route::post('customers/{customer}/merge', [CustomerController::class, 'merge'])->name('customers.merge');

""" + anchor, 1)
imp = 'use App\\Http\\Controllers\\Backoffice\\CustomerController;'
if imp not in s:
    i = s.index('use App\\Http\\Controllers\\Backoffice\\')
    s = s[:i] + imp + '\n' + s[i:]
io.open(p, 'w', encoding='utf-8', newline='').write(s)

# policy
p = 'app/Providers/PosServiceProvider.php'
s = io.open(p, encoding='utf-8', newline='').read()
anchor = "        Gate::policy(PosPreset::class, PosPresetPolicy::class);"
assert anchor in s
s = s.replace(anchor, "        Gate::policy(Customer::class, CustomerPolicy::class);\n" + anchor, 1)
for imp in ['use App\\Models\\Identity\\Customer;', 'use App\\Policies\\CustomerPolicy;']:
    if imp not in s:
        i = s.index('use App\\Policies\\PosPresetPolicy;')
        s = s[:i] + imp + '\n' + s[i:]
io.open(p, 'w', encoding='utf-8', newline='').write(s)

# nav — the entry is already there, rendered disabled
p = 'resources/js/backoffice/components/layout/nav.ts'
s = io.open(p, encoding='utf-8', newline='').read()
old = "            { key: 'customers', labelKey: 'nav.customers', href: null, disabledReasonKey: 'nav.unavailable' },"
assert old in s
s = s.replace(old, """            {
                key: 'customers',
                labelKey: 'nav.customers',
                href: routes.customers.index(),
                match: startsWith('/customers'),
            },""", 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)

# route helpers
p = 'resources/js/backoffice/lib/routes.ts'
s = io.open(p, encoding='utf-8', newline='').read()
anchor = "    presets: {"
assert anchor in s
s = s.replace(anchor, """    customers: {
        index: (): string => '/customers',
        store: (): string => '/customers',
        edit: (uuid: string): string => `/customers/${uuid}/edit`,
        update: (uuid: string): string => `/customers/${uuid}`,
        destroy: (uuid: string): string => `/customers/${uuid}`,
        merge: (uuid: string): string => `/customers/${uuid}/merge`,
    },

""" + anchor, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)

print('wired')
