<?php

declare(strict_types=1);

namespace Tests\Feature\Backoffice\PresetCrud;

use App\Models\Pos\Order;
use App\Models\Pos\PosConfig;
use App\Models\Pos\PosPreset;
use App\Models\Pos\PresetServiceWindow;
use App\Models\Pricing\Pricelist;
use App\Services\Pos\PresetSlotService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * Service modes and their opening hours (BOF-113, BAN-429).
 *
 * Presets are how a venue distinguishes eat-in from takeaway from delivery. Every runtime consumer
 * was already in place — the register shows them, the pricing service reads their price list, the
 * kitchen prints their name — and there was no way to create one. A venue adding delivery had to
 * reach for SQL.
 */
beforeEach(function (): void {
    $this->other = PosFixtures::make();

    $this->fx = PosFixtures::make();
    $this->actingAs($this->fx->userWith('backoffice.access', 'backoffice.manage_configs'));
});

function ourPreset(array $overrides = []): PosPreset
{
    return PosPreset::query()->create([
        'company_id' => test()->fx->company->getKey(),
        'name' => 'Livraison',
        ...$overrides,
    ]);
}

/** @param array<string, mixed> $payload */
function addWindow(PosPreset $preset, array $payload = []): TestResponse
{
    return test()->post("/presets/{$preset->getKey()}/service-windows", [
        'day_of_week' => 0,
        'hour_from' => 11,
        'hour_to' => 14,
        ...$payload,
    ]);
}

it('creates a service mode', function (): void {
    test()->post('/presets', ['name' => 'Livraison'])
        ->assertSessionHasNoErrors()
        ->assertRedirect();

    expect(PosPreset::query()->where('name', 'Livraison')->exists())->toBeTrue();
});

it('never mints a system mode through the form', function (): void {
    // `is_system` decides whether a mode can be removed at all. A request that could set it would
    // create a mode the UI then refuses to delete, with no way back.
    test()->post('/presets', ['name' => 'Livraison', 'is_system' => true])
        ->assertSessionHasNoErrors();

    expect(PosPreset::query()->where('name', 'Livraison')->value('is_system'))->toBeFalsy();
});

it('refuses a price list from another venue', function (): void {
    // The preset's price list decides what the till quotes, so this would price their menu on our
    // register.
    $theirs = Pricelist::query()->create([
        'company_id' => $this->other->company->getKey(),
        'currency_id' => $this->other->currency->getKey(),
        'name' => 'Leur tarif',
    ]);

    test()->post('/presets', ['name' => 'Livraison', 'pricelist_id' => $theirs->getKey()])
        ->assertSessionHasErrors('pricelist_id');
});

it('refuses a booking mode that can take no bookings', function (): void {
    // Both columns are unsigned with a default, so zero is accepted by the database and then means
    // no slot is ever free. The mode stops taking orders with nothing on screen to say why.
    $preset = ourPreset();

    test()->patch("/presets/{$preset->getKey()}", ['use_timing' => true, 'slots_per_interval' => 0])
        ->assertSessionHasErrors('slots_per_interval');

    test()->patch("/presets/{$preset->getKey()}", ['use_timing' => true, 'interval_minutes' => 0])
        ->assertSessionHasErrors('interval_minutes');
});

it('adds opening hours', function (): void {
    $preset = ourPreset();

    addWindow($preset)->assertSessionHasNoErrors()->assertRedirect();

    expect($preset->serviceWindows()->count())->toBe(1);
});

it('refuses hours that close before they open', function (): void {
    $preset = ourPreset();

    addWindow($preset, ['hour_from' => 14, 'hour_to' => 11])->assertSessionHasErrors('hour_to');
});

it('refuses hours overlapping a window already set for that day', function (): void {
    // Capacity is counted per interval, not per window, so overlapping hours offer the same slot
    // twice on screen while the kitchen has one.
    $preset = ourPreset();

    addWindow($preset, ['hour_from' => 11, 'hour_to' => 14])->assertSessionHasNoErrors();
    addWindow($preset, ['hour_from' => 13, 'hour_to' => 15])->assertSessionHasErrors('hour_from');

    expect($preset->serviceWindows()->count())->toBe(1);
});

it('still accepts the same hours on a different day', function (): void {
    // The negative half: the overlap check is about one day, not about the hours being taken.
    $preset = ourPreset();

    addWindow($preset, ['day_of_week' => 0])->assertSessionHasNoErrors();
    addWindow($preset, ['day_of_week' => 1])->assertSessionHasNoErrors();

    expect($preset->serviceWindows()->count())->toBe(2);
});

it('does not let a window be reached through the wrong mode', function (): void {
    $ours = ourPreset();
    $second = ourPreset(['name' => 'Emporter']);

    addWindow($second)->assertRedirect();
    $window = $second->serviceWindows()->firstOrFail();

    test()->delete("/presets/{$ours->getKey()}/service-windows/{$window->getKey()}")->assertNotFound();

    expect(PresetServiceWindow::query()->whereKey($window->getKey())->exists())->toBeTrue();
});

it('refuses to remove a mode the product ships with', function (): void {
    $preset = ourPreset(['is_system' => true]);

    test()->delete("/presets/{$preset->getKey()}")->assertSessionHasErrors('preset');

    expect(PosPreset::query()->whereKey($preset->getKey())->exists())->toBeTrue();
});

it('refuses to remove a mode orders were taken under', function (): void {
    $preset = ourPreset();
    $fx = $this->fx->withSession();

    DB::table('pos_orders')->insert([
        'uuid' => (string) Str::uuid(),
        'company_id' => $fx->company->getKey(),
        'pos_config_id' => $fx->config->getKey(),
        'pos_session_id' => $fx->session->getKey(),
        'currency_id' => $fx->currency->getKey(),
        'pos_preset_id' => $preset->getKey(),
        'tracking_number' => 'T-1',
        'access_token' => Str::random(32),
        'state' => 'draft',
        'ordered_at' => now(),
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    test()->delete("/presets/{$preset->getKey()}")->assertSessionHasErrors('preset');
});

it('refuses to remove a mode a register opens on', function (): void {
    $preset = ourPreset();

    PosConfig::query()->whereKey($this->fx->config->getKey())
        ->update(['default_preset_id' => $preset->getKey()]);

    test()->delete("/presets/{$preset->getKey()}")->assertSessionHasErrors('preset');
});

it('refuses to deactivate a mode a register opens on', function (): void {
    // Deleting is guarded and deactivating was not, which is the same outcome by another route: the
    // register opens on a mode it will not show, and every order arrives with no service type.
    $preset = ourPreset();

    PosConfig::query()->whereKey($this->fx->config->getKey())
        ->update(['default_preset_id' => $preset->getKey()]);

    test()->patch("/presets/{$preset->getKey()}", ['active' => false])
        ->assertSessionHasErrors('active');

    expect(PosPreset::query()->whereKey($preset->getKey())->value('active'))->toBeTruthy();
});

it('removes a mode nothing points at', function (): void {
    $preset = ourPreset();

    test()->delete("/presets/{$preset->getKey()}")->assertSessionHasNoErrors()->assertRedirect();

    expect(PosPreset::query()->whereKey($preset->getKey())->exists())->toBeFalse();
});

it('refuses everything to someone who may only look', function (): void {
    $this->actingAs($this->fx->userWith('backoffice.access'));

    test()->post('/presets', ['name' => 'Livraison'])->assertForbidden();
});

it('ships the form what it needs to point a mode at a price list', function (): void {
    test()->withoutVite();

    Pricelist::query()->create([
        'company_id' => $this->fx->company->getKey(),
        'currency_id' => $this->fx->currency->getKey(),
        'name' => 'Tarif livraison',
    ]);

    test()->get('/presets')
        ->assertOk()
        ->assertInertia(fn ($page) => $page
            ->where('pricelists', fn ($rows) => collect($rows)->pluck('name')->contains('Tarif livraison'))
            ->has('fiscalPositions')
            ->etc());
});

it('ships the hours editor the mode it is editing', function (): void {
    test()->withoutVite();

    $preset = ourPreset();
    addWindow($preset)->assertRedirect();

    test()->get("/presets/{$preset->getKey()}/edit")
        ->assertOk()
        ->assertInertia(fn ($page) => $page
            ->where('windows', fn ($rows) => count($rows) === 1)
            ->etc());
});

// ───────────────────────────────────────────────────── the hours actually gating a booking

it('refuses a booking outside the hours that were set', function (): void {
    // `preset_service_windows` shipped to the client in the bootstrap payload and nothing has ever
    // read it, on either side. A delivery mode open 11:00–14:00 took a booking for 3 a.m.
    $preset = ourPreset(['use_timing' => true, 'slots_per_interval' => 5, 'interval_minutes' => 20]);
    addWindow($preset, ['day_of_week' => 0, 'hour_from' => 11, 'hour_to' => 14])->assertRedirect();

    $slots = app(PresetSlotService::class);
    // 2026-06-01 is a Monday, which is `day_of_week` 0 in this schema.
    expect($slots->refusalFor($preset, '2026-06-01 03:00:00'))->not->toBeNull()
        ->and($slots->refusalFor($preset, '2026-06-01 12:00:00'))->toBeNull();
});

it('refuses a booking on a day with no hours at all', function (): void {
    $preset = ourPreset(['use_timing' => true, 'slots_per_interval' => 5, 'interval_minutes' => 20]);
    addWindow($preset, ['day_of_week' => 0, 'hour_from' => 11, 'hour_to' => 14])->assertRedirect();

    // 2026-06-02 is the Tuesday. Hours exist for Monday only, so this day is closed — and the check
    // has to read the row for *that* day, not any row.
    expect(app(PresetSlotService::class)->refusalFor($preset, '2026-06-02 12:00:00'))->not->toBeNull();
});

it('takes a booking when no hours were ever set', function (): void {
    // A mode starts with no windows, and timing on with no hours means the hours are not the
    // constraint. Refusing everything here would break every preset the moment timing is switched on.
    $preset = ourPreset(['use_timing' => true, 'slots_per_interval' => 5, 'interval_minutes' => 20]);

    expect(app(PresetSlotService::class)->refusalFor($preset, '2026-06-01 03:00:00'))->toBeNull();
});

it('refuses the booking that would overfill an interval', function (): void {
    // `slots_per_interval` has been a column since the schema was written and nothing counted
    // against it. The fiftieth booking into one twenty-minute slot was as welcome as the first, and
    // the kitchen found out when the tickets arrived together.
    $preset = ourPreset(['use_timing' => true, 'slots_per_interval' => 2, 'interval_minutes' => 20]);
    $fx = $this->fx->withSession();

    $book = function (string $at) use ($fx, $preset): void {
        DB::table('pos_orders')->insert([
            'uuid' => (string) Str::uuid(),
            'company_id' => $fx->company->getKey(),
            'pos_config_id' => $fx->config->getKey(),
            'pos_session_id' => $fx->session->getKey(),
            'currency_id' => $fx->currency->getKey(),
            'pos_preset_id' => $preset->getKey(),
            'preset_time' => $at,
            'tracking_number' => 'T-'.Str::random(4),
            'access_token' => Str::random(32),
            'state' => 'draft',
            'ordered_at' => now(),
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    };

    $slots = app(PresetSlotService::class);

    $book('2026-06-01 12:05:00');
    expect($slots->refusalFor($preset, '2026-06-01 12:10:00'))->toBeNull();

    $book('2026-06-01 12:15:00');
    expect($slots->refusalFor($preset, '2026-06-01 12:10:00'))->not->toBeNull();

    // The next interval is its own allowance — a full 12:00–12:20 says nothing about 12:20–12:40.
    expect($slots->refusalFor($preset, '2026-06-01 12:25:00'))->toBeNull();
});

it('does not let a cancelled order hold a slot', function (): void {
    // A slot held by an order nobody will collect is a table left empty on a full night.
    $preset = ourPreset(['use_timing' => true, 'slots_per_interval' => 1, 'interval_minutes' => 20]);
    $fx = $this->fx->withSession();

    DB::table('pos_orders')->insert([
        'uuid' => (string) Str::uuid(),
        'company_id' => $fx->company->getKey(),
        'pos_config_id' => $fx->config->getKey(),
        'pos_session_id' => $fx->session->getKey(),
        'currency_id' => $fx->currency->getKey(),
        'pos_preset_id' => $preset->getKey(),
        'preset_time' => '2026-06-01 12:05:00',
        'tracking_number' => 'T-9',
        'access_token' => Str::random(32),
        'state' => 'cancelled',
        'ordered_at' => now(),
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    expect(app(PresetSlotService::class)->refusalFor($preset, '2026-06-01 12:10:00'))->toBeNull();
});

it('says nothing about a mode that does not book', function (): void {
    // `use_timing` off means the mode takes orders as they come. Every check here has to stay quiet.
    $preset = ourPreset(['use_timing' => false, 'slots_per_interval' => 0]);

    expect(app(PresetSlotService::class)->refusalFor($preset, '2026-06-01 03:00:00'))->toBeNull();
});

it('counts an interval by the clock, not from when the window opens', function (): void {
    // Buckets are anchored to midnight. Anchoring them to the window's start would re-bucket every
    // booking already taken the moment someone edits the opening time.
    $preset = ourPreset(['use_timing' => true, 'slots_per_interval' => 1, 'interval_minutes' => 30]);
    $fx = $this->fx->withSession();
    $slots = app(PresetSlotService::class);

    expect($slots->isFullAt($preset, Carbon::parse('2026-06-01 12:00:00')))->toBeFalse();

    Order::query()->create([
        'uuid' => (string) Str::uuid(),
        'company_id' => $fx->company->getKey(),
        'pos_config_id' => $fx->config->getKey(),
        'pos_session_id' => $fx->session->getKey(),
        'currency_id' => $fx->currency->getKey(),
        'pos_preset_id' => $preset->getKey(),
        'preset_time' => '2026-06-01 12:29:00',
        'tracking_number' => 'T-2',
        'access_token' => Str::random(32),
        'state' => 'draft',
        'ordered_at' => now(),
    ]);

    expect($slots->isFullAt($preset, Carbon::parse('2026-06-01 12:00:00')))->toBeTrue()
        ->and($slots->isFullAt($preset, Carbon::parse('2026-06-01 12:30:00')))->toBeFalse();
});

it('does not let a booking on the boundary count against two intervals', function (): void {
    // `whereBetween` is inclusive at both ends, so without an exclusive upper bound an order at
    // exactly 12:20 fills a place in 12:00-12:20 *and* in 12:20-12:40 — halving the real capacity at
    // every boundary, on the busiest minute of each one.
    $preset = ourPreset(['use_timing' => true, 'slots_per_interval' => 1, 'interval_minutes' => 20]);
    $fx = $this->fx->withSession();

    DB::table('pos_orders')->insert([
        'uuid' => (string) Str::uuid(),
        'company_id' => $fx->company->getKey(),
        'pos_config_id' => $fx->config->getKey(),
        'pos_session_id' => $fx->session->getKey(),
        'currency_id' => $fx->currency->getKey(),
        'pos_preset_id' => $preset->getKey(),
        'preset_time' => '2026-06-01 12:20:00',
        'tracking_number' => 'T-3',
        'access_token' => Str::random(32),
        'state' => 'draft',
        'ordered_at' => now(),
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    $slots = app(PresetSlotService::class);

    // It belongs to the interval it opens, and to that one only.
    expect($slots->isFullAt($preset, Carbon::parse('2026-06-01 12:25:00')))->toBeTrue()
        ->and($slots->isFullAt($preset, Carbon::parse('2026-06-01 12:10:00')))->toBeFalse();
});

it('carries a mode created here all the way to the till', function (): void {
    // The ticket's acceptance criterion, and the check this project keeps needing: a screen that
    // saves and a register that never sees the result is the shape behind four premature Dones.
    // `PosPreset::posLoadScope` decides what reaches a register, and it reads the pivot and the
    // default — neither of which the create form writes, so this is the join being asserted, not the
    // insert.
    test()->post('/presets', ['name' => 'Livraison'])->assertSessionHasNoErrors();
    $preset = PosPreset::query()->where('name', 'Livraison')->firstOrFail();

    $reaches = function () use ($preset): bool {
        $payload = test()->withHeaders($this->fx->headers())
            ->getJson('/api/pos/bootstrap')->assertOk()->json();

        return collect($payload['data']['pos_presets'] ?? [])
            ->pluck('id')
            ->contains($preset->getKey());
    };

    // Created but attached to nothing: the register must not see it.
    expect($reaches())->toBeFalse();

    test()->patch("/pos-configs/{$this->fx->config->uuid}", [
        'use_presets' => true,
        'default_preset_id' => $preset->getKey(),
    ])->assertSessionHasNoErrors();

    expect($reaches())->toBeTrue();
});

it('carries its opening hours to the till alongside it', function (): void {
    // The windows ship as their own table in the payload. A mode that arrives without its hours is a
    // booking surface with no constraint on it.
    test()->post('/presets', ['name' => 'Livraison'])->assertSessionHasNoErrors();
    $preset = PosPreset::query()->where('name', 'Livraison')->firstOrFail();

    addWindow($preset)->assertSessionHasNoErrors();

    test()->patch("/pos-configs/{$this->fx->config->uuid}", [
        'use_presets' => true,
        'default_preset_id' => $preset->getKey(),
    ])->assertSessionHasNoErrors();

    $payload = test()->withHeaders($this->fx->headers())
        ->getJson('/api/pos/bootstrap')->assertOk()->json();

    expect(collect($payload['data']['preset_service_windows'] ?? [])
        ->pluck('pos_preset_id')
        ->contains($preset->getKey()))->toBeTrue();
});
