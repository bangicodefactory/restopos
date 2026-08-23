<?php

declare(strict_types=1);

namespace Tests\Feature\Backoffice\ProductCategoryAdmin;

use App\Models\Catalog\ProductCategory;
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
function ledgerActor(PosFixtures $fx, array $permissions): User
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
    $this->actingAs(ledgerActor($this->fx, ['config.view', 'config.manage']));
});

/** @param array<string, mixed> $payload */
function addProductCategory(array $payload = []): TestResponse
{
    return test()->postJson(route('product-categories.store'), ['name' => 'Food', ...$payload]);
}

function ledgerCategory(string $name): ProductCategory
{
    return ProductCategory::query()->where('name', $name)->firstOrFail();
}

/**
 * BAN-501 — the accounting category tree.
 *
 * `product_categories` had no surface at all: no controller, no page, no route. `ledger_code` — the
 * revenue account every sales row in the accounting export is labelled with (BAN-448) — was settable
 * by the seeder and by direct SQL and by nothing else, so a real venue shipped an export with a
 * blank label on every sales row. The column existed to be filled and nothing could fill it.
 */
it('creates a category with a revenue account', function (): void {
    addProductCategory(['ledger_code' => '7010'])->assertRedirect();

    expect((string) ledgerCategory('Food')->ledger_code)->toBe('7010');
});

it('leaves the account nullable, because an uncategorised product must still export', function (): void {
    addProductCategory()->assertRedirect();

    expect(ledgerCategory('Food')->ledger_code)->toBeNull();
});

it('refuses an account longer than the column holds', function (): void {
    addProductCategory(['ledger_code' => str_repeat('9', 33)])->assertStatus(422);
});

it('refuses two categories on one revenue account', function (): void {
    // The label column exists to say which category a sales row came from. Two categories sharing an
    // account make the export impossible to read back, which is a quieter failure than a blank one.
    addProductCategory(['ledger_code' => '7010'])->assertRedirect();

    $response = addProductCategory(['name' => 'Drink', 'ledger_code' => '7010'])->assertStatus(422);

    expect((string) json_encode($response->json('errors')))->toContain('Food');
});

it('lets a category keep its own account when saved again', function (): void {
    // The uniqueness check has to exclude the row being edited, or a category can never be saved
    // twice — the classic self-exclusion bug (review of #82).
    addProductCategory(['ledger_code' => '7010'])->assertRedirect();
    $category = ledgerCategory('Food');

    test()->patchJson(route('product-categories.update', $category->getKey()), [
        'name' => 'Food & drink',
        'ledger_code' => '7010',
    ])->assertRedirect();

    expect((string) ledgerCategory('Food & drink')->ledger_code)->toBe('7010');
});

// ─────────────────────────────────────────────────────────────── the tree

it('gives a new category an id path, terminated', function (): void {
    addProductCategory()->assertRedirect();
    $id = ledgerCategory('Food')->getKey();

    expect((string) ledgerCategory('Food')->path)->toBe("/{$id}/");
});

it('nests a child under its parent', function (): void {
    addProductCategory()->assertRedirect();
    addProductCategory(['name' => 'Starters', 'parent_id' => ledgerCategory('Food')->getKey()])
        ->assertRedirect();

    $parentId = ledgerCategory('Food')->getKey();
    $childId = ledgerCategory('Starters')->getKey();

    expect((string) ledgerCategory('Starters')->path)->toBe("/{$parentId}/{$childId}/");
});

it('rewrites the whole subtree on a re-parent', function (): void {
    // The reason `path` has to move with the node: `ProductCategory::scopeDescendantsOf` resolves a
    // branch with `LIKE path%`, so a stale descendant is reported under the branch it used to be in.
    addProductCategory(['name' => 'Food'])->assertRedirect();
    addProductCategory(['name' => 'Drink'])->assertRedirect();
    addProductCategory(['name' => 'Wine', 'parent_id' => ledgerCategory('Drink')->getKey()])->assertRedirect();
    addProductCategory(['name' => 'Red', 'parent_id' => ledgerCategory('Wine')->getKey()])->assertRedirect();

    $food = ledgerCategory('Food')->getKey();
    $wine = ledgerCategory('Wine')->getKey();
    $red = ledgerCategory('Red')->getKey();

    test()->patchJson(route('product-categories.update', $wine), ['parent_id' => $food])
        ->assertRedirect();

    expect((string) ledgerCategory('Wine')->path)->toBe("/{$food}/{$wine}/")
        ->and((string) ledgerCategory('Red')->path)->toBe("/{$food}/{$wine}/{$red}/");
});

it('keeps a renamed category where it is, because the path is ids', function (): void {
    // The point of an id path: a rename touches one row, not the branch.
    addProductCategory()->assertRedirect();
    addProductCategory(['name' => 'Starters', 'parent_id' => ledgerCategory('Food')->getKey()])->assertRedirect();

    $before = (string) ledgerCategory('Starters')->path;

    test()->patchJson(route('product-categories.update', ledgerCategory('Food')->getKey()), [
        'name' => 'Kitchen',
    ])->assertRedirect();

    expect((string) ledgerCategory('Starters')->path)->toBe($before);
});

it('does not sweep a same-prefix sibling into the subtree', function (): void {
    // `/1` prefixes `/11`, which is why the path is terminated. `ProductCategory::scopeDescendantsOf`
    // has the same `LIKE path%` shape the POS tree had when it swept an unrelated sibling in.
    addProductCategory(['name' => 'Drink'])->assertRedirect();
    addProductCategory(['name' => 'Drinks special'])->assertRedirect();
    addProductCategory(['name' => 'Beer', 'parent_id' => ledgerCategory('Drink')->getKey()])->assertRedirect();

    $reached = ProductCategory::query()->descendantsOf(ledgerCategory('Drink'))->pluck('name')->all();

    expect($reached)->toContain('Beer')->and($reached)->not->toContain('Drinks special');
});

it('refuses to file a category under its own descendant', function (): void {
    addProductCategory(['name' => 'Drink'])->assertRedirect();
    addProductCategory(['name' => 'Wine', 'parent_id' => ledgerCategory('Drink')->getKey()])->assertRedirect();

    test()->patchJson(route('product-categories.update', ledgerCategory('Drink')->getKey()), [
        'parent_id' => ledgerCategory('Wine')->getKey(),
    ])->assertStatus(422);

    expect(ledgerCategory('Drink')->parent_id)->toBeNull();
});

it('never files a category under another company parent', function (): void {
    $other = PosFixtures::make();
    $foreign = ProductCategory::query()->create([
        'company_id' => $other->company->getKey(),
        'name' => 'Theirs',
        'path' => '/',
        'sequence' => 10,
    ]);

    addProductCategory(['parent_id' => $foreign->getKey()])->assertStatus(422);

    expect(ProductCategory::query()->where('name', 'Food')->exists())->toBeFalse();
});

// ──────────────────────────────────────────────────────────── the delete guard

it('refuses to delete a category that still holds products', function (): void {
    // `products.product_category_id` is `nullOnDelete`, so the delete would succeed and the products
    // would survive with a blank revenue account. Nothing fails today; the damage appears in the next
    // export as sales rows with no label — the exact condition BAN-448 was written to end.
    addProductCategory(['ledger_code' => '7010'])->assertRedirect();
    $category = ledgerCategory('Food');

    DB::table('products')->where('id', $this->fx->product->getKey())
        ->update(['product_category_id' => $category->getKey()]);

    $response = test()->deleteJson(route('product-categories.destroy', $category->getKey()))
        ->assertStatus(422);

    expect((string) json_encode($response->json('errors')))->toContain('blank label')
        ->and(ProductCategory::query()->whereKey($category->getKey())->exists())->toBeTrue()
        ->and((int) DB::table('products')->where('id', $this->fx->product->getKey())->value('product_category_id'))
        ->toBe((int) $category->getKey());
});

it('refuses to delete a category that has sub-categories', function (): void {
    addProductCategory()->assertRedirect();
    addProductCategory(['name' => 'Starters', 'parent_id' => ledgerCategory('Food')->getKey()])->assertRedirect();

    test()->deleteJson(route('product-categories.destroy', ledgerCategory('Food')->getKey()))
        ->assertStatus(422);

    expect(ProductCategory::query()->where('name', 'Starters')->exists())->toBeTrue();
});

it('deletes a category nothing points at', function (): void {
    addProductCategory()->assertRedirect();

    test()->deleteJson(route('product-categories.destroy', ledgerCategory('Food')->getKey()))
        ->assertRedirect();

    expect(ProductCategory::query()->where('name', 'Food')->exists())->toBeFalse();
});

// ────────────────────────────────────────────────────────────────── permission

it('refuses a user who may not configure the register', function (): void {
    addProductCategory()->assertRedirect();
    $category = ledgerCategory('Food');

    test()->actingAs(ledgerActor($this->fx, ['config.view']));

    addProductCategory(['name' => 'Sneaky'])->assertForbidden();
    test()->patchJson(route('product-categories.update', $category->getKey()), ['ledger_code' => '9999'])
        ->assertForbidden();
    test()->deleteJson(route('product-categories.destroy', $category->getKey()))->assertForbidden();

    expect(ProductCategory::query()->where('name', 'Sneaky')->exists())->toBeFalse()
        ->and(ledgerCategory('Food')->ledger_code)->toBeNull();
});

it('never touches another company category', function (): void {
    $other = PosFixtures::make();
    $foreign = ProductCategory::query()->create([
        'company_id' => $other->company->getKey(),
        'name' => 'Theirs',
        'path' => '/',
        'sequence' => 10,
    ]);

    test()->patchJson(route('product-categories.update', $foreign->getKey()), ['name' => 'Mine now'])
        ->assertNotFound();
    test()->deleteJson(route('product-categories.destroy', $foreign->getKey()))->assertNotFound();

    expect((string) ProductCategory::query()->withoutGlobalScopes()->whereKey($foreign->getKey())->value('name'))
        ->toBe('Theirs');
});
