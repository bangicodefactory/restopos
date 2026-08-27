<?php

declare(strict_types=1);

namespace Tests\Feature\Backoffice\PolicyAbility;

use App\Models\Catalog\Product;
use App\Models\User;
use Database\Seeders\RoleSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * The abilities the policies ask for must be abilities something grants.
 *
 * `User::hasPermission` is an exact match against rows in `permissions`. A slug no seed creates is
 * therefore not a strict check — it is a permanent denial, invisible because super-admins short
 * -circuit the whole thing and every existing policy test fabricated the slug it needed with
 * `Permission::firstOrCreate` before acting.
 *
 * That is exactly what had happened: all sixteen policies asked for `config.manage`, `config.view`,
 * `pos.kitchen.*`, `pos.config.*`, `pos.order.*`, `pos.session.view`, `pos.accounting.export` or
 * `pos.manager`, and `RoleSeeder` seeds none of them. The seeded owner role holds all 34 real
 * permissions and still could not edit a product.
 */

/** Every slug any policy passes to `userCan`, read from source — no list to keep in step. */
function policyAbilities(): array
{
    $slugs = [];

    foreach (glob(app_path('Policies/*.php')) ?: [] as $file) {
        preg_match_all(
            "/userCan\(\\\$user,\s*'([^']+)'\)/",
            (string) file_get_contents($file),
            $matches,
        );

        foreach ($matches[1] as $slug) {
            $slugs[$slug][] = basename($file);
        }
    }

    return $slugs;
}

it('asks only for abilities the seeder actually grants', function (): void {
    $this->seed(RoleSeeder::class);

    $seeded = DB::table('permissions')->pluck('slug')->all();
    $asked = policyAbilities();

    expect($asked)->not->toBeEmpty('no policy ability was found — the regex has drifted');

    $unknown = [];

    foreach ($asked as $slug => $files) {
        if (! in_array($slug, $seeded, true)) {
            $unknown[] = $slug.' ('.implode(', ', array_unique($files)).')';
        }
    }

    expect($unknown)->toBe([], 'policies ask for abilities nothing grants: '.implode(' · ', $unknown));
});

/**
 * The above is a string check and would pass on a typo that happens to match an unused permission.
 * These two ride the real Gate, on the two surfaces the vocabulary drift actually broke.
 */
it('lets a seeded manager edit the catalogue', function (): void {
    $fx = PosFixtures::make();
    $this->seed(RoleSeeder::class);

    $user = User::factory()->create([
        'company_id' => $fx->company->getKey(),
        'is_super_admin' => false,
    ]);
    DB::table('role_user')->insert([
        'role_id' => DB::table('roles')->where('slug', 'manager')->value('id'),
        'user_id' => $user->getKey(),
    ]);

    expect($user->fresh()->can('update', $fx->product))->toBeTrue();
});

it('lets a seeded owner edit register settings, and a manager not', function (): void {
    // Register settings are owner-level: `manager` holds no `backoffice.manage_configs`. Asserting
    // both directions, so this passes for the right reason rather than because everything is allowed.
    $fx = PosFixtures::make();
    $this->seed(RoleSeeder::class);

    $make = function (string $role) use ($fx): User {
        $user = User::factory()->create([
            'company_id' => $fx->company->getKey(),
            'is_super_admin' => false,
        ]);
        DB::table('role_user')->insert([
            'role_id' => DB::table('roles')->where('slug', $role)->value('id'),
            'user_id' => $user->getKey(),
        ]);

        return $user->fresh();
    };

    expect($make('owner')->can('update', $fx->config))->toBeTrue()
        ->and($make('manager')->can('update', $fx->config))->toBeFalse();
});

it('denies a user with no role at all', function (): void {
    $fx = PosFixtures::make();
    $this->seed(RoleSeeder::class);

    $user = User::factory()->create([
        'company_id' => $fx->company->getKey(),
        'is_super_admin' => false,
    ]);

    expect($user->can('update', $fx->product))->toBeFalse()
        ->and($user->can('update', $fx->config))->toBeFalse();
});

it('does not let a role from one company reach another company', function (): void {
    // `sameCompany` is the other half. An owner is an owner *of somewhere*.
    $theirs = PosFixtures::make();
    $ours = PosFixtures::make();
    $this->seed(RoleSeeder::class);

    $user = User::factory()->create([
        'company_id' => $ours->company->getKey(),
        'is_super_admin' => false,
    ]);
    DB::table('role_user')->insert([
        'role_id' => DB::table('roles')->where('slug', 'owner')->value('id'),
        'user_id' => $user->getKey(),
    ]);

    expect($user->fresh()->can('update', $theirs->config))->toBeFalse();
});

it('keeps a super-admin able to reach both surfaces', function (): void {
    $fx = PosFixtures::make();
    $admin = User::factory()->create(['is_super_admin' => true]);

    expect($admin->can('update', $fx->product))->toBeTrue()
        ->and($admin->can('update', $fx->config))->toBeTrue();
});
