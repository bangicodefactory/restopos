<?php

declare(strict_types=1);

namespace Tests\Feature\Backoffice\SelfOrderSettings;

use App\Models\Identity\Language;
use App\Models\Pos\PosConfig;
use App\Models\Restaurant\Floor;
use App\Models\Restaurant\Table;
use App\Models\SelfOrder\CustomLink;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * Self-order settings and per-table QR codes (BAN-479).
 *
 * Three things were wrong here and only one of them is the one the ticket leads with.
 */
beforeEach(function (): void {
    $this->other = PosFixtures::make();

    $this->fx = PosFixtures::make();
    $this->actingAs($this->fx->userWith('backoffice.access', 'backoffice.manage_configs'));
});

/** @param array<string, mixed> $payload */
function saveSelfOrder(array $payload): TestResponse
{
    $uuid = (string) test()->fx->config->uuid;

    return test()->patch("/self-order/{$uuid}/settings", $payload);
}

function storedSelfOrder(string $column): mixed
{
    return PosConfig::query()->whereKey(test()->fx->config->getKey())->value($column);
}

it('sets the language customers are greeted in', function (): void {
    // Rendered on this page since it was written and absent from the rule set, so the control
    // flipped, saved "successfully" and came back unchanged. A venue could not set its
    // customer-facing language from the UI at all.
    $language = Language::query()->firstOrCreate(
        ['code' => 'es'],
        ['iso_code' => 'es', 'name' => 'Español'],
    );

    saveSelfOrder(['self_ordering_default_language_id' => $language->getKey()])
        ->assertSessionHasNoErrors()->assertRedirect();

    expect((int) storedSelfOrder('self_ordering_default_language_id'))->toBe((int) $language->getKey());
});

it('refuses a language that does not exist', function (): void {
    saveSelfOrder(['self_ordering_default_language_id' => 999999])
        ->assertSessionHasErrors('self_ordering_default_language_id');
});

it('never points the kiosk at another venue payment method', function (): void {
    // This took a raw id with no ownership check of any kind. The kiosk's online payment method
    // decides where a customer's money goes — another venue's method here is not a display bug.
    $theirs = $this->other->card;

    saveSelfOrder(['self_order_online_payment_method_id' => $theirs->getKey()])
        ->assertSessionHasErrors('self_order_online_payment_method_id');

    expect(storedSelfOrder('self_order_online_payment_method_id'))->toBeNull();
});

it('accepts one of its own payment methods', function (): void {
    saveSelfOrder(['self_order_online_payment_method_id' => $this->fx->card->getKey()])
        ->assertSessionHasNoErrors();

    expect((int) storedSelfOrder('self_order_online_payment_method_id'))
        ->toBe((int) $this->fx->card->getKey());
});

it('never attaches another venue custom link to this kiosk', function (): void {
    // `sync()` writes whatever ids it is handed, and these links render on the venue's own kiosk:
    // another company's link is their text and their URL shown to this venue's customers.
    $theirs = CustomLink::query()->create([
        'company_id' => $this->other->company->getKey(),
        'name' => 'Leur promo',
        'url' => 'https://example.test/theirs',
    ]);

    saveSelfOrder(['custom_link_ids' => [$theirs->getKey()]])
        ->assertSessionHasErrors('custom_link_ids');

    expect(DB::table('pos_config_self_order_custom_link')
        ->where('pos_config_id', $this->fx->config->getKey())
        ->count())->toBe(0);
});

it('refuses the whole save rather than quietly dropping the foreign link', function (): void {
    // Filtering would mean the operator ticks two boxes, the save succeeds, and one of them is
    // simply not there — which they find out when a customer does not see it.
    $ours = CustomLink::query()->create([
        'company_id' => $this->fx->company->getKey(),
        'name' => 'Notre promo',
        'url' => 'https://example.test/ours',
    ]);

    $theirs = CustomLink::query()->create([
        'company_id' => $this->other->company->getKey(),
        'name' => 'Leur promo',
        'url' => 'https://example.test/theirs',
    ]);

    saveSelfOrder(['custom_link_ids' => [$ours->getKey(), $theirs->getKey()]])
        ->assertSessionHasErrors('custom_link_ids');

    expect(DB::table('pos_config_self_order_custom_link')
        ->where('pos_config_id', $this->fx->config->getKey())
        ->count())->toBe(0);
});

it('attaches links of its own', function (): void {
    $ours = CustomLink::query()->create([
        'company_id' => $this->fx->company->getKey(),
        'name' => 'Notre promo',
        'url' => 'https://example.test/ours',
    ]);

    saveSelfOrder(['custom_link_ids' => [$ours->getKey()]])->assertSessionHasNoErrors();

    expect(DB::table('pos_config_self_order_custom_link')
        ->where('pos_config_id', $this->fx->config->getKey())
        ->where('self_order_custom_link_id', $ours->getKey())
        ->exists())->toBeTrue();
});

it('hands the page its tables, so nobody has to paste a capability token', function (): void {
    // The page's own docblock called this a contract gap and worked around it by asking the
    // operator to paste table tokens into a textarea. A table token is the capability that lets a
    // diner order at that table — copying it by hand means a QR stuck to table 6 that opens table
    // 9's order, and nothing on any screen would say so.
    $this->withoutVite();

    $fx = $this->fx->withFloor();
    $fx->table(6);

    DB::table('pos_config_floor')->insertOrIgnore([
        'pos_config_id' => $fx->config->getKey(),
        'restaurant_floor_id' => $fx->floor->getKey(),
    ]);

    $this->get("/self-order/{$fx->config->uuid}/settings")
        ->assertOk()
        ->assertInertia(fn ($page) => $page->where(
            'tables',
            fn ($tables): bool => collect($tables)->contains(
                fn (array $row): bool => $row['table_number'] === 6 && $row['identifier'] !== '',
            ),
        ));
});

it('does not hand it a table from a floor this register does not serve', function (): void {
    $this->withoutVite();

    $theirs = $this->other->withFloor();
    $theirs->table(9);

    $fx = $this->fx->withFloor();
    $fx->table(6);

    DB::table('pos_config_floor')->insertOrIgnore([
        'pos_config_id' => $fx->config->getKey(),
        'restaurant_floor_id' => $fx->floor->getKey(),
    ]);

    $this->get("/self-order/{$fx->config->uuid}/settings")
        ->assertOk()
        ->assertInertia(fn ($page) => $page->where(
            'tables',
            fn ($tables): bool => collect($tables)->doesntContain(
                fn (array $row): bool => $row['table_number'] === 9,
            ),
        ));
});

it('does not hand it a table from its own venue that this register does not serve', function (): void {
    // The case that matters, and the one a cross-venue test cannot reach: `CompanyScope` already
    // hides another company's tables, so removing the floor filter passed clean until this existed.
    //
    // A venue with a terrace till and a restaurant till serves different rooms from each. Printing
    // the restaurant's QR codes from the terrace register would produce cards that point diners at
    // a register which does not serve their table.
    $this->withoutVite();

    $fx = $this->fx->withFloor();
    $fx->table(6);

    // A second room in the same venue, which this register is not attached to.
    $otherFloor = Floor::query()->create([
        'company_id' => $fx->company->getKey(),
        'name' => 'Terrasse',
    ]);

    Table::query()->create([
        'company_id' => $fx->company->getKey(),
        'restaurant_floor_id' => $otherFloor->getKey(),
        'uuid' => (string) Str::uuid(),
        'table_number' => 99,
        'identifier' => Table::newIdentifier(),
    ]);

    DB::table('pos_config_floor')->insertOrIgnore([
        'pos_config_id' => $fx->config->getKey(),
        'restaurant_floor_id' => $fx->floor->getKey(),
    ]);

    $this->get("/self-order/{$fx->config->uuid}/settings")
        ->assertOk()
        ->assertInertia(fn ($page) => $page->where(
            'tables',
            fn ($tables): bool => collect($tables)->doesntContain(
                fn (array $row): bool => $row['table_number'] === 99,
            ),
        ));
});

it('refuses another venue image as the kiosk brand', function (): void {
    // The negative half of the brand picker. Only the happy path was covered, so removing the
    // ownership check changed nothing any test could see.
    Storage::fake('public');

    $this->actingAs($this->other->userWith('backoffice.access', 'backoffice.manage_media'));

    $theirs = $this->postJson('/media', [
        'file' => UploadedFile::fake()->image('theirs.png', 100, 40),
        'collection' => 'brand',
    ])->json('id');

    $this->actingAs($this->fx->userWith('backoffice.access', 'backoffice.manage_configs'));

    saveSelfOrder(['self_ordering_brand_media_id' => $theirs])
        ->assertSessionHasErrors('self_ordering_brand_media_id');

    expect(storedSelfOrder('self_ordering_brand_media_id'))->toBeNull();
});

it('sets the kiosk brand image, which needed the upload pipeline first', function (): void {
    Storage::fake('public');

    $this->actingAs($this->fx->userWith('backoffice.access', 'backoffice.manage_configs', 'backoffice.manage_media'));

    $id = $this->postJson('/media', [
        'file' => UploadedFile::fake()->image('brand.png', 200, 80),
        'collection' => 'brand',
    ])->json('id');

    saveSelfOrder(['self_ordering_brand_media_id' => $id])->assertSessionHasNoErrors();

    expect((int) storedSelfOrder('self_ordering_brand_media_id'))->toBe($id);
});

it('bumps the revision so the kiosk picks the change up', function (): void {
    $before = (int) storedSelfOrder('config_revision');

    saveSelfOrder(['kiosk_idle_seconds' => 45])->assertRedirect();

    expect((int) storedSelfOrder('config_revision'))->toBeGreaterThan($before);
});
