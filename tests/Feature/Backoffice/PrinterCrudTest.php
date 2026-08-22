<?php

declare(strict_types=1);

namespace Tests\Feature\Backoffice\PrinterCrud;

use App\Enums\PrintJobState;
use App\Enums\PrintJobType;
use App\Models\Catalog\PosCategory;
use App\Models\Identity\Permission;
use App\Models\Identity\Role;
use App\Models\Pos\PosPrinter;
use App\Models\User;
use App\Services\Catalog\CategoryTree;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * A back-office user of `$fx`'s company holding `$permissions`.
 *
 * Deliberately **not** a super-admin, which every other back-office suite uses. A super-admin
 * bypasses `PrinterPolicy` entirely, so a suite written on one would pass with no policy at all —
 * and it has no company of its own, which is the case `store` refuses.
 *
 * @param  list<string>  $permissions
 */
function actorWith(PosFixtures $fx, array $permissions): User
{
    $role = Role::query()->create([
        'name' => 'Kitchen manager',
        'slug' => 'kitchen-manager-'.Str::random(6),
        'is_system' => false,
    ]);

    foreach ($permissions as $slug) {
        $permission = Permission::query()->firstOrCreate(['slug' => $slug], ['group' => 'pos']);
        DB::table('permission_role')->insertOrIgnore([
            'role_id' => $role->getKey(),
            'permission_id' => $permission->getKey(),
        ]);
    }

    $user = User::factory()->create([
        'company_id' => $fx->company->getKey(),
        'is_super_admin' => false,
    ]);

    DB::table('role_user')->insert(['role_id' => $role->getKey(), 'user_id' => $user->getKey()]);

    return $user;
}

beforeEach(function (): void {
    // A decoy venue first, so the acting company is **not** id 1. Without it, a controller that
    // hardcoded `company_id => 1` was indistinguishable from one that read the acting user — and a
    // sabotage doing exactly that passed every test here.
    PosFixtures::make();

    $this->fx = PosFixtures::make();
    $this->actingAs(actorWith($this->fx, ['pos.kitchen.view', 'pos.kitchen.manage']));
});

/** @param array<string, mixed> $payload */
function createPrinter(array $payload = []): TestResponse
{
    return test()->post(route('printers.store'), [
        'name' => 'Pass',
        'printer_type' => 'network_escpos',
        'characters_per_line' => 42,
        'copies' => 1,
        'active' => true,
        ...$payload,
    ]);
}

/**
 * A category, created through the endpoint that normally creates them.
 *
 * `pos_categories` carries a materialised `path` the controller computes; inserting the row by hand
 * here would be a second, weaker definition of what a category is — and it fails outright on the
 * NOT NULL column, which is the honest version of the same objection.
 */
function categoryId(string $name): int
{
    // Through `CategoryTree` rather than the endpoint: this is a fixture, and since BAN-422 the
    // category routes need `config.manage`, which a kitchen manager does not have. The service is
    // what computes `path`, so the row is still built the way the application builds it.
    $category = PosCategory::query()->create([
        'company_id' => test()->fx->company->getKey(),
        'name' => $name,
        'sequence' => 10,
        'depth' => 0,
        'path' => '/',
    ]);

    app(CategoryTree::class)->place($category, null);

    return (int) $category->getKey();
}

function routedCategories(int $printerId): array
{
    return DB::table('pos_category_pos_printer')
        ->where('pos_printer_id', $printerId)
        ->pluck('pos_category_id')
        ->map(static fn (mixed $v): int => (int) $v)
        ->sort()
        ->values()
        ->all();
}

/**
 * BOF-114 (BAN-432) — adding and removing a kitchen printer.
 *
 * The controller had `update` and nothing else: a new printer could not be added from the UI and an
 * old one could not be removed. `printer_type` — the field that decides *how* the device is driven —
 * was absent from the rules, so the one thing about a seeded printer nobody could change was the one
 * thing that makes it work.
 */
it('adds a printer', function (): void {
    createPrinter(['name' => 'Grill'])->assertRedirect();

    expect(PosPrinter::query()->where('name', 'Grill')->exists())->toBeTrue();
});

it('files it against the acting company, not whatever was posted', function (): void {
    createPrinter(['name' => 'Grill'])->assertRedirect();

    expect((int) PosPrinter::query()->where('name', 'Grill')->value('company_id'))
        ->toBe((int) $this->fx->company->getKey());
});

it('sets the transport, which was the field nobody could change', function (): void {
    createPrinter(['name' => 'Grill', 'printer_type' => 'iot'])->assertRedirect();

    expect(PosPrinter::query()->where('name', 'Grill')->value('printer_type')->value)->toBe('iot');
});

it('switches an existing printer to another transport', function (): void {
    createPrinter(['name' => 'Grill', 'printer_type' => 'network_escpos'])->assertRedirect();
    $printer = PosPrinter::query()->where('name', 'Grill')->firstOrFail();

    test()->patch(route('printers.update', $printer), ['printer_type' => 'epson_epos'])->assertRedirect();

    expect(PosPrinter::query()->whereKey($printer->getKey())->value('printer_type')->value)->toBe('epson_epos');
});

it('refuses a transport the print agent would never pick up', function (): void {
    createPrinter(['printer_type' => 'carrier_pigeon'])->assertSessionHasErrors('printer_type');
});

it('routes categories to it', function (): void {
    $starters = categoryId('Starters');
    $mains = categoryId('Mains');

    createPrinter(['name' => 'Grill', 'category_ids' => [$starters, $mains]])->assertRedirect();

    $printer = PosPrinter::query()->where('name', 'Grill')->firstOrFail();

    expect(routedCategories((int) $printer->getKey()))->toBe(collect([$starters, $mains])->sort()->values()->all());
});

it('refuses an unknown category instead of quietly unrouting the printer', function (): void {
    // The old code filtered unknown ids out downstream, so `[999]` did not fail — it replaced the
    // routing with nothing. The printer stayed on screen looking configured and the first anybody
    // knew was food not being cooked.
    $starters = categoryId('Starters');

    createPrinter(['name' => 'Grill', 'category_ids' => [$starters]])->assertRedirect();
    $printer = PosPrinter::query()->where('name', 'Grill')->firstOrFail();

    test()->patch(route('printers.update', $printer), ['category_ids' => [999]])
        ->assertSessionHasErrors('category_ids');

    expect(routedCategories((int) $printer->getKey()))->toBe([$starters]);
});

it('refuses another company category, which is the same hole from outside', function (): void {
    $other = PosFixtures::make();

    // Built through the endpoint — the only thing that fills the materialised `path` — then re-filed
    // against the other company. A hand-rolled insert would be a different row shape, and the point
    // here is a *valid* category that simply is not ours.
    $theirs = categoryId('Their Starters');
    PosCategory::query()->whereKey($theirs)->update(['company_id' => $other->company->getKey()]);

    createPrinter(['name' => 'Grill'])->assertRedirect();
    $printer = PosPrinter::query()->where('name', 'Grill')->firstOrFail();

    test()->patch(route('printers.update', $printer), ['category_ids' => [$theirs]])
        ->assertSessionHasErrors('category_ids');

    expect(routedCategories((int) $printer->getKey()))->toBe([]);
});

it('routes nothing when an empty list is sent, which is different from not mentioning it', function (): void {
    $starters = categoryId('Starters');

    createPrinter(['name' => 'Grill', 'category_ids' => [$starters]])->assertRedirect();
    $printer = PosPrinter::query()->where('name', 'Grill')->firstOrFail();

    test()->patch(route('printers.update', $printer), ['category_ids' => []])->assertRedirect();

    expect(routedCategories((int) $printer->getKey()))->toBe([]);
});

it('leaves the routing alone when the payload does not mention it', function (): void {
    // A save from the name field must not unroute a printer the routing tab configured.
    $starters = categoryId('Starters');

    createPrinter(['name' => 'Grill', 'category_ids' => [$starters]])->assertRedirect();
    $printer = PosPrinter::query()->where('name', 'Grill')->firstOrFail();

    test()->patch(route('printers.update', $printer), ['name' => 'Grill Station'])->assertRedirect();

    expect(routedCategories((int) $printer->getKey()))->toBe([$starters]);
});

it('removes a printer', function (): void {
    createPrinter(['name' => 'Grill'])->assertRedirect();
    $printer = PosPrinter::query()->where('name', 'Grill')->firstOrFail();

    test()->delete(route('printers.destroy', $printer))->assertRedirect();

    expect(PosPrinter::query()->whereKey($printer->getKey())->exists())->toBeFalse();
});

it('takes its routing with it rather than leaving orphan pivot rows', function (): void {
    $starters = categoryId('Starters');

    createPrinter(['name' => 'Grill', 'category_ids' => [$starters]])->assertRedirect();
    $printer = PosPrinter::query()->where('name', 'Grill')->firstOrFail();

    test()->delete(route('printers.destroy', $printer))->assertRedirect();

    expect(routedCategories((int) $printer->getKey()))->toBe([]);
});

it('refuses to delete a printer with work still queued', function (): void {
    // Those rows are food waiting to be cooked. Deleting the printer cascades them away while the
    // order they belong to still says the kitchen was told.
    createPrinter(['name' => 'Grill'])->assertRedirect();
    $printer = PosPrinter::query()->where('name', 'Grill')->firstOrFail();

    DB::table('preparation_print_jobs')->insert([
        'uuid' => (string) Str::uuid(),
        'company_id' => $this->fx->company->getKey(),
        'pos_config_id' => $this->fx->config->getKey(),
        'pos_printer_id' => $printer->getKey(),
        'job_type' => PrintJobType::Test->value,
        'payload' => '{}',
        'copies' => 1,
        'state' => PrintJobState::Queued->value,
        'queued_at' => now(),
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    test()->delete(route('printers.destroy', $printer))->assertSessionHasErrors('printer');

    expect(PosPrinter::query()->whereKey($printer->getKey())->exists())->toBeTrue();
});

it('allows the delete once the queue is done', function (): void {
    createPrinter(['name' => 'Grill'])->assertRedirect();
    $printer = PosPrinter::query()->where('name', 'Grill')->firstOrFail();

    DB::table('preparation_print_jobs')->insert([
        'uuid' => (string) Str::uuid(),
        'company_id' => $this->fx->company->getKey(),
        'pos_config_id' => $this->fx->config->getKey(),
        'pos_printer_id' => $printer->getKey(),
        'job_type' => PrintJobType::Test->value,
        'payload' => '{}',
        'copies' => 1,
        'state' => PrintJobState::Printed->value,
        'queued_at' => now(),
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    test()->delete(route('printers.destroy', $printer))->assertRedirect();

    expect(PosPrinter::query()->whereKey($printer->getKey())->exists())->toBeFalse();
});

it('refuses a user who may not configure the kitchen', function (): void {
    // The policy, not the tenancy scope: this user belongs to the right company and simply is not
    // allowed to take a station out of service. Before BAN-432 the only write was `update` and it
    // was ungated; adding create and delete widened that rather than introducing it.
    createPrinter(['name' => 'Grill'])->assertRedirect();
    $printer = PosPrinter::query()->where('name', 'Grill')->firstOrFail();

    test()->actingAs(actorWith($this->fx, ['pos.kitchen.view']));

    createPrinter(['name' => 'Sneaky'])->assertForbidden();
    test()->delete(route('printers.destroy', $printer))->assertForbidden();
    test()->patch(route('printers.update', $printer), ['name' => 'Renamed'])->assertForbidden();

    expect(PosPrinter::query()->where('name', 'Sneaky')->exists())->toBeFalse()
        ->and(PosPrinter::query()->whereKey($printer->getKey())->exists())->toBeTrue();
});
