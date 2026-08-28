<?php

declare(strict_types=1);

namespace Tests\Feature\Backoffice\PosConfigUpdate;

use App\Enums\SequencePurpose;
use App\Models\Pos\PosConfig;
use App\Models\Pricing\CashRounding;
use App\Models\Pricing\Currency;
use App\Models\Pricing\Pricelist;
use App\Models\User;
use App\Services\Pos\BootstrapService;
use App\Services\Pos\SequenceService;
use BackedEnum;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
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
    // Deliberately *our* currency. Given the other venue's, the currency rule refuses it and the
    // ownership check is never reached — which is exactly how a sabotage removing that check
    // passed clean. One rule at a time.
    $theirs = Pricelist::query()->create([
        'company_id' => $this->other->company->getKey(),
        'currency_id' => $this->fx->currency->getKey(),
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

it('refuses a foreign pricelist even to a super-admin', function (): void {
    // The case the explicit `company_id` filter in `owned()` exists for, and the only one that
    // reaches it. `CompanyScope` deliberately steps aside for a super-admin, so every other
    // cross-company test here passes on the scope alone — a sabotage removing the filter went
    // unnoticed until this test existed.
    //
    // Crossing companies is what the flag is for; pointing a register at another venue's pricelist
    // is not an authorisation question. It prices this venue's sales wrongly whoever did it.
    $this->actingAs(User::factory()->create(['is_super_admin' => true]));

    // Deliberately *our* currency. Given the other venue's, the currency rule refuses it and the
    // ownership check is never reached — which is exactly how a sabotage removing that check
    // passed clean. One rule at a time.
    $theirs = Pricelist::query()->create([
        'company_id' => $this->other->company->getKey(),
        'currency_id' => $this->fx->currency->getKey(),
        'name' => 'Their prices',
    ]);

    save(['pricelist_id' => $theirs->getKey()])->assertSessionHasErrors('pricelist_id');

    expect(stored('pricelist_id'))->toBeNull();
});

it('still lets a super-admin set a pricelist that does belong to the register', function (): void {
    // The negative half: the filter is about ownership, not about refusing super-admins.
    $this->actingAs(User::factory()->create(['is_super_admin' => true]));

    $ours = Pricelist::query()->create([
        'company_id' => $this->fx->company->getKey(),
        'currency_id' => $this->fx->currency->getKey(),
        'name' => 'Ours',
    ]);

    save(['pricelist_id' => $ours->getKey()])->assertSessionHasNoErrors();

    expect((int) stored('pricelist_id'))->toBe((int) $ours->getKey());
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

// ───────────────────────────────────────────── numbering (BOF-045, BAN-488)

it('prefixes document numbers with the register setting', function (): void {
    // `SequenceService::prefixFor()` derived this from the register's *name*, so renaming a register
    // renumbered every document after the rename — which is the one thing a legally sequential
    // number must not do — and a venue whose accountant expects `T1/` on till one could not say so.
    $config = $this->fx->config;

    test()->patch("/pos-configs/{$config->uuid}", ['sequence_prefix' => 'T1'])
        ->assertSessionHasNoErrors();

    expect(app(SequenceService::class)->orderName($config->fresh(), 412))->toStartWith('T1/');
});

it('derives the prefix from the name when the box is left empty', function (): void {
    // Null and empty are different: null restores the derived behaviour every register has today,
    // while `''` would store a value and number documents `/00412`. A text input cannot send null,
    // so the request normalises it.
    $config = $this->fx->config;
    $config->forceFill(['sequence_prefix' => 'T1'])->save();

    test()->patch("/pos-configs/{$config->uuid}", ['sequence_prefix' => ''])
        ->assertSessionHasNoErrors();

    expect(PosConfig::query()->whereKey($config->getKey())->value('sequence_prefix'))->toBeNull()
        ->and(app(SequenceService::class)->orderName($config->fresh(), 412))->not->toStartWith('/');
});

it('refuses a prefix that would read as two fields', function (): void {
    // It is glued straight onto the number with a slash, so a prefix carrying one produces
    // `T1/2/00412` — two fields where the format promises one, and an accountant unpicking it.
    test()->patch("/pos-configs/{$this->fx->config->uuid}", ['sequence_prefix' => 'T1/2'])
        ->assertSessionHasErrors('sequence_prefix');
});

it('shows the numbers this register has already issued', function (): void {
    // Read-only, and that is the point: these are allocated under a row lock, and a field that could
    // set `next_value` would let someone reissue a receipt number a customer already holds.
    test()->withoutVite();

    app(SequenceService::class)->allocate($this->fx->config, SequencePurpose::Order);

    // `options` is deferred, so it is absent from the first response by design — the settings page
    // asks for it separately. Requesting it the way the page does is the only way to assert what
    // the operator will actually be shown.
    $response = test()->withHeaders([
        'X-Inertia' => 'true',
        'X-Inertia-Version' => PosFixtures::inertiaVersion(),
        'X-Inertia-Partial-Component' => 'PosConfigs/Edit',
        'X-Inertia-Partial-Data' => 'options',
    ])->get("/pos-configs/{$this->fx->config->uuid}/edit")->assertOk();

    $sequences = json_decode((string) $response->getContent(), true)['props']['options']['sequences'] ?? [];

    expect($sequences)->not->toBeEmpty()
        ->and(collect($sequences)->pluck('purpose'))->toContain('order')
        ->and(collect($sequences)->first())->toHaveKeys(['purpose', 'prefix', 'padding', 'next_value']);
});

it('shows only this register numbers, not the ones next to it', function (): void {
    // Two registers in a venue each number their own documents, and the point of the list is to say
    // what *this* one will issue next. Showing the neighbour's counters would read as this
    // register's, which is worse than showing nothing during an audit.
    test()->withoutVite();

    $second = $this->fx->config->replicate(['uuid', 'access_token']);
    $second->forceFill([
        'uuid' => (string) Str::uuid(),
        'name' => 'Terrasse',
        'access_token' => Str::random(32),
    ])->save();

    app(SequenceService::class)->allocate($this->fx->config, SequencePurpose::Order);
    app(SequenceService::class)->allocate($second, SequencePurpose::Invoice);

    $response = test()->withHeaders([
        'X-Inertia' => 'true',
        'X-Inertia-Version' => PosFixtures::inertiaVersion(),
        'X-Inertia-Partial-Component' => 'PosConfigs/Edit',
        'X-Inertia-Partial-Data' => 'options',
    ])->get("/pos-configs/{$this->fx->config->uuid}/edit")->assertOk();

    $purposes = collect(
        json_decode((string) $response->getContent(), true)['props']['options']['sequences'] ?? []
    )->pluck('purpose');

    expect($purposes)->toContain('order')
        ->and($purposes)->not->toContain('invoice');
});
