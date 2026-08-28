<?php

declare(strict_types=1);

use App\Http\Controllers\Auth\AuthenticatedSessionController;
use App\Http\Controllers\Backoffice\AttributeController;
use App\Http\Controllers\Backoffice\AttributeValueController;
use App\Http\Controllers\Backoffice\ProductAttributeLineController;
use App\Http\Controllers\Backoffice\CategoryController;
use App\Http\Controllers\Backoffice\DashboardController;
use App\Http\Controllers\Backoffice\BarcodeNomenclatureController;
use App\Http\Controllers\Backoffice\DeviceController;
use App\Http\Controllers\Backoffice\FiscalPositionController;
use App\Http\Controllers\Backoffice\MediaController;
use App\Http\Controllers\Backoffice\EmployeeController;
use App\Http\Controllers\Backoffice\FloorController;
use App\Http\Controllers\Backoffice\OrderController;
use App\Http\Controllers\Backoffice\PaymentMethodController;
use App\Http\Controllers\Backoffice\PosBillController;
use App\Http\Controllers\Backoffice\PosConfigController;
use App\Http\Controllers\Backoffice\PosNoteController;
use App\Http\Controllers\Backoffice\PrepDisplayController;
use App\Http\Controllers\Backoffice\PresetController;
use App\Http\Controllers\Backoffice\PricelistController;
use App\Http\Controllers\Backoffice\PrinterController;
use App\Http\Controllers\Backoffice\ProductCategoryController;
use App\Http\Controllers\Backoffice\ProductController;
use App\Http\Controllers\Backoffice\ProductVariantController;
use App\Http\Controllers\Backoffice\ReportController;
use App\Http\Controllers\Backoffice\SelfOrderSettingsController;
use App\Http\Controllers\Backoffice\SessionController;
use App\Http\Controllers\Backoffice\TaxController;
use App\Http\Controllers\Backoffice\TaxGroupController;
use App\Http\Controllers\ShellController;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| Web routes
|--------------------------------------------------------------------------
|
| Two very different kinds of route live here:
|
|   1. The back-office — pure Inertia. CRUD over paginated lists, permissioned
|      per request, always online. It benefits enormously from Inertia v2's
|      deferred props and `WhenVisible` infinite scroll.
|
|   2. The four PWA shells — propless Blade documents. They must render
|      identically for every user and every tenant so the service worker can
|      precache them (docs/CONVENTIONS.md § "Fixed entry points"). No `@inertia`,
|      no CSRF token in the document, no user data: all state comes from
|      IndexedDB and the bootstrap API.
|
*/

// ── auth ────────────────────────────────────────────────────────────────────
Route::middleware('guest')->group(function (): void {
    Route::get('login', [AuthenticatedSessionController::class, 'create'])->name('login');
    Route::post('login', [AuthenticatedSessionController::class, 'store'])->middleware('throttle:10,1');
});

Route::post('logout', [AuthenticatedSessionController::class, 'destroy'])
    ->middleware('auth')
    ->name('logout');

// ── back-office (Inertia) ───────────────────────────────────────────────────
Route::middleware(['auth'])->group(function (): void {
    Route::get('/', DashboardController::class)->name('dashboard');

    Route::get('pos-configs', [PosConfigController::class, 'index'])->name('pos-configs.index');
    Route::get('pos-configs/{config}/edit', [PosConfigController::class, 'edit'])->name('pos-configs.edit');
    Route::post('pos-configs', [PosConfigController::class, 'store'])->name('pos-configs.store');
    Route::patch('pos-configs/{config}', [PosConfigController::class, 'update'])->name('pos-configs.update');
    Route::post('pos-configs/{config}/duplicate', [PosConfigController::class, 'duplicate'])->name('pos-configs.duplicate');
    Route::delete('pos-configs/{config}', [PosConfigController::class, 'destroy'])->name('pos-configs.destroy');
    Route::post('pos-configs/{config}/pairing-codes', [PosConfigController::class, 'pairingCode'])->name('pos-configs.pairing-codes');

    Route::get('products', [ProductController::class, 'index'])->name('products.index');
    Route::get('products/{product}/edit', [ProductController::class, 'edit'])->name('products.edit');
    Route::post('products', [ProductController::class, 'store'])->name('products.store');
    Route::patch('products/{product}', [ProductController::class, 'update'])->name('products.update');
    Route::delete('products/{product}', [ProductController::class, 'destroy'])->name('products.destroy');
    Route::get('product-attributes', [AttributeController::class, 'index'])->name('product-attributes.index');
    Route::post('product-attributes', [AttributeController::class, 'store'])->name('product-attributes.store');
    Route::patch('product-attributes/{attribute}', [AttributeController::class, 'update'])->name('product-attributes.update');
    Route::delete('product-attributes/{attribute}', [AttributeController::class, 'destroy'])->name('product-attributes.destroy');

    Route::post('product-attributes/{attribute}/values', [AttributeValueController::class, 'store'])->name('attribute-values.store');
    Route::patch('product-attributes/{attribute}/values/{value}', [AttributeValueController::class, 'update'])->name('attribute-values.update');
    Route::delete('product-attributes/{attribute}/values/{value}', [AttributeValueController::class, 'destroy'])->name('attribute-values.destroy');

    Route::post('products/{product}/attribute-lines', [ProductAttributeLineController::class, 'store'])->name('product-attribute-lines.store');
    Route::patch('products/{product}/attribute-lines/{line}', [ProductAttributeLineController::class, 'update'])->name('product-attribute-lines.update');
    Route::delete('products/{product}/attribute-lines/{line}', [ProductAttributeLineController::class, 'destroy'])->name('product-attribute-lines.destroy');

    Route::post('products/{product}/variants', [ProductVariantController::class, 'store'])->name('product-variants.store');
    Route::patch('products/{product}/variants/{variant}', [ProductVariantController::class, 'update'])->name('product-variants.update');
    Route::delete('products/{product}/variants/{variant}', [ProductVariantController::class, 'destroy'])->name('product-variants.destroy');

    Route::get('categories', [CategoryController::class, 'index'])->name('categories.index');
    Route::post('categories', [CategoryController::class, 'store'])->name('categories.store');
    Route::patch('categories/{category}', [CategoryController::class, 'update'])->name('categories.update');
    Route::delete('categories/{category}', [CategoryController::class, 'destroy'])->name('categories.destroy');

    Route::get('pricelists', [PricelistController::class, 'index'])->name('pricelists.index');
    Route::get('pricelists/{pricelist}/edit', [PricelistController::class, 'edit'])->name('pricelists.edit');
    Route::post('pricelists', [PricelistController::class, 'store'])->name('pricelists.store');
    Route::patch('pricelists/{pricelist}', [PricelistController::class, 'update'])->name('pricelists.update');
    Route::delete('pricelists/{pricelist}', [PricelistController::class, 'destroy'])->name('pricelists.destroy');
    Route::post('pricelists/{pricelist}/items', [PricelistController::class, 'storeItem'])->name('pricelist-items.store');
    Route::patch('pricelists/{pricelist}/items/{item}', [PricelistController::class, 'updateItem'])->name('pricelist-items.update');
    Route::delete('pricelists/{pricelist}/items/{item}', [PricelistController::class, 'destroyItem'])->name('pricelist-items.destroy');

    Route::get('product-categories', [ProductCategoryController::class, 'index'])->name('product-categories.index');
    Route::post('product-categories', [ProductCategoryController::class, 'store'])->name('product-categories.store');
    Route::patch('product-categories/{productCategory}', [ProductCategoryController::class, 'update'])->name('product-categories.update');
    Route::delete('product-categories/{productCategory}', [ProductCategoryController::class, 'destroy'])->name('product-categories.destroy');

    Route::get('taxes', [TaxController::class, 'index'])->name('taxes.index');
    Route::post('taxes', [TaxController::class, 'store'])->name('taxes.store');
    Route::patch('taxes/{tax}', [TaxController::class, 'update'])->name('taxes.update');
    Route::delete('taxes/{tax}', [TaxController::class, 'destroy'])->name('taxes.destroy');

    Route::post('tax-groups', [TaxGroupController::class, 'store'])->name('tax-groups.store');
    Route::patch('tax-groups/{taxGroup}', [TaxGroupController::class, 'update'])->name('tax-groups.update');
    Route::delete('tax-groups/{taxGroup}', [TaxGroupController::class, 'destroy'])->name('tax-groups.destroy');

    Route::get('payment-methods', [PaymentMethodController::class, 'index'])->name('payment-methods.index');
    Route::post('payment-methods', [PaymentMethodController::class, 'store'])->name('payment-methods.store');
    Route::patch('payment-methods/{paymentMethod}', [PaymentMethodController::class, 'update'])->name('payment-methods.update');
    Route::delete('payment-methods/{paymentMethod}', [PaymentMethodController::class, 'destroy'])->name('payment-methods.destroy');

    Route::get('employees', [EmployeeController::class, 'index'])->name('employees.index');
    Route::post('employees', [EmployeeController::class, 'store'])->name('employees.store');
    Route::patch('employees/{employee}', [EmployeeController::class, 'update'])->name('employees.update');
    Route::delete('employees/{employee}', [EmployeeController::class, 'destroy'])->name('employees.destroy');

    Route::get('floors', [FloorController::class, 'index'])->name('floors.index');
    Route::get('floors/{floor}/edit', [FloorController::class, 'edit'])->name('floors.edit');
    Route::post('floors', [FloorController::class, 'store'])->name('floors.store');
    Route::patch('floors/{floor}', [FloorController::class, 'update'])->name('floors.update');
    Route::delete('floors/{floor}', [FloorController::class, 'destroy'])->name('floors.destroy');
    Route::post('tables/{table}/rotate-token', [FloorController::class, 'rotateTableToken'])->name('tables.rotate-token');

    Route::get('orders', [OrderController::class, 'index'])->name('orders.index');
    Route::get('orders/{order}', [OrderController::class, 'show'])->name('orders.show');

    Route::get('sessions', [SessionController::class, 'index'])->name('sessions.index');
    Route::get('sessions/{session}', [SessionController::class, 'show'])->name('sessions.show');
    Route::post('sessions/{session}/close', [SessionController::class, 'close'])->name('sessions.close');
    Route::post('accounting-exports', [SessionController::class, 'export'])->name('accounting-exports.store');
    Route::get('accounting-exports/{export}/download', [SessionController::class, 'download'])->name('accounting-exports.download');

    Route::get('reports/sales-details', [ReportController::class, 'salesDetails'])->name('reports.sales-details');
    Route::get('reports/session', [ReportController::class, 'sessionReport'])->name('reports.session');
    Route::get('reports/order-analytics', [ReportController::class, 'orderAnalytics'])->name('reports.order-analytics');

    // BOF-111 / BOF-112 — denominations and predefined notes. Both are reference data the register
    // reads on boot and neither had any way in.
    Route::get('pos-bills', [PosBillController::class, 'index'])->name('pos-bills.index');
    Route::post('pos-bills', [PosBillController::class, 'store'])->name('pos-bills.store');
    Route::patch('pos-bills/{posBill}', [PosBillController::class, 'update'])->name('pos-bills.update');
    Route::delete('pos-bills/{posBill}', [PosBillController::class, 'destroy'])->name('pos-bills.destroy');

    Route::get('pos-notes', [PosNoteController::class, 'index'])->name('pos-notes.index');
    Route::post('pos-notes', [PosNoteController::class, 'store'])->name('pos-notes.store');
    Route::patch('pos-notes/{posNote}', [PosNoteController::class, 'update'])->name('pos-notes.update');
    Route::delete('pos-notes/{posNote}', [PosNoteController::class, 'destroy'])->name('pos-notes.destroy');

    Route::get('printers', [PrinterController::class, 'index'])->name('printers.index');
    Route::post('printers', [PrinterController::class, 'store'])->name('printers.store');
    Route::patch('printers/{printer}', [PrinterController::class, 'update'])->name('printers.update');
    Route::delete('printers/{printer}', [PrinterController::class, 'destroy'])->name('printers.destroy');
    Route::post('printers/{printer}/test', [PrinterController::class, 'test'])->name('printers.test');

    Route::get('prep-displays', [PrepDisplayController::class, 'index'])->name('prep-displays.index');
    Route::get('prep-displays/{prepDisplay}/edit', [PrepDisplayController::class, 'edit'])->name('prep-displays.edit');
    Route::post('prep-displays', [PrepDisplayController::class, 'store'])->name('prep-displays.store');
    Route::patch('prep-displays/{prepDisplay}', [PrepDisplayController::class, 'update'])->name('prep-displays.update');
    Route::delete('prep-displays/{prepDisplay}', [PrepDisplayController::class, 'destroy'])->name('prep-displays.destroy');
    Route::post('prep-displays/{prepDisplay}/rotate-token', [PrepDisplayController::class, 'rotateToken'])->name('prep-displays.rotate-token');

    Route::get('self-order/{config}/settings', [SelfOrderSettingsController::class, 'edit'])->name('self-order.settings');
    Route::patch('self-order/{config}/settings', [SelfOrderSettingsController::class, 'update'])->name('self-order.settings.update');
    Route::post('self-order/{config}/rotate-token', [SelfOrderSettingsController::class, 'rotateToken'])->name('self-order.rotate-token');

    // Media (BAN-393). `store` answers JSON rather than redirecting, because the picker needs the
    // id of the file it just uploaded; `show` exists because the only other serve route is
    // device-authenticated and a signed-in manager holds no device token.
    Route::post('media', [MediaController::class, 'store'])->name('media.store');
    Route::get('media/{media:id}', [MediaController::class, 'show'])->name('media.show');
    Route::delete('media/{media:id}', [MediaController::class, 'destroy'])->name('media.destroy');

    // Barcode nomenclatures and their rules (BOF-043, BAN-488).
    // Fiscal positions and their tax mappings (BOF-036, BAN-398).
    Route::get('fiscal-positions', [FiscalPositionController::class, 'index'])->name('fiscal-positions.index');
    Route::post('fiscal-positions', [FiscalPositionController::class, 'store'])->name('fiscal-positions.store');
    Route::patch('fiscal-positions/{fiscalPosition}', [FiscalPositionController::class, 'update'])->name('fiscal-positions.update');
    Route::delete('fiscal-positions/{fiscalPosition}', [FiscalPositionController::class, 'destroy'])->name('fiscal-positions.destroy');
    Route::post('fiscal-positions/{fiscalPosition}/mappings', [FiscalPositionController::class, 'storeMapping'])->name('fiscal-position-mappings.store');
    Route::delete('fiscal-positions/{fiscalPosition}/mappings/{mapping}', [FiscalPositionController::class, 'destroyMapping'])->name('fiscal-position-mappings.destroy');

    // Service modes and their opening hours (BOF-113, BAN-429).
    Route::get('presets', [PresetController::class, 'index'])->name('presets.index');
    Route::post('presets', [PresetController::class, 'store'])->name('presets.store');
    Route::get('presets/{preset}/edit', [PresetController::class, 'edit'])->name('presets.edit');
    Route::patch('presets/{preset}', [PresetController::class, 'update'])->name('presets.update');
    Route::delete('presets/{preset}', [PresetController::class, 'destroy'])->name('presets.destroy');
    Route::post('presets/{preset}/service-windows', [PresetController::class, 'storeWindow'])->name('service-windows.store');
    Route::patch('presets/{preset}/service-windows/{window}', [PresetController::class, 'updateWindow'])->name('service-windows.update');
    Route::delete('presets/{preset}/service-windows/{window}', [PresetController::class, 'destroyWindow'])->name('service-windows.destroy');

    Route::get('barcode-nomenclatures', [BarcodeNomenclatureController::class, 'index'])->name('barcode-nomenclatures.index');
    Route::post('barcode-nomenclatures', [BarcodeNomenclatureController::class, 'store'])->name('barcode-nomenclatures.store');
    Route::patch('barcode-nomenclatures/{nomenclature}', [BarcodeNomenclatureController::class, 'update'])->name('barcode-nomenclatures.update');
    Route::delete('barcode-nomenclatures/{nomenclature}', [BarcodeNomenclatureController::class, 'destroy'])->name('barcode-nomenclatures.destroy');
    Route::post('barcode-nomenclatures/{nomenclature}/rules', [BarcodeNomenclatureController::class, 'storeRule'])->name('barcode-rules.store');
    Route::patch('barcode-nomenclatures/{nomenclature}/rules/{rule}', [BarcodeNomenclatureController::class, 'updateRule'])->name('barcode-rules.update');
    Route::delete('barcode-nomenclatures/{nomenclature}/rules/{rule}', [BarcodeNomenclatureController::class, 'destroyRule'])->name('barcode-rules.destroy');

    Route::get('devices', [DeviceController::class, 'index'])->name('devices.index');
    Route::patch('devices/{device}', [DeviceController::class, 'update'])->name('devices.update');
    Route::delete('devices/{device}', [DeviceController::class, 'destroy'])->name('devices.destroy');
});

// ── PWA shells (propless, precacheable, no auth) ─────────────────────────────
Route::get('/pos/{config}/display', [ShellController::class, 'customerDisplay'])
    ->where('config', '[^/]+')
    ->name('shell.customer-display');

Route::get('/pos/{config}/{any?}', [ShellController::class, 'register'])
    ->where(['config' => '[^/]+', 'any' => '.*'])
    ->name('shell.register');

Route::get('/kitchen/{display}/{any?}', [ShellController::class, 'kitchen'])
    ->where(['display' => '[^/]+', 'any' => '.*'])
    ->name('shell.kitchen');

Route::get('/menu/{token}/{any?}', [ShellController::class, 'selfOrder'])
    ->where(['token' => '[^/]+', 'any' => '.*'])
    ->name('shell.self-order');
