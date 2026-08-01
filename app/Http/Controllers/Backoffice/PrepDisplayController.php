<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Enums\PrepStageType;
use App\Http\Controllers\Controller;
use App\Models\Catalog\PosCategory;
use App\Models\Kitchen\PrepDisplay;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;
use Illuminate\Validation\Rule;
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

    public function update(Request $request, PrepDisplay $prepDisplay): RedirectResponse
    {
        Gate::authorize('update', $prepDisplay);

        $data = $request->validate([
            'name' => ['sometimes', 'string', 'max:64'],
            'layout' => ['sometimes', 'string', 'max:16'],
            'average_prep_minutes' => ['sometimes', 'integer', 'min:1', 'max:600'],
            'late_threshold_minutes' => ['sometimes', 'integer', 'min:1', 'max:600'],
            'done_retention_minutes' => ['sometimes', 'integer', 'min:1', 'max:1440'],
            'show_all_categories' => ['sometimes', 'boolean'],
            'auto_advance_on_all_ready' => ['sometimes', 'boolean'],
            'sound_on_new_order' => ['sometimes', 'boolean'],
            'active' => ['sometimes', 'boolean'],
            'category_ids' => ['sometimes', 'array'],

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

        $this->connection->transaction(function () use ($prepDisplay, &$data, $stages): void {
            if (array_key_exists('category_ids', $data)) {
                $this->connection->table('pos_category_prep_display')->where('prep_display_id', $prepDisplay->getKey())->delete();

                foreach ((array) $data['category_ids'] as $categoryId) {
                    $this->connection->table('pos_category_prep_display')->insert([
                        'prep_display_id' => $prepDisplay->getKey(),
                        'pos_category_id' => (int) $categoryId,
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

        foreach (array_values($rows) as $index => $row) {
            $payload = [
                'name' => (string) $row['name'],
                'stage_type' => (string) $row['stage_type'],
                'color' => $row['color'] ?? null,
                'alert_after_minutes' => isset($row['alert_after_minutes']) ? (int) $row['alert_after_minutes'] : null,
                'sequence' => ($index + 1) * 10,
                'is_default' => (bool) ($row['is_default'] ?? false),
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
