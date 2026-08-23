<?php

declare(strict_types=1);

use App\Http\Controllers\Auth\AuthenticatedSessionController;
use App\Http\Controllers\Backoffice\CategoryController;
use App\Http\Controllers\Backoffice\DashboardController;
use App\Http\Controllers\Backoffice\DeviceController;
use App\Http\Controllers\Backoffice\EmployeeController;
use App\Http\Controllers\Backoffice\FloorController;
use App\Http\Controllers\Backoffice\OrderController;
use App\Http\Controllers\Backoffice\PaymentMethodController;
use App\Http\Controllers\Backoffice\PosBillController;
use App\Http\Controllers\Backoffice\PosConfigController;
use App\Http\Controllers\Backoffice\PosNoteController;
use App\Http\Controllers\Backoffice\PrepDisplayController;
use App\Http\Controllers\Backoffice\PricelistController;
use App\Http\Controllers\Backoffice\PrinterController;
use App\Http\Controllers\Backoffice\ProductCategoryController;
use App\Http\Controllers\Backoffice\ProductController;
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
    Route::patch('pos-configs/{config}', [PosConfigController::class, 'update'])->name('pos-configs.update');
    Route::post('pos-configs/{config}/pairing-codes', [PosConfigController::class, 'pairingCode'])->name('pos-configs.pairing-codes');

    Route::get('products', [ProductController::class, 'index'])->name('products.index');
    Route::get('products/{product}/edit', [ProductController::class, 'edit'])->name('products.edit');
    Route::patch('products/{product}', [ProductController::class, 'update'])->name('products.update');

    Route::get('categories', [CategoryController::class, 'index'])->name('categories.index');
    Route::post('categories', [CategoryController::class, 'store'])->name('categories.store');
    Route::patch('categories/{category}', [CategoryController::class, 'update'])->name('categories.update');
    Route::delete('categories/{category}', [CategoryController::class, 'destroy'])->name('categories.destroy');

    Route::get('pricelists', [PricelistController::class, 'index'])->name('pricelists.index');
    Route::get('pricelists/{pricelist}/edit', [PricelistController::class, 'edit'])->name('pricelists.edit');
    Route::patch('pricelists/{pricelist}', [PricelistController::class, 'update'])->name('pricelists.update');

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
    Route::patch('employees/{employee}', [EmployeeController::class, 'update'])->name('employees.update');

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

    Route::get('devices', [DeviceController::class, 'index'])->name('devices.index');
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
