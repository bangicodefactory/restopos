<?php

declare(strict_types=1);

use App\Http\Controllers\Api\Devices\DevicePairingController;
use App\Http\Controllers\Api\Kitchen\PreparationController;
use App\Http\Controllers\Api\Kitchen\PrepDisplayController;
use App\Http\Controllers\Api\Kitchen\PrintJobController;
use App\Http\Controllers\Api\Pos\BootstrapController;
use App\Http\Controllers\Api\Pos\CatalogController;
use App\Http\Controllers\Api\Pos\DeltaController;
use App\Http\Controllers\Api\Pos\EmployeeAuthController;
use App\Http\Controllers\Api\Pos\OrderController;
use App\Http\Controllers\Api\Pos\SessionController;
use App\Http\Controllers\Api\Pos\SyncController;
use App\Http\Controllers\Api\Restaurant\CourseController;
use App\Http\Controllers\Api\Restaurant\FloorController;
use App\Http\Controllers\Api\Restaurant\TableOrderController;
use App\Http\Controllers\Api\SelfOrder\CartController;
use App\Http\Controllers\Api\SelfOrder\MenuController;
use App\Http\Controllers\Api\SelfOrder\OrderStatusController;
use App\Http\Controllers\Api\SelfOrder\PaymentController;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| RestoPOS JSON API
|--------------------------------------------------------------------------
|
| Four groups, four principals (spec 03 §2):
|
|   devices    — enrolment. The only unauthenticated write; guarded by a
|                single-use, 10-minute pairing code and a hard throttle.
|   pos        — the register. Device token + `pos:*` abilities. Every endpoint
|                is scoped to the *device's* config; a config id never appears
|                in a path, so a device cannot address another register's data.
|   kitchen    — displays and the print-job queue. Same device token, narrower
|                abilities, no access to money.
|   self-order — anonymous public surface. Config token in the path, table token
|                and order token as capabilities, throttled per IP.
|
| The full request/response contract lives in docs/spec/05-api-contract.md.
|
*/

// ── devices ─────────────────────────────────────────────────────────────────
Route::prefix('devices')->name('api.devices.')->group(function (): void {
    Route::post('pair', [DevicePairingController::class, 'store'])
        ->middleware('throttle:10,1')
        ->name('pair');

    Route::middleware('device')->group(function (): void {
        Route::get('me', [DevicePairingController::class, 'show'])->name('me');
        Route::delete('me', [DevicePairingController::class, 'destroy'])->name('unpair');
    });
});

// ── register ────────────────────────────────────────────────────────────────
Route::prefix('pos')->name('api.pos.')->middleware('device')->group(function (): void {

    // Bootstrap & delta (spec 03 §3.2, §3.5)
    Route::middleware('device.can:pos:catalog')->group(function (): void {
        Route::get('bootstrap/manifest', [BootstrapController::class, 'manifest'])->name('bootstrap.manifest');
        Route::get('bootstrap', [BootstrapController::class, 'show'])->name('bootstrap');
        Route::get('delta', [DeltaController::class, 'index'])->name('delta');
        Route::get('open-orders', [DeltaController::class, 'openOrders'])->name('open-orders');
        Route::get('products', [CatalogController::class, 'products'])->name('products');
        Route::get('customers', [CatalogController::class, 'customers'])->name('customers');
    });

    // Employee identity (spec 03 §2.3)
    Route::post('employees/verify', EmployeeAuthController::class)
        ->middleware('throttle:30,1')
        ->name('employees.verify');

    // Push sync — the core (spec 03 §3.6)
    Route::post('sync', SyncController::class)
        ->middleware('device.can:pos:sync')
        ->name('sync');

    // Orders (ticket screen)
    Route::middleware('device.can:pos:sync')->group(function (): void {
        Route::get('orders', [OrderController::class, 'index'])->name('orders.index');
        Route::get('orders/{order}', [OrderController::class, 'show'])->name('orders.show');
    });

    // Sessions & cash (spec 02 REG-001…039)
    Route::middleware('device.can:pos:session')->group(function (): void {
        Route::get('sessions/current', [SessionController::class, 'current'])->name('sessions.current');
        Route::post('sessions', [SessionController::class, 'store'])->name('sessions.store');
        Route::post('sessions/{session}/opening-control', [SessionController::class, 'confirmOpening'])->name('sessions.opening-control');
        Route::get('sessions/{session}/closing-data', [SessionController::class, 'closingData'])->name('sessions.closing-data');
        Route::post('sessions/{session}/close', [SessionController::class, 'close'])->name('sessions.close');
        Route::post('sessions/{session}/cash-movements', [SessionController::class, 'cashMovement'])->name('sessions.cash-movements');
        Route::post('sessions/{session}/accounting-export', [SessionController::class, 'accountingExport'])->name('sessions.accounting-export');
    });

    // Restaurant: floors, tables, transfer/merge, guests, courses
    Route::middleware('device.can:pos:restaurant')->group(function (): void {
        Route::get('floors', [FloorController::class, 'index'])->name('floors.index');
        Route::post('floors', [FloorController::class, 'store'])->name('floors.store');
        Route::patch('floors/{floor}', [FloorController::class, 'update'])->name('floors.update');
        Route::delete('floors/{floor}', [FloorController::class, 'destroy'])->name('floors.destroy');

        Route::post('tables', [FloorController::class, 'storeTable'])->name('tables.store');
        Route::patch('tables/{table}', [FloorController::class, 'updateTable'])->name('tables.update');
        Route::delete('tables/{table}', [FloorController::class, 'destroyTable'])->name('tables.destroy');

        Route::post('orders/{order}/transfer', [TableOrderController::class, 'transfer'])->name('orders.transfer');
        Route::post('orders/{order}/merge', [TableOrderController::class, 'merge'])->name('orders.merge');
        Route::post('order-merges/{merge}/unmerge', [TableOrderController::class, 'unmerge'])->name('orders.unmerge');
        Route::patch('orders/{order}/guests', [TableOrderController::class, 'guests'])->name('orders.guests');

        Route::get('orders/{order}/courses', [CourseController::class, 'index'])->name('courses.index');
        Route::post('orders/{order}/courses', [CourseController::class, 'store'])->name('courses.store');
        Route::post('orders/{order}/courses/{course}/fire', [CourseController::class, 'fire'])->name('courses.fire');
        Route::delete('orders/{order}/courses/{course}', [CourseController::class, 'destroy'])->name('courses.destroy');
    });

    // Kitchen delta — the register's side (spec 02 KDS-051…058)
    Route::get('orders/{order}/preparation-changes', [PreparationController::class, 'changes'])->name('preparation.changes');
    Route::post('orders/{order}/preparation', [PreparationController::class, 'send'])->name('preparation.send');
    Route::post('orders/{order}/preparation/mark-sent', [PreparationController::class, 'markSent'])->name('preparation.mark-sent');
});

// ── kitchen displays & printers ─────────────────────────────────────────────
Route::prefix('kitchen')->name('api.kitchen.')->middleware(['device', 'device.can:pos:kitchen'])->group(function (): void {
    Route::get('{display}/orders', [PrepDisplayController::class, 'orders'])->name('orders');
    Route::get('{display}/stages', [PrepDisplayController::class, 'stages'])->name('stages');
    Route::post('{display}/orders/{prepOrder}/stage', [PrepDisplayController::class, 'moveOrder'])->name('orders.stage');
    Route::post('{display}/orders/{prepOrder}/recall', [PrepDisplayController::class, 'recall'])->name('orders.recall');
    Route::post('{display}/lines/{line}/state', [PrepDisplayController::class, 'moveLine'])->name('lines.state');
});

Route::prefix('kitchen')->name('api.kitchen.')->middleware(['device', 'device.can:pos:print'])->group(function (): void {
    Route::get('print-jobs', [PrintJobController::class, 'index'])->name('print-jobs.index');
    Route::post('print-jobs/{job}/ack', [PrintJobController::class, 'acknowledge'])->name('print-jobs.ack');
});

// ── self-order (anonymous, throttled) ───────────────────────────────────────
Route::prefix('self-order/{configToken}')
    ->name('api.self-order.')
    ->middleware(['self-order', 'throttle:self-order'])
    ->group(function (): void {
        Route::get('menu', MenuController::class)->name('menu');
        Route::post('orders', CartController::class)->name('orders.store');
        Route::get('orders/{orderUuid}', [OrderStatusController::class, 'show'])->name('orders.show');
        Route::post('orders/{orderUuid}/cancel', [OrderStatusController::class, 'cancel'])->name('orders.cancel');
        Route::post('orders/{orderUuid}/payment-intent', [PaymentController::class, 'intent'])->name('orders.payment-intent');
        Route::post('orders/{orderUuid}/payment-confirm', [PaymentController::class, 'confirm'])->name('orders.payment-confirm');
    });

// ── liveness ────────────────────────────────────────────────────────────────
Route::get('ping', fn (): array => [
    'ok' => true,
    'server_time' => now()->toIso8601ZuluString('microsecond'),
    'min_client_version' => (string) config('pos.api.min_client_version'),
    'schema_version' => (int) config('pos.api.schema_version'),
])->name('api.ping');
