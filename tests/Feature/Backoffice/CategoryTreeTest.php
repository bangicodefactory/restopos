<?php

declare(strict_types=1);

namespace Tests\Feature\Backoffice\CategoryTree;

use App\Models\Catalog\PosCategory;
use App\Models\Identity\Permission;
use App\Models\Identity\Role;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * A real permissioned user rather than a super-admin, which bypasses the policy entirely.
 *
 * @param  list<string>  $permissions
 */
function treeActor(PosFixtures $fx, array $permissions): User
{
    $role = Role::query()->create([
        'name' => 'Config manager',
        'slug' => 'config-manager-'.Str::random(6),
        'is_system' => false,
    ]);

    foreach ($permissions as $slug) {
        $permission = Permission::query()->firstOrCreate(['slug' => $slug], ['group' => 'config']);
        DB::table('permission_role')->insertOrIgnore([
            'role_id' => $role->getKey(),
            'permission_id' => $permission->getKey(),
        ]);
    }

    $user = User::factory()->create(['company_id' => $fx->company->getKey(), 'is_super_admin' => false]);
    DB::table('role_user')->insert(['role_id' => $role->getKey(), 'user_id' => $user->getKey()]);

    return $user;
}

beforeEach(function (): void {
    // A decoy venue first, so the acting company is not id 1.
    PosFixtures::make();

    $this->fx = PosFixtures::make();
    $this->actingAs(treeActor($this->fx, ['catalog.view', 'catalog.manage_categories']));
});

/** @param array<string, mixed> $payload */
function addCategory(array $payload = []): TestResponse
{
    return test()->postJson(route('categories.store'), ['name' => 'Desserts', ...$payload]);
}

function categoryNamed(string $name): PosCategory
{
    return PosCategory::query()->where('name', $name)->firstOrFail();
}

/** id, path and depth of a row, for asserting a whole subtree at once. */
function shapeOf(string $name): array
{
    $row = categoryNamed($name);

    return ['path' => (string) $row->path, 'depth' => (int) $row->depth];
}

/**
 * BOF-084 (BAN-422) — the POS category tree.
 *
 * `store` and `update` accepted different fields, and the two forms mirrored the split exactly, so
 * it read as deliberate. It was two absent capabilities: no availability window at creation, and no
 * way to move a category ever. Moving one meant delete-and-recreate — and since every referent of
 * `pos_categories` cascades, that threw away its products, its printer routing and its pricelist
 * rules on the way past.
 */

// ───────────────────────────────────────────────────────── the two doors agree

it('keeps an availability window set at creation, with no second edit', function (): void {
    addCategory(['hour_after' => 11.5, 'hour_until' => 14.0])
        ->assertSessionHasNoErrors()->assertRedirect();

    $category = categoryNamed('Desserts');

    expect((float) $category->hour_after)->toBe(11.5)
        ->and((float) $category->hour_until)->toBe(14.0);
});

it('refuses a window that closes before it opens', function (): void {
    // `pos_categories` carries a check constraint that `hour_until >= hour_after`, so without the
    // rule this is a SQLSTATE reaching a manager as a 500 that names nothing.
    addCategory(['hour_after' => 14.0, 'hour_until' => 11.5])->assertStatus(422);
});

// ─────────────────────────────────────────────────────────────── re-parenting

it('moves a category under a new parent', function (): void {
    addCategory(['name' => 'Drinks'])->assertRedirect();
    addCategory(['name' => 'Wine'])->assertRedirect();

    $drinks = categoryNamed('Drinks');

    test()->patchJson(route('categories.update', categoryNamed('Wine')->getKey()), [
        'parent_id' => $drinks->getKey(),
    ])->assertSessionHasNoErrors()->assertRedirect();

    expect((int) categoryNamed('Wine')->parent_id)->toBe((int) $drinks->getKey());
});

it('rewrites path and depth for the whole subtree, not just the node', function (): void {
    // The path is what three `LIKE` scopes resolve a branch by. Leave a descendant's stale and the
    // subtree stays where it used to be: a category moved out of the self-order menu still shows,
    // and the kitchen printers still fire for the old branch.
    addCategory(['name' => 'Drinks'])->assertRedirect();
    addCategory(['name' => 'Wine'])->assertRedirect();
    addCategory(['name' => 'Red', 'parent_id' => categoryNamed('Wine')->getKey()])->assertRedirect();
    addCategory(['name' => 'Bordeaux', 'parent_id' => categoryNamed('Red')->getKey()])->assertRedirect();

    $drinks = categoryNamed('Drinks');
    $wine = categoryNamed('Wine');

    expect(shapeOf('Bordeaux')['depth'])->toBe(2);

    test()->patchJson(route('categories.update', $wine->getKey()), ['parent_id' => $drinks->getKey()])
        ->assertSessionHasNoErrors()->assertRedirect();

    $wineId = (int) $wine->getKey();
    $redId = (int) categoryNamed('Red')->getKey();
    $bordeauxId = (int) categoryNamed('Bordeaux')->getKey();
    $drinksId = (int) $drinks->getKey();

    expect(shapeOf('Wine'))->toBe(['path' => "/{$drinksId}/{$wineId}/", 'depth' => 1])
        ->and(shapeOf('Red'))->toBe(['path' => "/{$drinksId}/{$wineId}/{$redId}/", 'depth' => 2])
        ->and(shapeOf('Bordeaux'))
        ->toBe(['path' => "/{$drinksId}/{$wineId}/{$redId}/{$bordeauxId}/", 'depth' => 3]);
});

it('keeps the subtree reachable by the scope the board and menu use', function (): void {
    addCategory(['name' => 'Drinks'])->assertRedirect();
    addCategory(['name' => 'Wine'])->assertRedirect();
    addCategory(['name' => 'Red', 'parent_id' => categoryNamed('Wine')->getKey()])->assertRedirect();

    test()->patchJson(route('categories.update', categoryNamed('Wine')->getKey()), [
        'parent_id' => categoryNamed('Drinks')->getKey(),
    ])->assertRedirect();

    $reached = PosCategory::query()->subtreeOf(categoryNamed('Drinks'))->pluck('name')->all();

    expect($reached)->toContain('Drinks')->toContain('Wine')->toContain('Red');
});

it('does not sweep in a sibling whose name merely starts the same', function (): void {
    // Probed on master: with a *name* path and no terminator, the subtree of "Drink" returned
    // ["Drink", "Drinks special", "Beer"] — an unrelated sibling, because `/Drink` is a prefix of
    // `/Drinks special`. On the self-order menu that is a category the venue chose to hide showing
    // anyway. Ids cannot collide that way: `/1/` is not a prefix of `/11/`.
    addCategory(['name' => 'Drink'])->assertRedirect();
    addCategory(['name' => 'Drinks special'])->assertRedirect();
    addCategory(['name' => 'Beer', 'parent_id' => categoryNamed('Drink')->getKey()])->assertRedirect();

    $reached = PosCategory::query()->subtreeOf(categoryNamed('Drink'))->pluck('name')->all();

    expect($reached)->toContain('Drink')->toContain('Beer')
        ->and($reached)->not->toContain('Drinks special');
});

it('moves a category back to the root', function (): void {
    addCategory(['name' => 'Drinks'])->assertRedirect();
    addCategory(['name' => 'Wine', 'parent_id' => categoryNamed('Drinks')->getKey()])->assertRedirect();

    test()->patchJson(route('categories.update', categoryNamed('Wine')->getKey()), ['parent_id' => null])
        ->assertSessionHasNoErrors()->assertRedirect();

    $wineId = (int) categoryNamed('Wine')->getKey();

    expect(categoryNamed('Wine')->parent_id)->toBeNull()
        ->and(shapeOf('Wine'))->toBe(['path' => "/{$wineId}/", 'depth' => 0]);
});

it('keeps a pricelist category rule resolving after the category moves', function (): void {
    // The ticket's acceptance criterion. `PricingService::ancestryFor` walks `parent_id` upward, so
    // a rule attached to the *parent* has to keep applying to a product in the moved child.
    addCategory(['name' => 'Drinks'])->assertRedirect();
    addCategory(['name' => 'Wine'])->assertRedirect();

    $drinks = categoryNamed('Drinks');
    $wine = categoryNamed('Wine');

    test()->patchJson(route('categories.update', $wine->getKey()), ['parent_id' => $drinks->getKey()])
        ->assertRedirect();

    $ancestry = [];
    $cursor = (int) $wine->getKey();
    while ($cursor !== 0 && count($ancestry) < 10) {
        $ancestry[] = $cursor;
        $parent = DB::table('pos_categories')->where('id', $cursor)->value('parent_id');
        $cursor = $parent === null ? 0 : (int) $parent;
    }

    expect($ancestry)->toBe([(int) $wine->getKey(), (int) $drinks->getKey()]);
});

// ────────────────────────────────────────────────────────────── cycle guards

it('refuses to file a category under itself, and says so in those words', function (): void {
    // The refusal is not what this pins — the descendant check below already covers self-parenting,
    // since a node's own path starts with itself, and sabotaging the self-check alone left every
    // test green. What the branch actually contributes is the wording: "under itself" rather than
    // "under one of its own sub-categories", which otherwise sends an operator hunting for a
    // sub-category that is not the problem.
    addCategory(['name' => 'Drinks'])->assertRedirect();
    $drinks = categoryNamed('Drinks');

    $response = test()->patchJson(route('categories.update', $drinks->getKey()), [
        'parent_id' => $drinks->getKey(),
    ])->assertStatus(422);

    expect((string) json_encode($response->json('errors')))->toContain('under itself');
    expect(categoryNamed('Drinks')->parent_id)->toBeNull();
});

it('refuses to file a category under its own descendant', function (): void {
    // The ring this prevents has no root, so nothing reaches it: `ancestryFor` walks `parent_id`
    // under a 10-step guard and gives up, every pricelist category rule on the branch stops
    // applying, and the categories vanish from any screen rendering the tree from the roots down.
    addCategory(['name' => 'Drinks'])->assertRedirect();
    addCategory(['name' => 'Wine', 'parent_id' => categoryNamed('Drinks')->getKey()])->assertRedirect();
    addCategory(['name' => 'Red', 'parent_id' => categoryNamed('Wine')->getKey()])->assertRedirect();

    $drinks = categoryNamed('Drinks');

    test()->patchJson(route('categories.update', $drinks->getKey()), [
        'parent_id' => categoryNamed('Red')->getKey(),
    ])->assertStatus(422);

    expect(categoryNamed('Drinks')->parent_id)->toBeNull()
        ->and((int) categoryNamed('Red')->depth)->toBe(2);
});

it('never files a category under another company parent', function (): void {
    $other = PosFixtures::make();

    addCategory(['name' => 'Drinks'])->assertRedirect();

    test()->patchJson(route('categories.update', categoryNamed('Drinks')->getKey()), [
        'parent_id' => $other->category->getKey(),
    ])->assertStatus(422);

    expect(categoryNamed('Drinks')->parent_id)->toBeNull();
});

// ──────────────────────────────────────────────────────────── the delete guard

it('refuses to delete a category that has sub-categories', function (): void {
    // `parent_id` is `cascadeOnDelete`, so without the guard the whole branch goes silently.
    addCategory(['name' => 'Drinks'])->assertRedirect();
    addCategory(['name' => 'Wine', 'parent_id' => categoryNamed('Drinks')->getKey()])->assertRedirect();

    $response = test()->deleteJson(route('categories.destroy', categoryNamed('Drinks')->getKey()))
        ->assertStatus(422);

    expect((string) json_encode($response->json()))->toContain('sub-categor')
        ->and(PosCategory::query()->where('name', 'Wine')->exists())->toBeTrue();
});

it('refuses to delete a category that still holds products', function (): void {
    // `pos_category_product` cascades too: the products stay, but they drop off the menu with
    // nothing said. The fixture category is the one products are filed under.
    $response = test()->deleteJson(route('categories.destroy', $this->fx->category->getKey()))
        ->assertStatus(422);

    expect((string) json_encode($response->json()))->toContain('product(s)')
        ->and(PosCategory::query()->whereKey($this->fx->category->getKey())->exists())->toBeTrue();
});

it('names the kitchen routing a delete would silently unpick', function (): void {
    addCategory(['name' => 'Drinks'])->assertRedirect();
    $drinks = categoryNamed('Drinks');

    $printerId = DB::table('pos_printers')->insertGetId([
        'company_id' => $this->fx->company->getKey(),
        'name' => 'Bar printer',
        'printer_type' => 'network',
        'print_all_categories' => false,
        'active' => true,
        'created_at' => now(), 'updated_at' => now(),
    ]);

    DB::table('pos_category_pos_printer')->insert([
        'pos_printer_id' => $printerId,
        'pos_category_id' => $drinks->getKey(),
    ]);

    $response = test()->deleteJson(route('categories.destroy', $drinks->getKey()))->assertStatus(422);

    expect((string) json_encode($response->json()))->toContain('kitchen printer route')
        ->and(DB::table('pos_category_pos_printer')->where('pos_category_id', $drinks->getKey())->count())
        ->toBe(1);
});

it('deletes a category nothing points at', function (): void {
    addCategory(['name' => 'Drinks'])->assertRedirect();

    test()->deleteJson(route('categories.destroy', categoryNamed('Drinks')->getKey()))->assertRedirect();

    expect(PosCategory::query()->where('name', 'Drinks')->exists())->toBeFalse();
});

// ───────────────────────────────────────────────────────────────── permission

it('refuses a user who may not configure the register', function (): void {
    // The controller sat behind `auth` alone, so any signed-in account — a cashier, a runner — could
    // restructure the menu every till in the venue browses.
    addCategory(['name' => 'Drinks'])->assertRedirect();
    $drinks = categoryNamed('Drinks');

    test()->actingAs(treeActor($this->fx, ['catalog.view']));

    addCategory(['name' => 'Sneaky'])->assertForbidden();
    test()->patchJson(route('categories.update', $drinks->getKey()), ['name' => 'Renamed'])
        ->assertForbidden();
    test()->deleteJson(route('categories.destroy', $drinks->getKey()))->assertForbidden();

    expect(PosCategory::query()->where('name', 'Sneaky')->exists())->toBeFalse()
        ->and((string) categoryNamed('Drinks')->name)->toBe('Drinks');
});

it('refuses a nesting deeper than the pricing engine can walk', function (): void {
    // Not an arbitrary number. `PricingService::ancestryFor` walks `parent_id` upward under a
    // hard `$guard++ < 10`, so a category nested deeper than that has ancestors the pricing engine
    // never reaches — and a pricelist rule attached to one of those roots silently stops applying to
    // products in the deep branch. The tree refuses to build what the engine cannot read.
    $parentId = null;

    for ($depth = 0; $depth < 10; $depth++) {
        $response = addCategory(['name' => 'Level '.$depth, 'parent_id' => $parentId]);

        if ($depth < 10) {
            $response->assertSessionHasNoErrors()->assertRedirect();
            $parentId = categoryNamed('Level '.$depth)->getKey();
        }
    }

    // The deepest node the tree allows sits at a depth the 10-step walk still covers.
    expect((int) categoryNamed('Level 9')->depth)->toBe(9);

    addCategory(['name' => 'Too deep', 'parent_id' => $parentId])->assertStatus(422);

    expect(PosCategory::query()->where('name', 'Too deep')->exists())->toBeFalse();
});

it('keeps every stored path derivable from its parent', function (): void {
    // The invariant the three `LIKE` scopes depend on: a row's path is its parent's path plus its
    // own id, terminated. Asserted over the whole table after a move, because a path that is merely
    // *plausible* still resolves the wrong branch.
    addCategory(['name' => 'Drinks'])->assertRedirect();
    addCategory(['name' => 'Wine'])->assertRedirect();
    addCategory(['name' => 'Red', 'parent_id' => categoryNamed('Wine')->getKey()])->assertRedirect();

    test()->patchJson(route('categories.update', categoryNamed('Wine')->getKey()), [
        'parent_id' => categoryNamed('Drinks')->getKey(),
    ])->assertRedirect();

    $byId = PosCategory::query()->withoutGlobalScopes()->get()->keyBy('id');

    foreach ($byId as $category) {
        $parentPath = $category->parent_id === null
            ? '/'
            : (string) $byId[$category->parent_id]->path;

        expect((string) $category->path)->toBe($parentPath.$category->getKey().'/',
            'category '.$category->getKey().' ('.$category->name.') has a path its parent does not explain');
    }
});
