<?php

declare(strict_types=1);

namespace Tests\Feature\Backoffice\PosConfigUpdate;

use App\Models\Pos\PosConfig;
use App\Models\Pricing\CashRounding;
use App\Models\Pricing\Currency;
use App\Models\Pricing\Pricelist;
use App\Services\Pos\BootstrapService;
use BackedEnum;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * Register settings round-trip (BOF-031…BOF-044, BAN-466).
 *
 * The rule set validated 29 keys against 81 columns and Laravel drops what a rule set omits, so
 * most of this screen's controls were rendered `disabled` — including the register's **default
 * pricelist and default fiscal position, the two fields that decide every price the till quotes**.
 *
 * Each group asserts a *save and re-read*, not that the request returned 302. A dropped key also
 * returns 302; it just leaves the column alone. Reading the row back is the only thing that
 * distinguishes "saved" from "silently ignored", which is the whole defect.
 */
beforeEach(function (): void {
    // A decoy venue first, so the acting company is not id 1 and a leak has somewhere to leak from.
    $this->other = PosFixtures::make();

    $this->fx = PosFixtures::make();
    $this->actingAs($this->fx->userWith('backoffice.access', 'backoffice.manage_configs'));
});

/** @param array<string, mixed> $payload */
function save(array $payload): TestResponse
{
    // Addressed by uuid rather than through `route()`: these models bind by uuid but do not
    // override `getRouteKeyName()`, so the helper builds an id URL that 404s (the BAN-499 contract).
    $uuid = (string) test()->fx->config->uuid;

    return test()->patch("/pos-configs/{$uuid}", $payload);
}

/**
 * The column as the database holds it now.
 *
 * Enum-cast columns come back as instances, so they are unwrapped to the backing value — which is
 * what the column actually holds, and what a test should be asserting about.
 */
function stored(string $column): mixed
{
    $value = PosConfig::query()->whereKey(test()->fx->config->getKey())->value($column);

    return $value instanceof BackedEnum ? $value->value : $value;
}

it('sets the default pricelist, which decides every price the till quotes', function (): void {
    $pricelist = Pricelist::query()->create([
        'company_id' => $this->fx->company->getKey(),
        'currency_id' => $this->fx->currency->getKey(),
        'name' => 'Happy hour',
    ]);

    save(['pricelist_id' => $pricelist->getKey()])->assertSessionHasNoErrors()->assertRedirect();

    expect((int) stored('pricelist_id'))->toBe((int) $pricelist->getKey());
});

it('refuses a pricelist that prices in another currency', function (): void {
    // Not tidiness. `PricingService` reads the pricelist item's amount as-is — nothing converts —
    // so 12.00 in one currency is rendered under this register's symbol and charged as 12.00.
    $foreignCurrency = Currency::query()->create([
        'name' => 'Dollar', 'code' => 'USD', 'symbol' => '$', 'decimal_places' => 2, 'rounding' => '0.01',
    ]);

    $pricelist = Pricelist::query()->create([
        'company_id' => $this->fx->company->getKey(),
        'currency_id' => $foreignCurrency->getKey(),
        'name' => 'Dollar menu',
    ]);

    save(['pricelist_id' => $pricelist->getKey()])->assertSessionHasErrors('pricelist_id');

    expect(stored('pricelist_id'))->toBeNull();
});

it('refuses another company pricelist', function (): void {
    $theirs = Pricelist::query()->create([
        'company_id' => $this->other->company->getKey(),
        'currency_id' => $this->other->currency->getKey(),
        'name' => 'Their prices',
    ]);

    save(['pricelist_id' => $theirs->getKey()])->assertSessionHasErrors('pricelist_id');

    expect(stored('pricelist_id'))->toBeNull();
});

it('sets the default fiscal position', function (): void {
    $position = DB::table('fiscal_positions')->insertGetId([
        'company_id' => $this->fx->company->getKey(),
        'name' => 'Takeaway',
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    save(['default_fiscal_position_id' => $position])->assertSessionHasNoErrors()->assertRedirect();

    expect((int) stored('default_fiscal_position_id'))->toBe($position);
});

it('switches cash rounding on and chooses the rule', function (): void {
    $rounding = CashRounding::query()->create([
        'company_id' => $this->fx->company->getKey(),
        'name' => 'Five cents',
        'rounding' => '0.05',
        'rounding_method' => 'half_up',
    ]);

    save([
        'use_cash_rounding' => true,
        'cash_rounding_id' => $rounding->getKey(),
        'only_round_cash_payments' => true,
    ])->assertSessionHasNoErrors()->assertRedirect();

    expect((bool) stored('use_cash_rounding'))->toBeTrue()
        ->and((int) stored('cash_rounding_id'))->toBe((int) $rounding->getKey());
});

it('refuses another company cash rounding rule', function (): void {
    // Found in review of #95, in a rule this very PR added: `cash_rounding_id` used
    // `Rule::exists('cash_roundings', 'id')` on a comment claiming the table was venue-wide
    // reference data. It is not — it carries `company_id` and uses `BelongsToCompany`. And
    // `Rule::exists` runs on the query builder, which is exactly what `CompanyScope` cannot reach,
    // so the global scope offered no cover. Probed: 302, foreign rule stored, no complaint.
    $theirs = CashRounding::query()->create([
        'company_id' => $this->other->company->getKey(),
        'name' => 'Their rounding',
        'rounding' => '0.05',
        'rounding_method' => 'half_up',
    ]);

    save(['use_cash_rounding' => true, 'cash_rounding_id' => $theirs->getKey()])
        ->assertSessionHasErrors('cash_rounding_id');

    expect(stored('cash_rounding_id'))->toBeNull();
});

it('ships the chosen defaults to the till, which is where they decide a price', function (): void {
    // The acceptance criterion is not "the column stores" — it is that the register prices against
    // it. `configPayload()` sends every column and `order-actions.ts` starts a new order on
    // `config.pricelist_id` / `config.default_fiscal_position_id`, so this asserts the seam between
    // them: a value saved here is a value the till is handed.
    $pricelist = Pricelist::query()->create([
        'company_id' => $this->fx->company->getKey(),
        'currency_id' => $this->fx->currency->getKey(),
        'name' => 'Terrace',
    ]);

    save(['pricelist_id' => $pricelist->getKey()])->assertRedirect();

    $payload = app(BootstrapService::class)->payload(
        $this->fx->config->fresh(),
        $this->fx->device,
        ['pos_config'],
    );

    $shipped = $payload['data']['pos_config'] ?? [];

    expect((int) ($shipped['pricelist_id'] ?? 0))->toBe((int) $pricelist->getKey());
});

it('round-trips the interface group', function (): void {
    // Every one of these was locked: the operator could see the switch and not move it (BOF-034).
    save([
        'show_product_images' => false,
        'show_category_images' => false,
        'group_products_by_category' => true,
        'big_scrollbars' => true,
    ])->assertSessionHasNoErrors()->assertRedirect();

    expect((bool) stored('show_product_images'))->toBeFalse()
        ->and((bool) stored('show_category_images'))->toBeFalse()
        ->and((bool) stored('group_products_by_category'))->toBeTrue()
        ->and((bool) stored('big_scrollbars'))->toBeTrue();
});

it('round-trips the receipts group', function (): void {
    save([
        'auto_print_receipt' => true,
        'skip_receipt_screen' => true,
        'basic_receipt' => true,
        'show_receipt_header_footer' => true,
        'receipt_header' => 'Chez Amélie',
    ])->assertSessionHasNoErrors()->assertRedirect();

    expect((bool) stored('auto_print_receipt'))->toBeTrue()
        ->and((bool) stored('skip_receipt_screen'))->toBeTrue()
        ->and((bool) stored('basic_receipt'))->toBeTrue()
        ->and((string) stored('receipt_header'))->toBe('Chez Amélie');
});

it('round-trips the taxes and pricing group', function (): void {
    save([
        'tax_display' => 'total',
        'allow_manual_discount' => false,
        'restrict_price_control' => true,
        'show_margins_to_all' => true,
    ])->assertSessionHasNoErrors()->assertRedirect();

    expect((string) stored('tax_display'))->toBe('total')
        ->and((bool) stored('allow_manual_discount'))->toBeFalse()
        ->and((bool) stored('restrict_price_control'))->toBeTrue()
        ->and((bool) stored('show_margins_to_all'))->toBeTrue();
});

it('round-trips the restaurant, preparation and audit groups', function (): void {
    save([
        'enable_bill_print' => false,
        'default_screen' => 'register',
        'idle_return_seconds' => 90,
        'prep_auto_fire_first_course' => false,
        'order_edit_tracking' => true,
    ])->assertSessionHasNoErrors()->assertRedirect();

    expect((bool) stored('enable_bill_print'))->toBeFalse()
        ->and((string) stored('default_screen'))->toBe('register')
        ->and((int) stored('idle_return_seconds'))->toBe(90)
        ->and((bool) stored('prep_auto_fire_first_course'))->toBeFalse()
        ->and((bool) stored('order_edit_tracking'))->toBeTrue();
});

it('round-trips the payments group', function (): void {
    save([
        'auto_validate_terminal_payment' => false,
        'use_fast_payment' => true,
    ])->assertSessionHasNoErrors()->assertRedirect();

    expect((bool) stored('auto_validate_terminal_payment'))->toBeFalse()
        ->and((bool) stored('use_fast_payment'))->toBeTrue();
});

it('refuses a value outside an enum instead of storing it', function (): void {
    // The check constraint would fatal on write; a 422 says which field and why.
    save(['tax_display' => 'whatever'])->assertSessionHasErrors('tax_display');

    expect((string) stored('tax_display'))->toBe('subtotal');
});

it('adds a default service mode to the modes the register offers', function (): void {
    // BOF-032. A default the register does not offer is an opening screen that names a mode and
    // then refuses it. The editor does this too, but the editor is not the only way in.
    $preset = DB::table('pos_presets')->insertGetId([
        'company_id' => $this->fx->company->getKey(),
        'name' => 'Sur place',
        'service_at' => 'table',
        'sequence' => 10,
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    save(['use_presets' => true, 'default_preset_id' => $preset, 'preset_ids' => []])
        ->assertSessionHasNoErrors()->assertRedirect();

    expect(DB::table('pos_config_preset')
        ->where('pos_config_id', $this->fx->config->getKey())
        ->where('pos_preset_id', $preset)
        ->exists())->toBeTrue();
});

it('answers 422 for a payment method id that does not exist, not 500', function (): void {
    // An FK violation on `sync()` is a 500 with a stack trace; the operator sees "server error"
    // for what is a stale checkbox.
    save(['payment_method_ids' => [999999]])->assertSessionHasErrors('payment_method_ids');
});

it('refuses a user who may see the register but not change it', function (): void {
    $this->actingAs($this->fx->userWith('backoffice.access'));

    save(['name' => 'Renamed'])->assertForbidden();

    expect((string) stored('name'))->not->toBe('Renamed');
});

it('does not even resolve another company register, let alone save it', function (): void {
    // 404 rather than 403, and that is the better answer: `BelongsToCompany` scopes the route
    // binding, so the register is not found at all. A 403 would confirm that a register with this
    // uuid exists — the policy's `sameCompany` is the second line here, not the first.
    $this->actingAs($this->other->userWith('backoffice.access', 'backoffice.manage_configs'));

    save(['name' => 'Theirs now'])->assertNotFound();

    expect((string) stored('name'))->not->toBe('Theirs now');
});

it('leaves the currency alone once the register has taken money', function (): void {
    // Amounts on orders and sessions carry no currency of their own — they inherit the register's.
    // Change it afterwards and yesterday's 40.00 close silently re-denominates.
    $fx = $this->fx->withSession('50.00');

    $other = Currency::query()->create([
        'name' => 'Dollar', 'code' => 'USD', 'symbol' => '$', 'decimal_places' => 2, 'rounding' => '0.01',
    ]);

    save(['currency_id' => $other->getKey()])->assertSessionHasErrors('currency_id');

    expect((int) stored('currency_id'))->toBe((int) $fx->currency->getKey());
});

it('lets a register that has taken nothing still change currency', function (): void {
    // The negative half: the guard is about history, not about the field being sacred.
    $other = Currency::query()->create([
        'name' => 'Dollar', 'code' => 'USD', 'symbol' => '$', 'decimal_places' => 2, 'rounding' => '0.01',
    ]);

    save(['currency_id' => $other->getKey()])->assertSessionHasNoErrors()->assertRedirect();

    expect((int) stored('currency_id'))->toBe((int) $other->getKey());
});

it('does not touch a column the request never mentioned', function (): void {
    // Every rule is `sometimes` for this reason: the screen saves one tab at a time, and a save
    // from Payments must not blank what Receipts owns.
    save(['receipt_header' => 'Merci'])->assertRedirect();
    save(['use_fast_payment' => true])->assertRedirect();

    expect((string) stored('receipt_header'))->toBe('Merci');
});

it('bumps the revision so tills discard their cache', function (): void {
    $before = (int) stored('config_revision');

    save(['show_product_images' => false])->assertRedirect();

    expect((int) stored('config_revision'))->toBeGreaterThan($before);
});
