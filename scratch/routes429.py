import io

p = 'routes/web.php'
s = io.open(p, encoding='utf-8', newline='').read()


def sub(old, new):
    global s
    assert old in s, 'MISSING: ' + old[:70]
    s = s.replace(old, new, 1)


sub("""    Route::get('barcode-nomenclatures', [BarcodeNomenclatureController::class, 'index'])->name('barcode-nomenclatures.index');""",
"""    // Service modes and their opening hours (BOF-113, BAN-429).
    Route::get('presets', [PresetController::class, 'index'])->name('presets.index');
    Route::post('presets', [PresetController::class, 'store'])->name('presets.store');
    Route::get('presets/{preset}/edit', [PresetController::class, 'edit'])->name('presets.edit');
    Route::patch('presets/{preset}', [PresetController::class, 'update'])->name('presets.update');
    Route::delete('presets/{preset}', [PresetController::class, 'destroy'])->name('presets.destroy');
    Route::post('presets/{preset}/service-windows', [PresetController::class, 'storeWindow'])->name('service-windows.store');
    Route::patch('presets/{preset}/service-windows/{window}', [PresetController::class, 'updateWindow'])->name('service-windows.update');
    Route::delete('presets/{preset}/service-windows/{window}', [PresetController::class, 'destroyWindow'])->name('service-windows.destroy');

    Route::get('barcode-nomenclatures', [BarcodeNomenclatureController::class, 'index'])->name('barcode-nomenclatures.index');""")

imp = 'use App\Http\Controllers\Backoffice\PresetController;'
if imp not in s:
    i = s.index('use App\Http\Controllers\Backoffice\PricelistController;')
    s = s[:i] + imp + '\n' + s[i:]

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('routes wired')
