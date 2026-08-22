<?php

declare(strict_types=1);

namespace Tests\Feature\Backoffice\PrepDisplayStage;

use App\Models\Catalog\PosCategory;
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
function stageActor(PosFixtures $fx, array $permissions): User
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
    $this->actingAs(stageActor($this->fx, ['pos.kitchen.view', 'pos.kitchen.manage']));
});

/**
 * The stored stages of a display, in board order.
 *
 * @return list<array<string, mixed>>
 */
function board(PrepDisplay $display): array
{
    return DB::table('prep_stages')
        ->where('prep_display_id', $display->getKey())
        ->orderBy('sequence')
        ->get(['id', 'name', 'stage_type', 'color', 'alert_after_minutes', 'sequence', 'is_default'])
        ->map(static fn ($r): array => (array) $r)
        ->all();
}

/**
 * The stage rows in the shape the editor round-trips them.
 *
 * @return list<array<string, mixed>>
 */
function editable(PrepDisplay $display): array
{
    return array_map(static fn (array $row): array => [
        'id' => (int) $row['id'],
        'name' => (string) $row['name'],
        'stage_type' => (string) $row['stage_type'],
        'color' => $row['color'],
        'alert_after_minutes' => $row['alert_after_minutes'],
        'is_default' => (bool) $row['is_default'],
    ], board($display));
}

/**
 * The stage list as the editor submits it: whole, ordered, ids preserved for existing rows.
 *
 * `patchJson`, not `patch`, and deliberately so. `PosFixtures::headers()` carries
 * `Accept: application/json`, and `withHeaders()` persists onto the test client — so any test that
 * fires a ticket first silently puts every later request into JSON mode, and a refusal arrives as a
 * 422 body instead of a redirect carrying session errors. Half these tests fire a ticket and half do
 * not; asking for JSON everywhere is what makes the refusal shape the same in both.
 *
 * @param  list<array<string, mixed>>  $stages
 */
function submitBoard(PrepDisplay $display, array $stages): TestResponse
{
    return test()->patchJson(route('prep-displays.update', $display->uuid), ['stages' => $stages]);
}

/** A refusal from the stage editor, named by its message rather than merely counted. */
function assertStageRefusal(TestResponse $response, string $fragment): void
{
    $response->assertStatus(422);

    expect((string) json_encode($response->json('errors.stages')))->toContain($fragment);
}

/**
 * Fire a real ticket at the board and return its line id.
 *
 * Through the register's own door (`POST /api/pos/orders/{order}/preparation`) rather than an
 * insert, because the landing stage is chosen there: `PreparationService` resolves it by
 * `stage_type = todo`, which is the invariant half of these tests are about.
 */
function fireTicket(PosFixtures $fx): int
{
    $uuid = (string) Str::uuid();

    test()->withHeaders($fx->headers())->postJson('/api/pos/sync', [
        'orders' => [$fx->orderCommand($uuid, [[
            'op' => 'create', 'uuid' => (string) Str::uuid(), 'variant_id' => $fx->variant->getKey(),
            'qty' => '1', 'price_unit' => '10.00', 'discount' => '0',
        ]])],
    ])->assertOk()->assertJsonPath('results.0.status', 'ok');

    test()->withHeaders($fx->headers())
        ->postJson('/api/pos/orders/'.$uuid.'/preparation', [])
        ->assertOk();

    $lineId = DB::table('prep_order_lines')->orderByDesc('id')->value('id');

    expect($lineId)->not->toBeNull('the fixture must actually fire a kitchen line');

    return (int) $lineId;
}

/**
 * BOF-115 / KDS-008 (BAN-435) — the stage list is the board's state machine, so editing it edits
 * behaviour rather than decoration.
 *
 * Both `PreparationService` and `KitchenDisplayService::stageIdForState()` resolve a line's stage by
 * `stage_type` — never by `is_default`, despite the name. That is what makes an unguarded stage
 * editor dangerous: it can produce a list that is perfectly valid as data and silently wrong as a
 * state machine.
 */

// ───────────────────────────────────────────────────── edits survive a reload

it('keeps a renamed stage, and keeps its id so in-flight tickets are not orphaned', function (): void {
    $lineId = fireTicket($this->fx);
    $stageBefore = (int) DB::table('prep_order_lines')->where('id', $lineId)->value('prep_stage_id');

    $stages = editable($this->fx->display);
    $stages[1]['name'] = 'Sauce';
    $stages[1]['color'] = '#ff8800';
    $stages[1]['alert_after_minutes'] = 7;

    submitBoard($this->fx->display, $stages)->assertRedirect();

    $stored = board($this->fx->display);

    expect($stored[1]['name'])->toBe('Sauce')
        ->and($stored[1]['color'])->toBe('#ff8800')
        ->and((int) $stored[1]['alert_after_minutes'])->toBe(7)
        // The ticket already on the board still points at the stage it was on.
        ->and((int) DB::table('prep_order_lines')->where('id', $lineId)->value('prep_stage_id'))
        ->toBe($stageBefore);
});

it('reorders by the submitted order, which is the order a ticket walks', function (): void {
    $stages = editable($this->fx->display);
    $reordered = [$stages[0], $stages[2], $stages[1]];

    submitBoard($this->fx->display, $reordered)->assertRedirect();

    expect(array_column(board($this->fx->display), 'stage_type'))
        ->toBe(['todo', 'ready', 'in_progress']);
});

it('adds a stage the browser has no id for yet', function (): void {
    $stages = editable($this->fx->display);
    $stages[] = ['id' => null, 'name' => 'Plated', 'stage_type' => 'done', 'color' => null,
        'alert_after_minutes' => null, 'is_default' => false];

    submitBoard($this->fx->display, $stages)->assertRedirect();

    expect(array_column(board($this->fx->display), 'name'))->toContain('Plated');
});

it('removes a stage the payload no longer mentions', function (): void {
    $stages = editable($this->fx->display);
    $stages[] = ['id' => null, 'name' => 'Plated', 'stage_type' => 'done', 'color' => null,
        'alert_after_minutes' => null, 'is_default' => false];
    submitBoard($this->fx->display, $stages)->assertRedirect();

    expect(array_column(board($this->fx->display), 'name'))->toContain('Plated');

    $kept = array_values(array_filter(
        editable($this->fx->display),
        static fn (array $stage): bool => $stage['name'] !== 'Plated',
    ));

    submitBoard($this->fx->display, $kept)->assertRedirect();

    expect(array_column(board($this->fx->display), 'name'))->not->toContain('Plated');
});

// ───────────────────────────────────────── the guards on what may be removed

it('refuses to remove a stage that still holds food being cooked', function (): void {
    // `prep_order_lines.prep_stage_id` is `nullOnDelete`, so the delete never fails on its own — the
    // lines just lose their column and the board re-derives one from the line's state. Mid-service
    // that means a card jumps: the chef who put it in "cooking" finds it back in "to do", with
    // nothing on screen saying why.
    $lineId = fireTicket($this->fx);
    $holding = (int) DB::table('prep_order_lines')->where('id', $lineId)->value('prep_stage_id');

    // A replacement lane of the same kind goes in first. Without it the state-machine guard fires
    // instead and this test passes on the wrong refusal — which is exactly what it did before the
    // replacement was added.
    $kept = editable($this->fx->display);
    $kept[] = ['id' => null, 'name' => 'Fired', 'stage_type' => 'todo', 'color' => null,
        'alert_after_minutes' => null, 'is_default' => false];
    $kept = array_values(array_filter($kept, static fn (array $s): bool => $s['id'] !== $holding));

    assertStageRefusal(
        submitBoard($this->fx->display, $kept),
        'still holds 1 item(s) being prepared',
    );

    expect(DB::table('prep_stages')->where('id', $holding)->exists())->toBeTrue()
        ->and((int) DB::table('prep_order_lines')->where('id', $lineId)->value('prep_stage_id'))
        ->toBe($holding);
});

it('lets a stage go once its work is served', function (): void {
    // The control: it is live work that holds a stage, not history. A served line is on the board
    // only until `done_retention_minutes` expires.
    $lineId = fireTicket($this->fx);
    $holding = (int) DB::table('prep_order_lines')->where('id', $lineId)->value('prep_stage_id');
    DB::table('prep_order_lines')->where('id', $lineId)->update(['state' => 'served']);

    // A replacement `todo` lane goes in first, so the list still has one and only the emptiness of
    // the removed stage is under test here.
    $stages = editable($this->fx->display);
    $stages[] = ['id' => null, 'name' => 'Fired', 'stage_type' => 'todo', 'color' => null,
        'alert_after_minutes' => null, 'is_default' => true];
    $stages = array_values(array_filter($stages, static fn (array $s): bool => $s['id'] !== $holding));

    submitBoard($this->fx->display, $stages)->assertRedirect();

    expect(DB::table('prep_stages')->where('id', $holding)->exists())->toBeFalse();
});

it('refuses a board with no landing stage, because fired food would arrive nowhere', function (): void {
    // `PreparationService` resolves the landing stage by `stage_type = todo`. Without one, every
    // newly fired line is written with `prep_stage_id = null` and the pass shows work it cannot
    // place. The save succeeds and nothing anywhere says so — which is why this is refused rather
    // than repaired.
    $stages = array_values(array_filter(
        editable($this->fx->display),
        static fn (array $stage): bool => $stage['stage_type'] !== 'todo',
    ));

    assertStageRefusal(submitBoard($this->fx->display, $stages), 'todo');

    expect(array_column(board($this->fx->display), 'stage_type'))->toContain('todo');
});

it('refuses a board with no in-progress stage', function (): void {
    $stages = array_values(array_filter(
        editable($this->fx->display),
        static fn (array $stage): bool => $stage['stage_type'] !== 'in_progress',
    ));

    assertStageRefusal(submitBoard($this->fx->display, $stages), 'in_progress');

    expect(array_column(board($this->fx->display), 'stage_type'))->toContain('in_progress');
});

it('is about the kind, not the name: a renamed lane is fine', function (): void {
    // The control on the two guards above. A kitchen that calls its lanes "Fired", "On the grill"
    // and "Away" is renaming, not dismantling — the guard must not stand in the way of that.
    $stages = editable($this->fx->display);
    foreach (['Fired', 'On the grill', 'Away'] as $index => $name) {
        $stages[$index]['name'] = $name;
    }

    submitBoard($this->fx->display, $stages)->assertRedirect();

    expect(array_column(board($this->fx->display), 'name'))->toBe(['Fired', 'On the grill', 'Away'])
        ->and(array_column(board($this->fx->display), 'stage_type'))
        ->toBe(['todo', 'in_progress', 'ready']);
});

it('a ticket fired after a rename still lands on the first to-do lane', function (): void {
    // The invariant stated positively rather than only guarded.
    $stages = editable($this->fx->display);
    $stages[0]['name'] = 'Fired';
    submitBoard($this->fx->display, $stages)->assertRedirect();

    $lineId = fireTicket($this->fx);
    $landed = (int) DB::table('prep_order_lines')->where('id', $lineId)->value('prep_stage_id');

    expect($landed)->toBe((int) board($this->fx->display)[0]['id']);
});

// ─────────────────────────────────────────────────────────── exactly one default

it('lands the default on the first stage when the operator ticked none', function (): void {
    $stages = editable($this->fx->display);
    foreach (array_keys($stages) as $index) {
        $stages[$index]['is_default'] = false;
    }

    submitBoard($this->fx->display, $stages)->assertRedirect();

    expect(array_map(intval(...), array_column(board($this->fx->display), 'is_default')))
        ->toBe([1, 0, 0]);
});

it('keeps one default when the operator ticked several', function (): void {
    $stages = editable($this->fx->display);
    $stages[0]['is_default'] = false;
    $stages[1]['is_default'] = true;
    $stages[2]['is_default'] = true;

    submitBoard($this->fx->display, $stages)->assertRedirect();

    expect(array_map(intval(...), array_column(board($this->fx->display), 'is_default')))
        ->toBe([0, 1, 0]);
});

it('cannot pull another screen stage onto this board by claiming its id', function (): void {
    // `syncStages` upserts by id, so an id is a write target. Probed: an id belonging to another
    // company's display is treated as a *new* stage — inserted here, untouched there — rather than
    // moved. Pinned because "upsert by id" is exactly the shape that leaks when nobody checks whose
    // id it is.
    $other = PosFixtures::make()->withPrepDisplay();
    $foreign = (int) DB::table('prep_stages')
        ->where('prep_display_id', $other->display->getKey())
        ->orderBy('sequence')->value('id');

    expect($foreign)->toBeGreaterThan(0, 'the other venue must actually own a stage');

    $stages = editable($this->fx->display);
    $stages[0]['id'] = $foreign;
    $stages[0]['name'] = 'Hijacked';

    submitBoard($this->fx->display, $stages)->assertRedirect();

    $theirs = (array) DB::table('prep_stages')->where('id', $foreign)->first();

    expect((int) $theirs['prep_display_id'])->toBe((int) $other->display->getKey())
        ->and($theirs['name'])->not->toBe('Hijacked')
        // And it landed here as a stage of its own rather than not landing at all.
        ->and(array_column(board($this->fx->display), 'name'))->toContain('Hijacked');
});

// ─────────────────────────────────────────────────────── category routing

it('refuses a menu category that does not exist rather than dropping it', function (): void {
    // Filtering silently was the earlier shape, and it is the same defect that was fixed on printers
    // (BAN-432): the manager routes desserts to the pass, the save succeeds, the routing is not
    // there, and the desserts print nowhere.
    test()->patch(route('prep-displays.update', $this->fx->display->uuid), [
        'category_ids' => [999999],
    ])->assertSessionHasErrors('category_ids');
});

it('refuses another company menu category', function (): void {
    $other = PosFixtures::make();
    $foreign = (int) PosCategory::query()->withoutGlobalScopes()
        ->where('company_id', $other->company->getKey())->value('id');

    expect($foreign)->toBeGreaterThan(0, 'the other venue must actually own a category');

    test()->patch(route('prep-displays.update', $this->fx->display->uuid), [
        'category_ids' => [$foreign],
    ])->assertSessionHasErrors('category_ids');

    expect(DB::table('pos_category_prep_display')
        ->where('prep_display_id', $this->fx->display->getKey())
        ->where('pos_category_id', $foreign)->exists())->toBeFalse();
});

it('routes a category the venue owns', function (): void {
    $own = (int) PosCategory::query()->value('id');

    test()->patch(route('prep-displays.update', $this->fx->display->uuid), [
        'category_ids' => [$own],
    ])->assertRedirect();

    expect(DB::table('pos_category_prep_display')
        ->where('prep_display_id', $this->fx->display->getKey())
        ->where('pos_category_id', $own)->exists())->toBeTrue();
});

it('refuses a layout the board cannot render', function (): void {
    // `update` took a bare `string|max:16` while `store` took the enum, so an unknown layout could
    // be saved through one door and not the other.
    test()->patch(route('prep-displays.update', $this->fx->display->uuid), ['layout' => 'carousel'])
        ->assertSessionHasErrors('layout');
});

// ──────────────────────────────────────────────────────────── token rotation

it('rotates the screen link', function (): void {
    $before = (string) PrepDisplay::query()->whereKey($this->fx->display->getKey())->value('access_token');

    test()->post(route('prep-displays.rotate-token', $this->fx->display->uuid))
        ->assertRedirect();

    $after = (string) PrepDisplay::query()->whereKey($this->fx->display->getKey())->value('access_token');

    expect($after)->not->toBe($before)
        ->and(strlen($after))->toBe(32);
});

it('keeps the display and its stages, which is the point of rotating rather than deleting', function (): void {
    $stagesBefore = array_column(board($this->fx->display), 'id');

    test()->post(route('prep-displays.rotate-token', $this->fx->display->uuid))->assertRedirect();

    expect(array_column(board($this->fx->display), 'id'))->toBe($stagesBefore);
});

it('refuses a user who may not configure the kitchen', function (): void {
    $before = (string) PrepDisplay::query()->whereKey($this->fx->display->getKey())->value('access_token');

    test()->actingAs(stageActor($this->fx, ['pos.kitchen.view']));

    test()->post(route('prep-displays.rotate-token', $this->fx->display->uuid))->assertForbidden();

    expect((string) PrepDisplay::query()->whereKey($this->fx->display->getKey())->value('access_token'))
        ->toBe($before);
});

it('never rotates another company screen', function (): void {
    $other = PosFixtures::make()->withPrepDisplay();
    $before = (string) PrepDisplay::query()->withoutGlobalScopes()
        ->whereKey($other->display->getKey())->value('access_token');

    test()->post(route('prep-displays.rotate-token', $other->display->uuid))->assertNotFound();

    expect((string) PrepDisplay::query()->withoutGlobalScopes()
        ->whereKey($other->display->getKey())->value('access_token'))->toBe($before);
});
