import io

# routes
p = 'routes/web.php'
s = io.open(p, encoding='utf-8', newline='').read()
anchor = "    // Set menus and their courses (BOF-088, BAN-416)."
assert anchor in s
s = s.replace(anchor, """    // Bringing a catalogue in from a spreadsheet (BOF-093, BAN-491).
    Route::get('catalog-import', [CatalogImportController::class, 'index'])->name('catalog-import.index');
    Route::post('catalog-import/preview', [CatalogImportController::class, 'preview'])->name('catalog-import.preview');
    Route::post('catalog-import', [CatalogImportController::class, 'store'])->name('catalog-import.store');
    Route::get('catalog-import/{entity}/template', [CatalogImportController::class, 'template'])->name('catalog-import.template');

""" + anchor, 1)
imp = 'use App\\Http\\Controllers\\Backoffice\\CatalogImportController;'
if imp not in s:
    i = s.index('use App\\Http\\Controllers\\Backoffice\\')
    s = s[:i] + imp + '\n' + s[i:]
io.open(p, 'w', encoding='utf-8', newline='').write(s)

# route helpers
p = 'resources/js/backoffice/lib/routes.ts'
s = io.open(p, encoding='utf-8', newline='').read()
anchor = "    combos: {"
assert anchor in s
s = s.replace(anchor, """    catalogImport: {
        index: (): string => '/catalog-import',
        preview: (): string => '/catalog-import/preview',
        store: (): string => '/catalog-import',
        template: (entity: string): string => `/catalog-import/${entity}/template`,
    },

""" + anchor, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)

print('wired')
