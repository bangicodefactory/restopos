<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Enums\TableShape;
use App\Http\Controllers\Controller;
use App\Http\Requests\Restaurant\FloorRequest;
use App\Models\Restaurant\Floor;
use App\Models\Restaurant\Table as RestaurantTable;
use App\Services\Restaurant\TableService;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Collection;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;
use Inertia\Inertia;
use Inertia\Response;

/**
 * `Floors/Index` and `Floors/Edit` — the floor-plan editor (spec 02 RST-030…049).
 *
 * Table `identifier` is the QR capability token. Rotating it invalidates every
 * printed QR for that table, so it is an explicit action, never a side effect of
 * saving geometry.
 *
 * The editor submits the whole plan with the floor. `update()` reconciles it
 * (BOF-115): existing tables keep their id (and therefore their QR token) and are
 * updated in place, new tables (client id < 0) are created with a fresh token,
 * and any existing table the payload no longer mentions is soft-deleted. Parent
 * links are resolved and cycle-checked in a second pass, because a new table may
 * be parented to another table created in the same save.
 */
final class FloorController extends Controller
{
    public function __construct(
        private readonly ConnectionInterface $connection,
        private readonly TableService $tables,
    ) {}

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
        $data = $request->validated();
        $tables = $data['tables'] ?? null;
        unset($data['tables']);

        $this->connection->transaction(function () use ($floor, $data, $tables): void {
            $floor->forceFill($data)->save();

            if ($tables !== null) {
                $this->syncTables($floor, $tables);
            }
        });

        return back()->with('success', 'Floor saved.');
    }

    /**
     * Reconcile the submitted plan against what is stored: update the tables that
     * survive, create the new ones, soft-delete the ones the payload dropped, then
     * wire up parent links once every table has a real id.
     *
     * @param  list<array<string, mixed>>  $rows
     */
    private function syncTables(Floor $floor, array $rows): void
    {
        /** @var Collection<int, RestaurantTable> $existing */
        $existing = RestaurantTable::query()
            ->where('restaurant_floor_id', $floor->getKey())
            ->get()
            ->keyBy(static fn (RestaurantTable $t): int => (int) $t->getKey());

        // Pass 1 — attributes only (parent links wait until every id exists).
        /** @var array<int, RestaurantTable> $byClientId */
        $byClientId = [];

        foreach ($rows as $row) {
            $clientId = (int) $row['id'];

            // `name` and `color` are nullable and pass through as-is — clearing one must persist, not
            // be swallowed. The geometry/shape columns are NOT NULL with DB defaults and the editor
            // always sends them, so they are only coalesced as a belt-and-braces for a create.
            $attributes = [
                'table_number' => (int) $row['table_number'],
                'name' => $row['name'] ?? null,
                'shape' => $row['shape'] ?? TableShape::Square->value,
                'position_x' => $row['position_x'] ?? 10,
                'position_y' => $row['position_y'] ?? 10,
                'width' => $row['width'] ?? 50,
                'height' => $row['height'] ?? 50,
                'seats' => (int) ($row['seats'] ?? 2),
                'color' => $row['color'] ?? null,
                'active' => (bool) ($row['active'] ?? true),
            ];

            $model = $clientId > 0 ? $existing->get($clientId) : null;

            if ($model !== null) {
                $model->forceFill($attributes)->save();
            } else {
                /** @var RestaurantTable $model */
                $model = RestaurantTable::query()->create([
                    ...$attributes,
                    'restaurant_floor_id' => $floor->getKey(),
                    'company_id' => $floor->company_id,
                    'uuid' => (string) Str::uuid(),
                    // A new table gets its own QR capability token; it is never client-supplied.
                    'identifier' => RestaurantTable::newIdentifier(),
                ]);
            }

            $byClientId[$clientId] = $model;
        }

        // Deletions — any stored table the payload no longer mentions.
        $keptIds = [];
        foreach ($rows as $row) {
            if ((int) $row['id'] > 0) {
                $keptIds[] = (int) $row['id'];
            }
        }
        $removed = $existing->keys()->diff($keptIds);

        if ($removed->isNotEmpty()) {
            // RST-039 — the third deletion path, and the quietest. Dragging a table out of the plan
            // and pressing save deletes it, so the same rule the API endpoints enforce has to hold
            // here too: an occupied table strands its bill, and this route would do it without even
            // the confirmation the delete button asks for.
            //
            // The whole save is refused rather than the one table skipped. Silently keeping a table
            // the manager removed would mean the plan they are looking at is not the plan that was
            // stored, and they would find out the next time somebody opened the floor screen.
            $occupied = RestaurantTable::query()
                ->whereIn('id', $removed->all())
                ->get()
                ->filter(fn (RestaurantTable $t): bool => $this->tables->tableHasDraftOrder((int) $t->getKey()))
                ->map(static fn (RestaurantTable $t): string => (string) $t->table_number)
                ->values()
                ->all();

            if ($occupied !== []) {
                throw ValidationException::withMessages([
                    'tables' => 'Still open, so they cannot be removed: '.implode(', ', $occupied).'.',
                ]);
            }

            RestaurantTable::query()->whereIn('id', $removed->all())->get()
                ->each(static fn (RestaurantTable $t): ?bool => $t->delete());
        }

        // Pass 2 — parent links, resolved through the client→server id map and cycle-guarded.
        $this->applyParentLinks($rows, $byClientId);
    }

    /**
     * @param  list<array<string, mixed>>  $rows
     * @param  array<int, RestaurantTable>  $byClientId  keyed by the client id sent in the payload
     */
    private function applyParentLinks(array $rows, array $byClientId): void
    {
        // Resolve each table's desired parent into server-id space, keyed by the child's server id.
        // A parent that is not part of this save is dropped rather than trusted, so a stale client
        // id can never point a table off its own floor.
        /** @var array<int, array{model: RestaurantTable, parentId: ?int}> $desired */
        $desired = [];

        foreach ($rows as $row) {
            $model = $byClientId[(int) $row['id']];
            $rawParent = $row['parent_id'] ?? null;
            $parent = $rawParent === null ? null : ($byClientId[(int) $rawParent] ?? null);
            $desired[(int) $model->getKey()] = ['model' => $model, 'parentId' => $parent?->getKey()];
        }

        foreach ($desired as $childId => $link) {
            if ($link['parentId'] !== null && $this->wouldCycle($desired, $childId, $link['parentId'])) {
                throw ValidationException::withMessages([
                    'tables' => 'A table link would create a cycle.',
                ]);
            }
        }

        foreach ($desired as $link) {
            $link['model']->forceFill(['parent_id' => $link['parentId']])->save();
        }
    }

    /**
     * Walk the proposed parent chain from `$parentId` up; a return to `$childId`
     * (or a self-link) is a cycle. Depth-bounded as a belt-and-braces stop.
     *
     * @param  array<int, array{model: RestaurantTable, parentId: ?int}>  $desired
     */
    private function wouldCycle(array $desired, int $childId, int $parentId): bool
    {
        $cursor = $parentId;
        $depth = 0;

        while ($cursor !== null && $depth++ < 32) {
            if ($cursor === $childId) {
                return true;
            }
            $cursor = $desired[$cursor]['parentId'] ?? null;
        }

        return false;
    }

    /** Rotating a table token invalidates its printed QR — deliberate, explicit. */
    public function rotateTableToken(Request $request, RestaurantTable $table): RedirectResponse
    {
        $table->forceFill(['identifier' => Str::lower(Str::random(8))])->save();

        return back()->with('success', 'Table QR token rotated. Reprint the table QR code.');
    }
}
