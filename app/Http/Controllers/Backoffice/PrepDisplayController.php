<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Enums\PrepDisplayLayout;
use App\Enums\PrepLineState;
use App\Enums\PrepOrderState;
use App\Enums\PrepStageType;
use App\Http\Controllers\Controller;
use App\Models\Catalog\PosCategory;
use App\Models\Kitchen\PrepDisplay;
use App\Support\Tenancy\ActingCompany;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;
use Inertia\Inertia;
use Inertia\Response;

/**
 * `PrepDisplays/Index` and `PrepDisplays/Edit` (spec 02 KDS-003, KDS-008).
 *
 * Stages are per display and ordered; the edit page owns that ordering because
 * the KDS state machine is derived from it, not hard-coded.
 */
final class PrepDisplayController extends Controller
{
    public function __construct(private readonly ConnectionInterface $connection) {}

    public function index(): Response
    {
        Gate::authorize('viewAny', PrepDisplay::class);

        return Inertia::render('PrepDisplays/Index', [
            'displays' => PrepDisplay::query()->orderBy('name')->get()->map(static fn (PrepDisplay $d): array => [
                'id' => (int) $d->getKey(),
                'uuid' => (string) $d->uuid,
                'name' => (string) $d->name,
                'layout' => (string) ($d->layout?->value ?? $d->layout),
                'average_prep_minutes' => (int) $d->average_prep_minutes,
                'late_threshold_minutes' => (int) $d->late_threshold_minutes,
                'done_retention_minutes' => (int) $d->done_retention_minutes,
                'show_all_categories' => (bool) $d->show_all_categories,
                'sound_on_new_order' => (bool) $d->sound_on_new_order,
                'active' => (bool) $d->active,
            ])->values()->all(),
        ]);
    }

    public function edit(PrepDisplay $prepDisplay): Response
    {
        Gate::authorize('view', $prepDisplay);

        return Inertia::render('PrepDisplays/Edit', [
            'display' => $prepDisplay->attributesToArray(),
            'stages' => $this->connection->table('prep_stages')
                ->where('prep_display_id', $prepDisplay->getKey())
                ->orderBy('sequence')
                ->get()->map(static fn ($r): array => (array) $r)->all(),
            'categoryIds' => $this->connection->table('pos_category_prep_display')
                ->where('prep_display_id', $prepDisplay->getKey())
                ->pluck('pos_category_id')->map(static fn (mixed $v): int => (int) $v)->all(),
            'categories' => PosCategory::query()->orderBy('sequence')->get(['id', 'name', 'parent_id'])->all(),
        ]);
    }

    /**
     * `POST /prep-displays` — add a kitchen screen (BOF-115).
     *
     * A venue opening a second station — a cold larder, a dessert pass — could not say so: the
     * displays were whatever the seeder produced.
     *
     * A new display is given the default stage set rather than none. A board with no stages shows
     * tickets that cannot be advanced: the state machine is the stage list (KDS-008), so an empty
     * one is a screen the kitchen can read and not use, which looks like a broken screen rather than
     * an unfinished setup.
     */
    public function store(Request $request): RedirectResponse
    {
        Gate::authorize('create', PrepDisplay::class);

        $data = $request->validate([
            'name' => ['required', 'string', 'max:64'],
            'layout' => ['sometimes', Rule::enum(PrepDisplayLayout::class)],
            'average_prep_minutes' => ['sometimes', 'integer', 'min:1', 'max:600'],
            'late_threshold_minutes' => ['sometimes', 'integer', 'min:1', 'max:600'],
            'done_retention_minutes' => ['sometimes', 'integer', 'min:1', 'max:1440'],
            'show_all_categories' => ['sometimes', 'boolean'],
            'auto_advance_on_all_ready' => ['sometimes', 'boolean'],
            'sound_on_new_order' => ['sometimes', 'boolean'],
            'active' => ['sometimes', 'boolean'],
        ]);

        $companyId = ActingCompany::id();

        if (! is_int($companyId)) {
            throw ValidationException::withMessages(['name' => 'Choose a company before adding a display.']);
        }

        $this->connection->transaction(function () use ($data, $companyId): void {
            /** @var PrepDisplay $display */
            $display = PrepDisplay::query()->create([
                ...$data,
                'company_id' => $companyId,
                'uuid' => (string) Str::uuid(),
                // The board's own channel and screen URL. Server-minted, never client-supplied — the
                // same rule the table QR token follows.
                'access_token' => Str::lower(Str::random(32)),
            ]);

            $this->seedDefaultStages($display);
        });

        return back()->with('success', 'Preparation display added.');
    }

    /**
     * `DELETE /prep-displays/{prepDisplay}` — remove a kitchen screen (BOF-115).
     *
     * Refused while the board still holds work. `prep_orders.prep_display_id` is `cascadeOnDelete`,
     * so deleting the display takes every ticket on it with it — and the *order* those tickets came
     * from still says the kitchen was told. Food that somebody is cooking stops existing on the only
     * screen that shows it, and nothing anywhere says so.
     *
     * Served and cancelled tickets are history and do not block: they are on the board only because
     * `done_retention_minutes` has not expired yet.
     */
    public function destroy(Request $request, PrepDisplay $prepDisplay): RedirectResponse
    {
        Gate::authorize('delete', $prepDisplay);

        $live = $this->connection->table('prep_orders')
            ->where('prep_display_id', $prepDisplay->getKey())
            ->whereIn('state', [
                PrepOrderState::Pending->value,
                PrepOrderState::InProgress->value,
                PrepOrderState::Ready->value,
            ])
            // Not `ActingCompany::scope()`d, and that is not an oversight: `prep_orders` carries no
            // `company_id` at all — it is owned through `prep_display_id`, which is the very key this
            // query is already filtered on, and the display itself was resolved through the scoped
            // model and 404s when it is not ours. Adding the scope would put a `where company_id`
            // on a table that has no such column: a 500 on every delete of a board with tickets.
            ->count();

        $count = $live;

        if ($count > 0) {
            throw ValidationException::withMessages([
                'display' => 'This screen still has '.$count.' ticket(s) on it. Clear the board first.',
            ]);
        }

        $prepDisplay->delete();

        return back()->with('success', 'Preparation display removed.');
    }

    /**
     * `POST /prep-displays/{prepDisplay}/rotate-token` — mint a new screen URL (BOF-115).
     *
     * `access_token` is two things at once: the screen's URL (`/kitchen/{token}`) and its broadcast
     * channel name (`private-kitchen.display.{token}`). The channel is device-authorised, so knowing
     * the token alone does not hand anyone the board — but it is still the address that spreads: a
     * tablet bookmarked on a shared bench, a link pasted into a staff group chat, an agency chef who
     * worked one weekend. Rotating is how a venue retires that address and drops every screen
     * currently subscribed, without deleting the display and its stage setup.
     *
     * Before this the only way to do it was editing the database by hand. Tables and self-order
     * configs both already had the door; the kitchen did not.
     */
    public function rotateToken(PrepDisplay $prepDisplay): RedirectResponse
    {
        Gate::authorize('update', $prepDisplay);

        $prepDisplay->forceFill(['access_token' => Str::lower(Str::random(32))])->save();

        return back()->with('success', 'Kitchen screen link rotated. Reopen the screen on every device that uses it.');
    }

    /**
     * The stage set a new board starts with (KDS-008).
     *
     * Pending → in progress → ready is the minimum a kitchen screen needs to be usable at all: one
     * column to see work arrive, one to claim it, one to call it away.
     */
    private function seedDefaultStages(PrepDisplay $display): void
    {
        $defaults = [
            ['name' => 'To do', 'stage_type' => PrepStageType::Todo->value, 'sequence' => 1, 'is_default' => true],
            ['name' => 'In progress', 'stage_type' => PrepStageType::InProgress->value, 'sequence' => 2, 'is_default' => false],
            ['name' => 'Ready', 'stage_type' => PrepStageType::Ready->value, 'sequence' => 3, 'is_default' => false],
        ];

        foreach ($defaults as $stage) {
            $this->connection->table('prep_stages')->insert([
                ...$stage,
                'prep_display_id' => $display->getKey(),
                'created_at' => now(),
                'updated_at' => now(),
            ]);
        }
    }

    public function update(Request $request, PrepDisplay $prepDisplay): RedirectResponse
    {
        Gate::authorize('update', $prepDisplay);

        $data = $request->validate([
            'name' => ['sometimes', 'string', 'max:64'],
            // The enum, matching `store`. As a bare `string|max:16` this accepted any word at all
            // and stored it: the board then rendered no known layout.
            'layout' => ['sometimes', Rule::enum(PrepDisplayLayout::class)],
            'average_prep_minutes' => ['sometimes', 'integer', 'min:1', 'max:600'],
            'late_threshold_minutes' => ['sometimes', 'integer', 'min:1', 'max:600'],
            'done_retention_minutes' => ['sometimes', 'integer', 'min:1', 'max:1440'],
            'show_all_categories' => ['sometimes', 'boolean'],
            'auto_advance_on_all_ready' => ['sometimes', 'boolean'],
            'sound_on_new_order' => ['sometimes', 'boolean'],
            'active' => ['sometimes', 'boolean'],
            'category_ids' => ['sometimes', 'array'],
            'category_ids.*' => ['integer'],

            // The KDS state machine is derived from this ordered list (KDS-008): the board's
            // next-stage behaviour follows the sequence, and `stage_type` is what its automatic
            // transitions key off. `id` is null for a stage that exists only in the browser.
            'stages' => ['sometimes', 'array'],
            'stages.*.id' => ['nullable', 'integer'],
            'stages.*.name' => ['required', 'string', 'max:48'],
            'stages.*.stage_type' => ['required', Rule::enum(PrepStageType::class)],
            'stages.*.color' => ['nullable', 'string', 'max:24'],
            'stages.*.alert_after_minutes' => ['nullable', 'integer', 'min:1', 'max:600'],
            'stages.*.is_default' => ['sometimes', 'boolean'],
        ]);

        $stages = $data['stages'] ?? null;
        unset($data['stages']);

        // Both guards run before the transaction opens: a save that is going to be refused should
        // not take out row locks on the stage table on its way to refusing.
        if ($stages !== null) {
            $this->assertStateMachineIntact($stages);
            $this->assertRemovalsHoldNoWork($prepDisplay, $stages);
        }

        $this->connection->transaction(function () use ($prepDisplay, &$data, $stages): void {
            if (array_key_exists('category_ids', $data)) {
                $categoryIds = $this->ownedCategories((array) $data['category_ids']);

                $this->connection->table('pos_category_prep_display')->where('prep_display_id', $prepDisplay->getKey())->delete();

                foreach ($categoryIds as $categoryId) {
                    $this->connection->table('pos_category_prep_display')->insert([
                        'prep_display_id' => $prepDisplay->getKey(),
                        'pos_category_id' => $categoryId,
                    ]);
                }

                unset($data['category_ids']);
            }

            $prepDisplay->forceFill($data)->save();

            if ($stages !== null) {
                $this->syncStages($prepDisplay, $stages);
            }
        });

        return back()->with('success', 'Preparation display saved.');
    }

    /**
     * Resolve submitted category ids through the scoped model, refusing rather than dropping.
     *
     * The pivot carries no company of its own, so an id straight from the browser is the only thing
     * between this display and another tenant's menu (XCT-101). Filtering the strangers away
     * silently was the earlier shape, and it is worse than it sounds: a manager routes desserts to
     * the pass, the save succeeds, and the routing is simply not there — the desserts print nowhere
     * and the page says everything was saved. The same defect was fixed on printers (BAN-432).
     *
     * @param  list<mixed>  $ids
     * @return list<int>
     */
    private function ownedCategories(array $ids): array
    {
        $wanted = array_values(array_unique(array_map(intval(...), $ids)));

        $found = PosCategory::query()->whereIn('id', $wanted)->pluck('id')
            ->map(static fn (mixed $v): int => (int) $v)->all();

        $missing = array_values(array_diff($wanted, $found));

        if ($missing !== []) {
            throw ValidationException::withMessages([
                'category_ids' => 'No such menu category: '.implode(', ', $missing).'.',
            ]);
        }

        return $found;
    }

    /**
     * The stage list *is* the state machine, so it has to keep the kinds the server resolves against
     * (KDS-008).
     *
     * `KitchenDisplayService::stageIdForState()` and `PreparationService` both find a line's stage by
     * `stage_type` — never by `is_default`, despite the name. A fired line lands on the first `todo`
     * stage, a bump moves it to the first `in_progress`, calling away to the first `ready`. Remove
     * the `todo` stage and every newly fired line arrives with no stage at all; remove `in_progress`
     * and bumping a card leaves it sitting where it was while its state has moved on. Neither fails
     * loudly. The board simply stops agreeing with the kitchen, and the first anyone knows is a
     * plate that nobody called away.
     *
     * `done` is not required: a board that clears a served card rather than showing it is an ordinary
     * setup, and a served line keeps whatever stage it was on.
     *
     * @param  list<array<string, mixed>>  $rows
     */
    private function assertStateMachineIntact(array $rows): void
    {
        $types = array_map(static fn (array $row): string => (string) $row['stage_type'], $rows);

        $missing = [];

        foreach ([PrepStageType::Todo, PrepStageType::InProgress, PrepStageType::Ready] as $type) {
            if (! in_array($type->value, $types, true)) {
                $missing[] = $type->value;
            }
        }

        if ($missing !== []) {
            throw ValidationException::withMessages([
                'stages' => 'A board needs a stage of each kind, and these are missing: '
                    .implode(', ', $missing).'. Rename a stage rather than removing it — the kind is'
                    .' what the screen moves tickets by, the name is only what the kitchen reads.',
            ]);
        }
    }

    /**
     * Refuse to remove a stage that still holds live work (KDS-008).
     *
     * `prep_order_lines.prep_stage_id` is `nullOnDelete`, so the delete never fails — the lines just
     * lose their column. The board then recovers by falling back to the line's own state, which means
     * a card silently moves somewhere else on the pass mid-service: the chef who put it in "sauce"
     * finds it back in "to do", with nothing on screen saying why.
     *
     * Served and cancelled lines are history and hold nothing open.
     *
     * The removals are worked out here rather than read back out of `syncStages`, so the refusal
     * happens before a transaction is opened — see the note at the call site.
     *
     * @param  list<array<string, mixed>>  $rows
     */
    private function assertRemovalsHoldNoWork(PrepDisplay $prepDisplay, array $rows): void
    {
        $submitted = [];

        foreach ($rows as $row) {
            if (($row['id'] ?? null) !== null) {
                $submitted[] = (int) $row['id'];
            }
        }

        $removed = $this->connection->table('prep_stages')
            ->where('prep_display_id', $prepDisplay->getKey())
            ->whereNotIn('id', $submitted === [] ? [0] : $submitted)
            ->pluck('id')
            ->map(static fn (mixed $v): int => (int) $v)
            ->all();

        if ($removed === []) {
            return;
        }

        $live = $this->connection->table('prep_order_lines')
            ->whereIn('prep_stage_id', $removed)
            ->whereIn('state', [
                PrepLineState::Todo->value,
                PrepLineState::InProgress->value,
                PrepLineState::Ready->value,
            ])
            // Not `ActingCompany::scope()`d, for the same reason as `destroy()`: `prep_order_lines`
            // has no `company_id` column at all. Ownership runs through `prep_stage_id`, and these
            // ids were read off a display the scoped model already resolved.
            ->count();

        if ($live > 0) {
            throw ValidationException::withMessages([
                'stages' => 'A stage you removed still holds '.$live.' item(s) being prepared. Move'
                    .' them on first, or clear the board.',
            ]);
        }
    }

    /**
     * Reconcile the submitted stage list against what is stored (KDS-008), preserving stage ids so
     * a rename or reorder does not orphan in-flight tickets (`prep_order_lines.prep_stage_id` is
     * null-on-delete). The list order *is* the state machine, so `sequence` is reassigned from the
     * payload order; existing rows are first parked in a high sequence band to sidestep the
     * `unique(prep_display_id, sequence)` constraint mid-reorder.
     *
     * @param  list<array<string, mixed>>  $rows
     */
    private function syncStages(PrepDisplay $prepDisplay, array $rows): void
    {
        $displayId = (int) $prepDisplay->getKey();

        $existingIds = $this->connection->table('prep_stages')
            ->where('prep_display_id', $displayId)
            ->pluck('id')
            ->map(static fn (mixed $v): int => (int) $v);

        $keptIds = [];
        foreach ($rows as $row) {
            $id = $row['id'] ?? null;
            if ($id !== null && $existingIds->contains((int) $id)) {
                $keptIds[] = (int) $id;
            }
        }

        // Deletions — stored stages the payload no longer mentions.
        $removed = $existingIds->diff($keptIds);
        if ($removed->isNotEmpty()) {
            $this->connection->table('prep_stages')->whereIn('id', $removed->all())->delete();
        }

        // Park the survivors above any sequence the payload will assign, so reassigning 10, 20, 30…
        // never momentarily collides with a row still holding that sequence.
        $this->connection->table('prep_stages')
            ->where('prep_display_id', $displayId)
            ->update(['sequence' => DB::raw('sequence + 100000')]);

        // Exactly one default, not at most one. `PrepStage::scopeDefault()` resolves a single row,
        // and a payload where the operator unticked every box would leave it answering nothing. The
        // first stage is the honest fallback: it is where the sequence starts. Extra ticks past the
        // first are dropped rather than refused — the editor is a set of checkboxes and ticking a
        // second one plainly means "this one instead".
        $defaultIndex = null;

        foreach (array_values($rows) as $index => $row) {
            if ((bool) ($row['is_default'] ?? false)) {
                $defaultIndex = $index;
                break;
            }
        }

        $defaultIndex ??= 0;

        foreach (array_values($rows) as $index => $row) {
            $isDefault = $index === $defaultIndex;

            $payload = [
                'name' => (string) $row['name'],
                'stage_type' => (string) $row['stage_type'],
                'color' => $row['color'] ?? null,
                'alert_after_minutes' => isset($row['alert_after_minutes']) ? (int) $row['alert_after_minutes'] : null,
                'sequence' => ($index + 1) * 10,
                'is_default' => $isDefault,
                'updated_at' => now(),
            ];

            $id = $row['id'] ?? null;

            if ($id !== null && in_array((int) $id, $keptIds, true)) {
                $this->connection->table('prep_stages')->where('id', (int) $id)->update($payload);
            } else {
                $this->connection->table('prep_stages')->insert([
                    ...$payload,
                    'prep_display_id' => $displayId,
                    'created_at' => now(),
                ]);
            }
        }
    }
}
