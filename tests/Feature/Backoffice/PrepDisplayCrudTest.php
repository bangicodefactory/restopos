<?php

declare(strict_types=1);

namespace Tests\Feature\Backoffice\PrepDisplayCrud;

use App\Models\Identity\Permission;
use App\Models\Identity\Role;
use App\Models\Kitchen\PrepDisplay;
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
function displayActor(PosFixtures $fx, array $permissions): User
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

    $user = User::factory()->create(['company_id' => $fx->company->getKey(), 'is_super_admin' => false]);
    DB::table('role_user')->insert(['role_id' => $role->getKey(), 'user_id' => $user->getKey()]);

    return $user;
}

beforeEach(function (): void {
    // A decoy venue first, so the acting company is not id 1.
    PosFixtures::make();

    $this->fx = PosFixtures::make()->withSession()->withPrepDisplay();
    $this->actingAs(displayActor($this->fx, ['pos.kitchen.view', 'pos.kitchen.manage']));
});

/** @param array<string, mixed> $payload */
function addDisplay(array $payload = []): TestResponse
{
    return test()->post(route('prep-displays.store'), ['name' => 'Cold larder', ...$payload]);
}

function stagesOn(int $displayId): array
{
    return DB::table('prep_stages')
        ->where('prep_display_id', $displayId)
        ->orderBy('sequence')
        ->pluck('stage_type')
        ->all();
}

/**
 * A ticket on the board, in whichever state.
 *
 * `prep_orders` has no `company_id`: it is owned through `prep_display_id` and `pos_config_id`, both
 * of which it requires. Worth knowing — a scope written against a column this table does not have is
 * a 500 rather than a stricter query.
 */
function ticketOn(PosFixtures $fx, PrepDisplay $display, string $state): void
{
    $orderUuid = (string) Str::uuid();

    test()->withHeaders($fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$fx->orderCommand($orderUuid, [[
            'op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $fx->variant->getKey(),
            'qty' => '1', 'price_unit' => '10.00', 'discount' => '0',
        ]])],
    ])->assertOk();

    DB::table('prep_orders')->insert([
        'uuid' => (string) Str::uuid(),
        'prep_display_id' => $display->getKey(),
        'pos_order_id' => DB::table('pos_orders')->where('uuid', $orderUuid)->value('id'),
        'pos_config_id' => $fx->config->getKey(),
        'state' => $state,
        'fired_at' => now(),
        'created_at' => now(),
        'updated_at' => now(),
    ]);
}

/**
 * BOF-115 (BAN-435) — adding and removing a kitchen screen.
 *
 * The ticket's other half — persisting stage edits — was already done: `syncStages` reconciles the
 * submitted list, preserves stage ids so a rename does not orphan in-flight tickets, and reassigns
 * `sequence` around the unique index. Verified before building; not rebuilt here.
 */
it('adds a display', function (): void {
    addDisplay()->assertRedirect();

    expect(PrepDisplay::query()->where('name', 'Cold larder')->exists())->toBeTrue();
});

it('files it against the acting company', function (): void {
    addDisplay()->assertRedirect();

    expect((int) PrepDisplay::query()->where('name', 'Cold larder')->value('company_id'))
        ->toBe((int) $this->fx->company->getKey());
});

it('mints the board its own access token rather than taking one', function (): void {
    // The token is the broadcast channel and the screen URL. Server-minted, like the table QR token:
    // a client-chosen one is a channel somebody else can guess.
    addDisplay(['access_token' => 'chosen-by-me'])->assertRedirect();

    $token = (string) PrepDisplay::query()->where('name', 'Cold larder')->value('access_token');

    expect($token)->not->toBe('chosen-by-me')
        ->and(strlen($token))->toBe(32);
});

it('starts a new board with a usable stage set', function (): void {
    // The stage list *is* the state machine (KDS-008). A board with none shows tickets nobody can
    // advance — a screen the kitchen can read and not use, which reads as broken rather than
    // unfinished.
    addDisplay()->assertRedirect();
    $display = PrepDisplay::query()->where('name', 'Cold larder')->firstOrFail();

    expect(stagesOn((int) $display->getKey()))->toBe(['todo', 'in_progress', 'ready']);
});

it('refuses a layout the board cannot render', function (): void {
    addDisplay(['layout' => 'hologram'])->assertSessionHasErrors('layout');
});

it('removes an empty board', function (): void {
    addDisplay()->assertRedirect();
    $display = PrepDisplay::query()->where('name', 'Cold larder')->firstOrFail();

    test()->deleteJson(route('prep-displays.destroy', $display->uuid))->assertRedirect();

    expect(PrepDisplay::query()->whereKey($display->getKey())->exists())->toBeFalse();
});

it('refuses to remove a board that still has work on it', function (): void {
    // `prep_orders.prep_display_id` cascades, so deleting the display takes every ticket with it —
    // while the order those tickets came from still says the kitchen was told. Food somebody is
    // cooking stops existing on the only screen that shows it.
    addDisplay()->assertRedirect();
    $display = PrepDisplay::query()->where('name', 'Cold larder')->firstOrFail();
    ticketOn($this->fx, $display, 'in_progress');

    test()->deleteJson(route('prep-displays.destroy', $display->uuid))->assertStatus(422);

    expect(PrepDisplay::query()->whereKey($display->getKey())->exists())->toBeTrue();
});

/**
 * One state per case, deliberately.
 *
 * A single test creating a pending **and** a ready ticket cannot tell which one blocked the delete:
 * dropping `ready` from the guard passed, because `pending` was still there to catch it (review of
 * #80). Each state has to stand on its own.
 */
it('counts a ticket nobody has started as work', function (): void {
    addDisplay()->assertRedirect();
    $display = PrepDisplay::query()->where('name', 'Cold larder')->firstOrFail();

    ticketOn($this->fx, $display, 'pending');

    test()->deleteJson(route('prep-displays.destroy', $display->uuid))->assertStatus(422);

    expect(PrepDisplay::query()->whereKey($display->getKey())->exists())->toBeTrue();
});

it('counts a ticket that is cooked but not collected as work', function (): void {
    // `ready` is food sitting on the pass. The board is the only thing telling anyone it is there.
    addDisplay()->assertRedirect();
    $display = PrepDisplay::query()->where('name', 'Cold larder')->firstOrFail();

    ticketOn($this->fx, $display, 'ready');

    test()->deleteJson(route('prep-displays.destroy', $display->uuid))->assertStatus(422);

    expect(PrepDisplay::query()->whereKey($display->getKey())->exists())->toBeTrue();
});

it('lets a board go once its tickets are history', function (): void {
    // Served and cancelled tickets are on the board only because `done_retention_minutes` has not
    // expired. They are not work.
    addDisplay()->assertRedirect();
    $display = PrepDisplay::query()->where('name', 'Cold larder')->firstOrFail();

    foreach (['served', 'cancelled'] as $state) {
        ticketOn($this->fx, $display, $state);
    }

    test()->deleteJson(route('prep-displays.destroy', $display->uuid))->assertRedirect();

    expect(PrepDisplay::query()->whereKey($display->getKey())->exists())->toBeFalse();
});

it('takes its stages with it', function (): void {
    addDisplay()->assertRedirect();
    $display = PrepDisplay::query()->where('name', 'Cold larder')->firstOrFail();
    $displayId = (int) $display->getKey();

    test()->deleteJson(route('prep-displays.destroy', $display->uuid))->assertRedirect();

    expect(stagesOn($displayId))->toBe([]);
});

it('never touches another company board', function (): void {
    $other = PosFixtures::make()->withPrepDisplay();

    test()->deleteJson(route('prep-displays.destroy', $other->display->uuid))->assertNotFound();

    expect(PrepDisplay::query()->withoutGlobalScopes()->whereKey($other->display->getKey())->exists())
        ->toBeTrue();
});

it('refuses a user who may not configure the kitchen', function (): void {
    addDisplay()->assertRedirect();
    $display = PrepDisplay::query()->where('name', 'Cold larder')->firstOrFail();

    test()->actingAs(displayActor($this->fx, ['pos.kitchen.view']));

    addDisplay(['name' => 'Sneaky'])->assertForbidden();
    test()->deleteJson(route('prep-displays.destroy', $display->uuid))->assertForbidden();

    expect(PrepDisplay::query()->where('name', 'Sneaky')->exists())->toBeFalse()
        ->and(PrepDisplay::query()->whereKey($display->getKey())->exists())->toBeTrue();
});

it('starts linked to no register, so a new board receives nothing until it is', function (): void {
    // `fanOutToDisplays` joins `pos_config_prep_display`: a board with no row there is sent nothing.
    //
    // That is the right default and worth pinning, because the tempting "fix" is to link a new board
    // to every register — which would send every ticket in the venue to a cold-larder screen that
    // was meant to receive salads. The link is a decision, and it is made on the *register's*
    // settings page (review of #80).
    addDisplay()->assertRedirect();
    $display = PrepDisplay::query()->where('name', 'Cold larder')->firstOrFail();

    expect(DB::table('pos_config_prep_display')->where('prep_display_id', $display->getKey())->count())
        ->toBe(0);
});

it('receives tickets once a register is linked to it', function (): void {
    // The other half of the same rule: the link is all that is missing, not anything about the board.
    addDisplay()->assertRedirect();
    $display = PrepDisplay::query()->where('name', 'Cold larder')->firstOrFail();

    $this->fx->config->prepDisplays()->syncWithoutDetaching([$display->getKey()]);

    expect(DB::table('pos_config_prep_display')->where('prep_display_id', $display->getKey())->count())
        ->toBe(1);
});
