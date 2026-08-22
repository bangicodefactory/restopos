<?php

declare(strict_types=1);

namespace Tests\Feature\Backoffice\TaxCrud;

use App\Models\Identity\Permission;
use App\Models\Identity\Role;
use App\Models\Pricing\Tax;
use App\Models\Pricing\TaxGroup;
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
function taxActor(PosFixtures $fx, array $permissions): User
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
    $this->group = TaxGroup::query()->where('company_id', $this->fx->company->getKey())->firstOrFail();
    $this->actingAs(taxActor($this->fx, ['config.view', 'config.manage']));
});

/** @param array<string, mixed> $payload */
function addTax(int $groupId, array $payload = []): TestResponse
{
    return test()->post(route('taxes.store'), [
        'name' => 'Reduced 10%',
        'amount_type' => 'percent',
        'amount' => '10.0000',
        'tax_group_id' => $groupId,
        ...$payload,
    ]);
}

/**
 * BOF-091 (BAN-396) — creating and removing a tax, and the fields that decide what one computes.
 *
 * The editor could change a tax's name, its rate and its two compounding switches. It could **not**
 * change `amount_type`, `tax_group_id`, `has_negative_factor` or `rounding_strategy` — between them,
 * whether the tax is a percentage or a fixed sum, which heading it totals under on a receipt,
 * whether it subtracts rather than adds, and how it rounds. The only fields a seeded tax could not
 * change were the ones that decide what it does.
 */
it('adds a tax', function (): void {
    addTax((int) $this->group->getKey())->assertRedirect();

    expect(Tax::query()->where('name', 'Reduced 10%')->exists())->toBeTrue();
});

it('files it against the acting company', function (): void {
    addTax((int) $this->group->getKey())->assertRedirect();

    expect((int) Tax::query()->where('name', 'Reduced 10%')->value('company_id'))
        ->toBe((int) $this->fx->company->getKey());
});

it('sets whether the tax is a rate or a fixed sum', function (): void {
    // The engine computes a different thing for each. This was unreachable before.
    addTax((int) $this->group->getKey(), ['name' => 'Eco levy', 'amount_type' => 'fixed', 'amount' => '0.2000'])
        ->assertRedirect();

    expect(Tax::query()->where('name', 'Eco levy')->value('amount_type')->value)->toBe('fixed');
});

it('changes an existing tax from a rate to a fixed sum', function (): void {
    addTax((int) $this->group->getKey())->assertRedirect();
    $tax = Tax::query()->where('name', 'Reduced 10%')->firstOrFail();

    test()->patch(route('taxes.update', $tax->getKey()), ['amount_type' => 'fixed'])->assertRedirect();

    expect(Tax::query()->whereKey($tax->getKey())->value('amount_type')->value)->toBe('fixed');
});

it('refuses a kind the engine cannot compute', function (): void {
    addTax((int) $this->group->getKey(), ['amount_type' => 'vibes'])->assertSessionHasErrors('amount_type');
});

it('sets the rounding strategy, which decides where the pennies land', function (): void {
    addTax((int) $this->group->getKey(), ['rounding_strategy' => 'round_globally'])->assertRedirect();

    expect(Tax::query()->where('name', 'Reduced 10%')->value('rounding_strategy')->value)
        ->toBe('round_globally');
});

it('sets a tax that subtracts rather than adds', function (): void {
    addTax((int) $this->group->getKey(), ['has_negative_factor' => true])->assertRedirect();

    expect((bool) Tax::query()->where('name', 'Reduced 10%')->value('has_negative_factor'))->toBeTrue();
});

it('refuses another company tax group, which is what a receipt totals under', function (): void {
    $other = PosFixtures::make();
    $theirs = TaxGroup::query()->withoutGlobalScopes()
        ->where('company_id', $other->company->getKey())->firstOrFail();

    addTax((int) $theirs->getKey())->assertSessionHasErrors('tax_group_id');

    expect(Tax::query()->where('name', 'Reduced 10%')->exists())->toBeFalse();
});

it('removes a tax nothing points at', function (): void {
    addTax((int) $this->group->getKey())->assertRedirect();
    $tax = Tax::query()->where('name', 'Reduced 10%')->firstOrFail();

    test()->deleteJson(route('taxes.destroy', $tax->getKey()))->assertRedirect();

    expect(Tax::query()->whereKey($tax->getKey())->exists())->toBeFalse();
});

it('refuses to remove a tax still applied to a product', function (): void {
    // `product_tax.tax_id` is `restrictOnDelete`, so without the guard the database refuses too —
    // as a SQLSTATE 23000 reaching the manager as a 500 with no clue which product is in the way.
    addTax((int) $this->group->getKey())->assertRedirect();
    $tax = Tax::query()->where('name', 'Reduced 10%')->firstOrFail();

    DB::table('product_tax')->insert([
        'product_id' => $this->fx->product->getKey(),
        'tax_id' => $tax->getKey(),
    ]);

    test()->deleteJson(route('taxes.destroy', $tax->getKey()))->assertStatus(422);

    expect(Tax::query()->whereKey($tax->getKey())->exists())->toBeTrue();
});

it('refuses to remove a tax still applied to a variant', function (): void {
    // A separate pivot from the product one, and separately restricting.
    addTax((int) $this->group->getKey())->assertRedirect();
    $tax = Tax::query()->where('name', 'Reduced 10%')->firstOrFail();

    DB::table('product_variant_tax')->insert([
        'product_variant_id' => $this->fx->variant->getKey(),
        'tax_id' => $tax->getKey(),
    ]);

    test()->deleteJson(route('taxes.destroy', $tax->getKey()))->assertStatus(422);

    expect(Tax::query()->whereKey($tax->getKey())->exists())->toBeTrue();
});

it('never removes a tax that appears on a closed session report', function (): void {
    // The one that cannot be resolved by unlinking anything: a Z-report's frozen tax figures. Delete
    // the tax and the report loses the row explaining its own total.
    $fx = $this->fx->withSession();
    addTax((int) $this->group->getKey())->assertRedirect();
    $tax = Tax::query()->where('name', 'Reduced 10%')->firstOrFail();

    DB::table('session_tax_summaries')->insert([
        'pos_session_id' => $fx->session->getKey(),
        'tax_id' => $tax->getKey(),
        'tax_group_id' => $this->group->getKey(),
        'is_refund' => false,
        'base_amount' => '100.0000',
        'tax_amount' => '10.0000',
        'tax_rate' => '10.0000',
        'created_at' => now(),
        'updated_at' => now(),
    ]);

    $response = test()->deleteJson(route('taxes.destroy', $tax->getKey()))->assertStatus(422);

    // And it says what to do instead, because there is no way to make this delete succeed.
    expect((string) json_encode($response->json()))->toContain('Deactivate');
    expect(Tax::query()->whereKey($tax->getKey())->exists())->toBeTrue();
});

it('lets a tax be deactivated instead, which is what removing one usually means', function (): void {
    addTax((int) $this->group->getKey())->assertRedirect();
    $tax = Tax::query()->where('name', 'Reduced 10%')->firstOrFail();

    test()->patch(route('taxes.update', $tax->getKey()), ['active' => false])->assertRedirect();

    expect((bool) Tax::query()->whereKey($tax->getKey())->value('active'))->toBeFalse();
});

it('never touches another company tax', function (): void {
    $other = PosFixtures::make();

    test()->deleteJson(route('taxes.destroy', $other->tax->getKey()))->assertNotFound();

    expect(Tax::query()->withoutGlobalScopes()->whereKey($other->tax->getKey())->exists())->toBeTrue();
});

it('refuses a user who may not configure the register', function (): void {
    addTax((int) $this->group->getKey())->assertRedirect();
    $tax = Tax::query()->where('name', 'Reduced 10%')->firstOrFail();

    test()->actingAs(taxActor($this->fx, ['config.view']));

    addTax((int) $this->group->getKey(), ['name' => 'Sneaky'])->assertForbidden();
    test()->deleteJson(route('taxes.destroy', $tax->getKey()))->assertForbidden();

    expect(Tax::query()->where('name', 'Sneaky')->exists())->toBeFalse()
        ->and(Tax::query()->whereKey($tax->getKey())->exists())->toBeTrue();
});

it('refuses to remove a tax a fiscal position maps to or from', function (): void {
    // The database does **not** stop this one: `fiscal_position_taxes` cascades. Probed before the
    // guard — the mapping went from one row to none and the delete reported success, so an
    // "Export 0 %" position quietly stopped remapping and the next exempt customer paid full VAT
    // on a sale that balanced perfectly (review of #81).
    addTax((int) $this->group->getKey(), ['name' => 'Export 0%', 'amount' => '0'])->assertRedirect();
    $exempt = Tax::query()->where('name', 'Export 0%')->firstOrFail();

    $position = DB::table('fiscal_positions')->insertGetId([
        'company_id' => $this->fx->company->getKey(),
        'name' => 'Export',
        'auto_apply' => false, 'vat_required' => false, 'sequence' => 10, 'active' => true,
        'created_at' => now(), 'updated_at' => now(),
    ]);

    DB::table('fiscal_position_taxes')->insert([
        'fiscal_position_id' => $position,
        'tax_src_id' => $this->fx->tax->getKey(),
        'tax_dest_id' => $exempt->getKey(),
        'created_at' => now(), 'updated_at' => now(),
    ]);

    test()->deleteJson(route('taxes.destroy', $exempt->getKey()))->assertStatus(422);

    expect(Tax::query()->whereKey($exempt->getKey())->exists())->toBeTrue()
        ->and(DB::table('fiscal_position_taxes')->count())->toBe(1);
});

it('refuses to remove a tax that is part of a compound one', function (): void {
    // `tax_children` cascades too: the parent would keep computing, quietly short by whatever the
    // removed component contributed.
    addTax((int) $this->group->getKey(), ['name' => 'City surcharge'])->assertRedirect();
    $child = Tax::query()->where('name', 'City surcharge')->firstOrFail();

    DB::table('tax_children')->insert([
        'parent_tax_id' => $this->fx->tax->getKey(),
        'child_tax_id' => $child->getKey(),
        'sequence' => 10,
    ]);

    test()->deleteJson(route('taxes.destroy', $child->getKey()))->assertStatus(422);

    expect(Tax::query()->whereKey($child->getKey())->exists())->toBeTrue()
        ->and(DB::table('tax_children')->count())->toBe(1);
});

// ────────────────────────────────────────── the arithmetic freeze while a tab is open

/**
 * Ring one line of the fixture product, which carries the fixture tax, onto an open order.
 *
 * Through the register's own door so the line is computed by the engine rather than inserted, since
 * what is under test is exactly what the engine does with the tax table.
 */
function openTabCarrying(PosFixtures $fx): string
{
    $uuid = (string) Str::uuid();

    test()->withHeaders($fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$fx->orderCommand($uuid, [[
            'op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $fx->variant->getKey(),
            'qty' => '1', 'price_unit' => '10.00', 'discount' => '0',
        ]])],
    ])->assertOk()->assertJsonPath('results.0.status', 'ok');

    expect((string) DB::table('pos_orders')->where('uuid', $uuid)->value('state'))
        ->toBe('draft', 'the tab must actually be open for this guard to be under test');

    return $uuid;
}

it('freezes the rate while a tab already carries the tax', function (): void {
    // BOF-091. The engine reads `taxes` live on every sync — probed: set a rate to 40% before a line
    // is rung up and the line computes 4.00, with no re-bootstrap needed. But a line is never
    // recomputed once rung. So changing the rate at 8pm leaves the starters on that tab at 21% and
    // the mains at the new figure: one bill, one tax, two rates, and nothing on the receipt saying
    // so.
    $fx = $this->fx->withSession();
    openTabCarrying($fx);

    test()->patchJson(route('taxes.update', $fx->tax->getKey()), ['amount' => '40.0000'])
        ->assertStatus(422);

    expect((string) Tax::query()->whereKey($fx->tax->getKey())->value('amount'))->toStartWith('21');
});

it('freezes the kind, the compounding and the evaluation order too', function (): void {
    // Every field that changes what the tax *computes*, not just the rate. `sequence` is in the list
    // because for a compound chain it is the evaluation order.
    $fx = $this->fx->withSession();
    openTabCarrying($fx);

    foreach (['amount_type' => 'fixed', 'price_include' => true, 'include_base_amount' => true,
        'is_base_affected' => true, 'has_negative_factor' => true,
        'rounding_strategy' => 'round_globally', 'sequence' => 99] as $field => $value) {
        test()->patchJson(route('taxes.update', $fx->tax->getKey()), [$field => $value])
            ->assertStatus(422, $field.' should be frozen while a tab carries the tax');
    }

    $after = Tax::query()->whereKey($fx->tax->getKey())->firstOrFail();

    expect($after->amount_type->value)->toBe('percent')
        ->and((bool) $after->price_include)->toBeFalse()
        ->and((int) $after->sequence)->not->toBe(99);
});

it('still lets the name, the receipt group and the active flag change', function (): void {
    // The control, and the reason the freeze is a list rather than a blanket. These change what is
    // printed or offered, never what an already-rung line computed — and a manager fixing a typo
    // mid-service should not have to close every table first.
    $fx = $this->fx->withSession();
    openTabCarrying($fx);

    $second = TaxGroup::query()->create([
        'company_id' => $fx->company->getKey(),
        'name' => 'Second group',
        'sequence' => 50,
    ]);

    test()->patchJson(route('taxes.update', $fx->tax->getKey()), [
        'name' => 'VAT (standard)',
        'tax_group_id' => $second->getKey(),
        'active' => false,
    ])->assertRedirect();

    $after = Tax::query()->whereKey($fx->tax->getKey())->firstOrFail();

    expect((string) $after->name)->toBe('VAT (standard)')
        ->and((int) $after->tax_group_id)->toBe((int) $second->getKey());
});

it('lets the rate change once the tab is paid', function (): void {
    // The control on the freeze: it is the *open* order that holds the rate, not the history. A paid
    // line's figures are already final.
    $fx = $this->fx->withSession();
    $uuid = openTabCarrying($fx);

    DB::table('pos_orders')->where('uuid', $uuid)->update(['state' => 'paid']);

    test()->patchJson(route('taxes.update', $fx->tax->getKey()), ['amount' => '12.0000'])
        ->assertRedirect();

    expect((string) Tax::query()->whereKey($fx->tax->getKey())->value('amount'))->toStartWith('12');
});

it('does not freeze a tax the open tab does not carry', function (): void {
    // The other control. One open table must not lock every tax in the venue — only the ones its
    // lines were actually computed with.
    $fx = $this->fx->withSession();
    openTabCarrying($fx);

    addTax((int) $this->group->getKey(), ['name' => 'Untouched levy'])->assertRedirect();
    $other = Tax::query()->where('name', 'Untouched levy')->firstOrFail();

    test()->patchJson(route('taxes.update', $other->getKey()), ['amount' => '5.0000'])->assertRedirect();

    expect((string) Tax::query()->whereKey($other->getKey())->value('amount'))->toStartWith('5');
});

it('refuses to delete a tax an open tab carries', function (): void {
    // Reached before the product/report checks, because it is the one an operator can act on now:
    // the others say "detach it from a product", this says "close the table first".
    $fx = $this->fx->withSession();
    openTabCarrying($fx);

    $response = test()->deleteJson(route('taxes.destroy', $fx->tax->getKey()))->assertStatus(422);

    expect((string) json_encode($response->json()))->toContain('open order')
        ->and(Tax::query()->whereKey($fx->tax->getKey())->exists())->toBeTrue();
});

it('matches the tax by id and not by substring, so tax 1 is not frozen by tax 21', function (): void {
    // `tax_signature` is the sorted, dash-joined list of applied tax ids ('1', '1-21', 'none'), so
    // a `LIKE '%1%'` or a `str_contains` would report tax 1 as carried by any tab holding tax 21 —
    // and freeze the venue's standard VAT because somebody rang up an eco levy. Caught by sabotage:
    // swapping the explode for `str_contains` passed every other test in this file, because the
    // fixture never has two ids where one is a substring of the other.
    $fx = $this->fx->withSession();
    $short = (int) $fx->tax->getKey();

    // Mint taxes until one exists whose id *contains* the fixture tax's id as a substring.
    $long = null;
    for ($i = 0; $i < 40 && $long === null; $i++) {
        $candidate = Tax::query()->create([
            'company_id' => $fx->company->getKey(),
            'tax_group_id' => $this->group->getKey(),
            'name' => 'Filler '.$i,
            'amount_type' => 'percent',
            'amount' => '1.0000',
            'sequence' => 500 + $i,
        ]);

        if (str_contains((string) $candidate->getKey(), (string) $short)
            && (int) $candidate->getKey() !== $short) {
            $long = (int) $candidate->getKey();
        }
    }

    expect($long)->not->toBeNull('the collision this test is about must actually be constructible');

    // Put the long-id tax — and only it — on the product the tab will carry.
    DB::table('product_tax')->where('product_id', $fx->product->getKey())->delete();
    DB::table('product_variant_tax')->where('product_variant_id', $fx->variant->getKey())->delete();
    DB::table('product_tax')->insert(['product_id' => $fx->product->getKey(), 'tax_id' => $long]);

    $uuid = openTabCarrying($fx);
    $signature = (string) DB::table('pos_order_lines')
        ->join('pos_orders', 'pos_orders.id', '=', 'pos_order_lines.pos_order_id')
        ->where('pos_orders.uuid', $uuid)->value('pos_order_lines.tax_signature');

    expect($signature)->toBe((string) $long, 'the tab must carry only the long-id tax');

    // The long-id tax is frozen...
    test()->patchJson(route('taxes.update', $long), ['amount' => '9.0000'])->assertStatus(422);

    // ...and the short-id one, which nothing on that tab carries, is not.
    test()->patchJson(route('taxes.update', $short), ['amount' => '9.0000'])->assertRedirect();

    expect((string) Tax::query()->whereKey($short)->value('amount'))->toStartWith('9');
});
