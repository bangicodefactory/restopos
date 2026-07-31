<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Http\Controllers\Controller;
use App\Models\Catalog\PosCategory;
use App\Models\Kitchen\PrepDisplay;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
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
        ]);

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

        return back()->with('success', 'Preparation display saved.');
    }
}
