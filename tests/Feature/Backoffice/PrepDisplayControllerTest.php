<?php

declare(strict_types=1);

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\Feature\PosFixtures;
use Tests\TestCase;

uses(TestCase::class, RefreshDatabase::class);

/**
 * BOF-116 — the KDS stage editor must persist its ordered stage list. The board's state machine is
 * derived from this list (order → sequence, `stage_type` → transitions), and before this landed the
 * `stages[]` payload was dropped by validation, so a reload reverted every change.
 */
beforeEach(function (): void {
    $this->fx = PosFixtures::make()->withPrepDisplay();
    $this->actingAs(User::factory()->create(['is_super_admin' => true]));
});

/** The stored stages for the fixture display, ordered as the board reads them. */
function stagesInOrder(int $displayId): array
{
    return DB::table('prep_stages')->where('prep_display_id', $displayId)->orderBy('sequence')->get()
        ->map(static fn ($r): array => ['id' => (int) $r->id, 'name' => $r->name, 'sequence' => (int) $r->sequence])
        ->all();
}

/** One stage row shaped like the editor's submit payload. */
function stagePayload(?int $id, string $name, string $type, bool $default = false): array
{
    return [
        'id' => $id,
        'name' => $name,
        'stage_type' => $type,
        'color' => null,
        'alert_after_minutes' => null,
        'sequence' => 0, // ignored server-side; the array order is authoritative
        'is_default' => $default,
    ];
}

it('persists reordering, renaming and adding stages, and the order becomes the sequence', function (): void {
    $displayId = $this->fx->display->getKey();
    $before = collect(stagesInOrder($displayId))->keyBy('name');
    $todoId = $before['To do']['id'];
    $cookingId = $before['Cooking']['id'];
    $readyId = $before['Ready']['id'];

    // Reverse the order, rename Cooking → Grill, and append a new Plating stage.
    $this->patch(route('prep-displays.update', $this->fx->display->uuid), [
        'stages' => [
            stagePayload($readyId, 'Ready', 'ready'),
            stagePayload($cookingId, 'Grill', 'in_progress'),
            stagePayload($todoId, 'To do', 'todo', true),
            stagePayload(null, 'Plating', 'done'),
        ],
    ])->assertRedirect()->assertSessionHasNoErrors();

    $after = stagesInOrder($displayId);
    expect($after)->toHaveCount(4)
        // The payload order is the stored sequence, 10-apart.
        ->and(array_map(static fn ($s): string => $s['name'], $after))->toBe(['Ready', 'Grill', 'To do', 'Plating'])
        ->and(array_map(static fn ($s): int => $s['sequence'], $after))->toBe([10, 20, 30, 40])
        // Kept stages keep their id (in-flight tickets are not orphaned); the rename reused Cooking's row.
        ->and($after[0]['id'])->toBe($readyId)
        ->and($after[1]['id'])->toBe($cookingId);
});

it('deletes a stage the payload drops', function (): void {
    // The dropped stage is a fourth, `done`-kind lane rather than one of the three the board runs
    // on: since BAN-435 a payload missing a `todo`, `in_progress` or `ready` stage is refused,
    // because the server resolves a line's stage by kind and a board without one fires food at a
    // column that does not exist. `done` is genuinely optional — a served ticket just clears.
    $displayId = $this->fx->display->getKey();
    $before = collect(stagesInOrder($displayId))->keyBy('name');

    $keep = [
        stagePayload($before['To do']['id'], 'To do', 'todo', true),
        stagePayload($before['Cooking']['id'], 'Cooking', 'in_progress'),
        stagePayload($before['Ready']['id'], 'Ready', 'ready'),
    ];

    $this->patch(route('prep-displays.update', $this->fx->display->uuid), [
        'stages' => [...$keep, stagePayload(null, 'Plating', 'done')],
    ])->assertRedirect()->assertSessionHasNoErrors();

    $plating = (int) DB::table('prep_stages')->where('prep_display_id', $displayId)
        ->where('name', 'Plating')->value('id');

    expect($plating)->toBeGreaterThan(0, 'the stage this test deletes must exist first');

    // Send the list back without it.
    $this->patch(route('prep-displays.update', $this->fx->display->uuid), [
        'stages' => $keep,
    ])->assertRedirect()->assertSessionHasNoErrors();

    $after = stagesInOrder($displayId);
    expect($after)->toHaveCount(3)
        ->and(array_map(static fn ($s): string => $s['name'], $after))->toBe(['To do', 'Cooking', 'Ready']);
    $this->assertDatabaseMissing('prep_stages', ['id' => $plating]);
});

it('reorders without tripping the unique (display, sequence) constraint', function (): void {
    $displayId = $this->fx->display->getKey();
    $before = collect(stagesInOrder($displayId))->keyBy('name');

    // Swap the first two: Cooking would take sequence 10, which "To do" still holds mid-update.
    $this->patch(route('prep-displays.update', $this->fx->display->uuid), [
        'stages' => [
            stagePayload($before['Cooking']['id'], 'Cooking', 'in_progress'),
            stagePayload($before['To do']['id'], 'To do', 'todo', true),
            stagePayload($before['Ready']['id'], 'Ready', 'ready'),
        ],
    ])->assertRedirect()->assertSessionHasNoErrors();

    $after = stagesInOrder($displayId);
    expect(array_map(static fn ($s): string => $s['name'], $after))->toBe(['Cooking', 'To do', 'Ready'])
        ->and(array_map(static fn ($s): int => $s['sequence'], $after))->toBe([10, 20, 30]);
});

it('keeps only the first default when the payload marks several', function (): void {
    $displayId = $this->fx->display->getKey();
    $before = collect(stagesInOrder($displayId))->keyBy('name');

    $this->patch(route('prep-displays.update', $this->fx->display->uuid), [
        'stages' => [
            stagePayload($before['To do']['id'], 'To do', 'todo', true),
            stagePayload($before['Cooking']['id'], 'Cooking', 'in_progress', true),
            stagePayload($before['Ready']['id'], 'Ready', 'ready', true),
        ],
    ])->assertRedirect()->assertSessionHasNoErrors();

    $defaults = DB::table('prep_stages')->where('prep_display_id', $displayId)->where('is_default', true)->pluck('name');
    expect($defaults->all())->toBe(['To do']);
});

it('rejects an invalid stage type instead of silently swallowing it', function (): void {
    $displayId = $this->fx->display->getKey();

    $this->from(route('prep-displays.edit', $this->fx->display->uuid))
        ->patch(route('prep-displays.update', $this->fx->display->uuid), [
            'stages' => [stagePayload(null, 'Bad', 'grilling')],
        ])
        ->assertSessionHasErrors('stages.0.stage_type');

    // Untouched: the three fixture stages are still there.
    expect(stagesInOrder($displayId))->toHaveCount(3);
});
