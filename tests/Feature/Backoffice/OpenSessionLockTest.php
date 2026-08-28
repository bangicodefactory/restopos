<?php

declare(strict_types=1);

namespace Tests\Feature\Backoffice\OpenSessionLock;

use App\Models\Pos\PosConfig;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * The settings a register cannot change while it is serving (BOF-030, BAN-469).
 *
 * These are the fields Odoo calls `_get_forbidden_change_fields`, and each corrupts an open session
 * rather than merely inconveniencing it. Probed on master: all four went through with a 302 while a
 * session was running.
 */
beforeEach(function (): void {
    PosFixtures::make();

    $this->fx = PosFixtures::make()->withFloor()->withSession();

    DB::table('pos_config_floor')->insertOrIgnore([
        'pos_config_id' => $this->fx->config->getKey(),
        'restaurant_floor_id' => $this->fx->floor->getKey(),
    ]);

    DB::table('pos_config_payment_method')->insertOrIgnore([
        'pos_config_id' => $this->fx->config->getKey(),
        'payment_method_id' => $this->fx->cash->getKey(),
    ]);

    $this->actingAs($this->fx->userWith('backoffice.access', 'backoffice.manage_configs'));
});

/** @param array<string, mixed> $payload */
function save(array $payload): TestResponse
{
    $uuid = (string) test()->fx->config->uuid;

    return test()->patch("/pos-configs/{$uuid}", $payload);
}

it('refuses to archive a register through the settings save', function (): void {
    // `destroy()` already refused this. BAN-466 made `active` writable through `update`, so the
    // guard had a door beside it — probed on master, this returned 302 and archived the register
    // with a session running on it.
    save(['active' => false])->assertSessionHasErrors('active');

    expect((bool) PosConfig::query()->whereKey($this->fx->config->getKey())->value('active'))->toBeTrue();
});

it('refuses to turn restaurant mode off mid-service', function (): void {
    // It takes away floors, tables and course firing on a register with seated orders. The floor
    // screen disappears with bills still open on it.
    save(['is_restaurant' => false])->assertSessionHasErrors('is_restaurant');

    expect((bool) PosConfig::query()->whereKey($this->fx->config->getKey())->value('is_restaurant'))
        ->toBeTrue();
});

it('refuses to take a payment method off a register mid-session', function (): void {
    // An order already tendered against a method removed now cannot be settled, and the session's
    // expected-cash figure was computed from a set of methods that no longer matches the one the
    // drawer will be reconciled against.
    save(['payment_method_ids' => []])->assertSessionHasErrors('payment_method_ids');

    expect(DB::table('pos_config_payment_method')
        ->where('pos_config_id', $this->fx->config->getKey())
        ->count())->toBeGreaterThan(0);
});

it('refuses to take a floor off a register mid-session', function (): void {
    // Seated orders would point at tables this register no longer serves — the bills exist and no
    // screen can reach them.
    save(['floor_ids' => []])->assertSessionHasErrors('floor_ids');

    expect(DB::table('pos_config_floor')
        ->where('pos_config_id', $this->fx->config->getKey())
        ->count())->toBe(1);
});

it('names each frozen field it refused, not just that something was locked', function (): void {
    // An operator who changed four settings and had the save refused needs to know which one to put
    // back. "Some of these are locked" makes them undo all four.
    save([
        'active' => false,
        'is_restaurant' => false,
        'payment_method_ids' => [],
    ])->assertSessionHasErrors(['active', 'is_restaurant', 'payment_method_ids']);
});

it('lets everything else through while a session is open', function (): void {
    // The lock is four fields, not a freeze on the screen. A venue fixes a typo in its receipt
    // footer during service, and that has to work.
    save([
        'receipt_footer' => 'Merci et à bientôt',
        'show_product_images' => false,
        'idle_return_seconds' => 120,
    ])->assertSessionHasNoErrors()->assertRedirect();

    expect((string) PosConfig::query()->whereKey($this->fx->config->getKey())->value('receipt_footer'))
        ->toBe('Merci et à bientôt');
});

it('does not refuse a save that merely resends the frozen fields unchanged', function (): void {
    // The settings screen is one `useForm` posting every field on every save. Keying off presence
    // rather than off change would refuse a save whose only edit was a receipt footer — which is
    // exactly the mistake that made the `sequence` exemption dead on payment methods (review of
    // #85), and the reason `DetectsRealChanges` exists.
    $config = $this->fx->config->fresh();

    save([
        'active' => (bool) $config->active,
        'is_restaurant' => (bool) $config->is_restaurant,
        'payment_method_ids' => DB::table('pos_config_payment_method')
            ->where('pos_config_id', $config->getKey())
            ->pluck('payment_method_id')
            ->all(),
        'floor_ids' => DB::table('pos_config_floor')
            ->where('pos_config_id', $config->getKey())
            ->pluck('restaurant_floor_id')
            ->all(),
        'receipt_footer' => 'Modifié pendant le service',
    ])->assertSessionHasNoErrors()->assertRedirect();

    expect((string) PosConfig::query()->whereKey($config->getKey())->value('receipt_footer'))
        ->toBe('Modifié pendant le service');
});

it('is not fooled by a reordered pivot list', function (): void {
    // No `ORDER BY` promises the same membership back in the same order twice, and `sync()` deletes
    // and re-inserts. An equality check would refuse a save every time the rows came back shuffled.
    DB::table('pos_config_payment_method')->insertOrIgnore([
        'pos_config_id' => $this->fx->config->getKey(),
        'payment_method_id' => $this->fx->card->getKey(),
    ]);

    save([
        'payment_method_ids' => [$this->fx->card->getKey(), $this->fx->cash->getKey()],
    ])->assertSessionHasNoErrors();

    save([
        'payment_method_ids' => [$this->fx->cash->getKey(), $this->fx->card->getKey()],
    ])->assertSessionHasNoErrors();
});

it('lets all four change once the session closes', function (): void {
    // The negative half, and the one that matters most: this is a lock, not a prohibition. If it
    // outlived the session it would be a register nobody could ever reconfigure.
    DB::table('pos_sessions')
        ->where('pos_config_id', $this->fx->config->getKey())
        ->update(['state' => 'closed', 'closed_at' => now()]);

    save([
        'active' => false,
        'is_restaurant' => false,
        'payment_method_ids' => [],
        'floor_ids' => [],
    ])->assertSessionHasNoErrors()->assertRedirect();

    expect((bool) PosConfig::query()->whereKey($this->fx->config->getKey())->value('active'))->toBeFalse();
});
