<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Http\Controllers\Controller;
use App\Http\Requests\Restaurant\FloorRequest;
use App\Models\Restaurant\Floor;
use App\Models\Restaurant\Table as RestaurantTable;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Inertia\Inertia;
use Inertia\Response;

/**
 * `Floors/Index` and `Floors/Edit` — the floor-plan editor (spec 02 RST-030…049).
 *
 * Table `identifier` is the QR capability token. Rotating it invalidates every
 * printed QR for that table, so it is an explicit action, never a side effect of
 * saving geometry.
 */
final class FloorController extends Controller
{
    public function index(): Response
    {
        return Inertia::render('Floors/Index', [
            'floors' => Floor::query()->orderBy('sequence')->withCount('tables')->get()
                ->map(static fn (Floor $f): array => [
                    'id' => (int) $f->getKey(),
                    'uuid' => (string) $f->uuid,
                    'name' => (string) $f->name,
                    'background_color' => $f->background_color,
                    'sequence' => (int) $f->sequence,
                    'table_count' => (int) $f->tables_count,
                    'active' => (bool) $f->active,
                ])->values()->all(),
        ]);
    }

    public function edit(Floor $floor): Response
    {
        return Inertia::render('Floors/Edit', [
            'floor' => $floor->attributesToArray(),
            'tables' => RestaurantTable::query()
                ->where('restaurant_floor_id', $floor->getKey())
                ->orderBy('table_number')
                ->get()
                ->map(static fn (RestaurantTable $t): array => $t->attributesToArray())
                ->values()
                ->all(),
        ]);
    }

    public function update(FloorRequest $request, Floor $floor): RedirectResponse
    {
        $floor->forceFill($request->validated())->save();

        return back()->with('success', 'Floor saved.');
    }

    /** Rotating a table token invalidates its printed QR — deliberate, explicit. */
    public function rotateTableToken(Request $request, RestaurantTable $table): RedirectResponse
    {
        $table->forceFill(['identifier' => Str::lower(Str::random(8))])->save();

        return back()->with('success', 'Table QR token rotated. Reprint the table QR code.');
    }
}
