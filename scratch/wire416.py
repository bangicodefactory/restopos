import io

# routes
p = 'routes/web.php'
s = io.open(p, encoding='utf-8', newline='').read()
anchor = "    // The customer base (BOF-119, BAN-453)."
assert anchor in s
s = s.replace(anchor, """    // Set menus and their courses (BOF-088, BAN-416).
    Route::get('combos', [ComboController::class, 'index'])->name('combos.index');
    Route::post('combos', [ComboController::class, 'store'])->name('combos.store');
    Route::get('combos/{combo}/edit', [ComboController::class, 'edit'])->name('combos.edit');
    Route::patch('combos/{combo}', [ComboController::class, 'update'])->name('combos.update');
    Route::delete('combos/{combo}', [ComboController::class, 'destroy'])->name('combos.destroy');
    Route::post('combos/{combo}/items', [ComboController::class, 'storeItem'])->name('combo-items.store');
    Route::patch('combos/{combo}/items/{item}', [ComboController::class, 'updateItem'])->name('combo-items.update');
    Route::delete('combos/{combo}/items/{item}', [ComboController::class, 'destroyItem'])->name('combo-items.destroy');
    Route::post('combos/{combo}/menus', [ComboController::class, 'attachMenu'])->name('combo-menus.attach');
    Route::delete('combos/{combo}/menus', [ComboController::class, 'detachMenu'])->name('combo-menus.detach');

""" + anchor, 1)
imp = 'use App\\Http\\Controllers\\Backoffice\\ComboController;'
if imp not in s:
    i = s.index('use App\\Http\\Controllers\\Backoffice\\')
    s = s[:i] + imp + '\n' + s[i:]
io.open(p, 'w', encoding='utf-8', newline='').write(s)

# policy
p = 'app/Providers/PosServiceProvider.php'
s = io.open(p, encoding='utf-8', newline='').read()
anchor = "        Gate::policy(Customer::class, CustomerPolicy::class);"
assert anchor in s
s = s.replace(anchor, "        Gate::policy(Combo::class, ComboPolicy::class);\n" + anchor, 1)
for imp in ['use App\\Models\\Catalog\\Combo;', 'use App\\Policies\\ComboPolicy;']:
    if imp not in s:
        i = s.index('use App\\Policies\\CustomerPolicy;')
        s = s[:i] + imp + '\n' + s[i:]
io.open(p, 'w', encoding='utf-8', newline='').write(s)

# nav — the entry is there, rendered disabled
p = 'resources/js/backoffice/components/layout/nav.ts'
s = io.open(p, encoding='utf-8', newline='').read()
old = "            { key: 'combos', labelKey: 'nav.combos', href: null, disabledReasonKey: 'nav.unavailable' },"
assert old in s
s = s.replace(old, """            {
                key: 'combos',
                labelKey: 'nav.combos',
                href: routes.combos.index(),
                match: startsWith('/combos'),
            },""", 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)

# route helpers
p = 'resources/js/backoffice/lib/routes.ts'
s = io.open(p, encoding='utf-8', newline='').read()
anchor = "    customers: {"
assert anchor in s
s = s.replace(anchor, """    combos: {
        index: (): string => '/combos',
        store: (): string => '/combos',
        edit: (id: number): string => `/combos/${id}/edit`,
        update: (id: number): string => `/combos/${id}`,
        destroy: (id: number): string => `/combos/${id}`,
    },

    comboItems: {
        store: (comboId: number): string => `/combos/${comboId}/items`,
        update: (comboId: number, id: number): string => `/combos/${comboId}/items/${id}`,
        destroy: (comboId: number, id: number): string => `/combos/${comboId}/items/${id}`,
    },

    comboMenus: {
        attach: (comboId: number): string => `/combos/${comboId}/menus`,
        detach: (comboId: number): string => `/combos/${comboId}/menus`,
    },

""" + anchor, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)

print('wired')
