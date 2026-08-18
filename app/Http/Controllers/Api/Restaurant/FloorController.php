<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\Restaurant;

use App\Http\Controllers\Api\Pos\Concerns\ResolvesDeviceContext;
use App\Http\Controllers\Controller;
use App\Http\Requests\Restaurant\FloorRequest;
use App\Http\Requests\Restaurant\TableRequest;
use App\Models\Restaurant\Floor;
use App\Models\Restaurant\Table as RestaurantTable;
use App\Services\Restaurant\TableService;
use DomainException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * Floors and tables: the register reads them, the floor editor writes them
 * (spec 02 RST-001…RST-049).
 */
final class FloorController extends Controller
{
    use ResolvesDeviceContext;

    public function __construct(private readonly TableService $tables) {}

    /** `GET /api/pos/floors` — floors + tables + live occupancy. */
    public function index(Request $request): JsonResponse
    {
        [, $config] = $this->deviceContext($request);

        $floors = $config->floors()->where('restaurant_floors.active', true)->orderBy('sequence')->get();

        return new JsonResponse([
            'floors' => $floors->map(fn (Floor $floor): array => [
                'id' => (int) $floor->getKey(),
                'uuid' => (string) $floor->uuid,
                'name' => (string) $floor->name,
                'background_color' => $floor->background_color,
                'sequence' => (int) $floor->sequence,
                'tables' => RestaurantTable::query()
                    ->where('restaurant_floor_id', $floor->getKey())
                    ->where('active', true)
                    ->orderBy('table_number')
                    ->get()
                    ->map(static fn (RestaurantTable $t): array => [
                        'id' => (int) $t->getKey(),
                        'uuid' => (string) $t->uuid,
                        'table_number' => (int) $t->table_number,
                        'name' => $t->name,
                        'identifier' => (string) $t->identifier,
                        'shape' => (string) ($t->shape?->value ?? $t->shape),
                        'position_x' => (string) $t->position_x,
                        'position_y' => (string) $t->position_y,
                        'width' => (string) $t->width,
                        'height' => (string) $t->height,
                        'seats' => (int) $t->seats,
                        'color' => $t->color,
                        'parent_id' => $t->parent_id,
                    ])->values()->all(),
            ])->values()->all(),
        ]);
    }

    /** `POST /api/pos/floors` */
    public function store(FloorRequest $request): JsonResponse
    {
        [, $config] = $this->deviceContext($request);

        $data = $request->validated();
        unset($data['tables']);

        /** @var Floor $floor */
        $floor = Floor::query()->create([
            ...$data,
            'uuid' => (string) Str::uuid(),
            'company_id' => $config->company_id,
        ]);

        $config->floors()->syncWithoutDetaching([$floor->getKey()]);

        return new JsonResponse(['floor' => $floor->attributesToArray()], 201);
    }

    /** `PATCH /api/pos/floors/{floor}` */
    public function update(FloorRequest $request, Floor $floor): JsonResponse
    {
        $this->assertOwnedFloor($request, $floor);

        // `tables[]` is the back-office plan editor's concern (see Backoffice\FloorController);
        // this endpoint writes floor attributes only.
        $data = $request->validated();
        unset($data['tables']);

        $floor->forceFill($data)->save();

        return new JsonResponse(['floor' => $floor->attributesToArray()]);
    }

    /** `DELETE /api/pos/floors/{floor}` */
    public function destroy(Request $request, Floor $floor): JsonResponse
    {
        $this->assertOwnedFloor($request, $floor);

        // RST-032 — a floor holding a live bill cannot go. Deleting it strands every order on it:
        // the rows keep a `restaurant_table_id` pointing at nothing, the floor screen cannot draw
        // them and the ticket list filters them out, so the money is unreachable from every screen a
        // waiter has. The bill does not disappear, which is worse, because nothing says it is there.
        $occupied = $this->tables->occupiedTablesOnFloor((int) $floor->getKey());

        if ($occupied !== []) {
            return new JsonResponse([
                'error' => [
                    'code' => 'floor_occupied',
                    // Named, not merely refused: "you cannot delete this floor" sends a manager
                    // hunting through the room; a list of table numbers is a job they can finish.
                    'message' => 'Still open on this floor: '.implode(', ', $occupied).'.',
                    'tables' => $occupied,
                ],
            ], 422);
        }

        $floor->delete();

        return new JsonResponse(null, 204);
    }

    /** `POST /api/pos/tables` */
    public function storeTable(TableRequest $request): JsonResponse
    {
        [, $config] = $this->deviceContext($request);

        // `company_id` is taken from the device, so a created table is always this tenant's — but
        // the *floor* it lands on comes from the request, and an unchecked one would file this
        // company's table inside another company's room.
        $floorId = $request->validated('restaurant_floor_id');

        if ($floorId !== null && ! $config->floors()->whereKey((int) $floorId)->exists()) {
            throw new NotFoundHttpException('No such floor.');
        }

        /** @var RestaurantTable $table */
        $table = RestaurantTable::query()->create([
            ...$request->validated(),
            'uuid' => (string) Str::uuid(),
            'company_id' => $config->company_id,
            // The QR capability token: short, opaque, rotatable per table.
            'identifier' => Str::lower(Str::random(8)),
        ]);

        return new JsonResponse(['table' => $table->attributesToArray()], 201);
    }

    /** `PATCH /api/pos/tables/{table}` */
    public function updateTable(TableRequest $request, RestaurantTable $table): JsonResponse
    {
        $this->assertOwnedTable($request, $table);

        $data = $request->validated();
        $parentId = $data['parent_id'] ?? null;
        unset($data['parent_id']);

        $table->forceFill($data)->save();

        if (array_key_exists('parent_id', $request->validated())) {
            // RST-050 (BAN-463) — the *child* is ownership-checked above; the parent was resolved
            // with a bare `find()`, and `parent_id`'s only rule is `exists:restaurant_tables,id`,
            // which does not care whose table it is. So a device could name any table in the
            // database as the parent — and `link()` does not merely set a column, it moves the
            // child's draft order onto the parent, merging it into the parent's bill if there is
            // one. That is a cross-tenant order merge: another company's table acquires our lines,
            // our courses and our prep snapshot, and our bill stops existing.
            //
            // It cost little while the only way to reach it was a hand-written PATCH. This ticket
            // makes it a drag gesture, which is exactly when an unguarded endpoint stops being
            // theoretical.
            $parent = $parentId === null ? null : $this->ownedTable($request, (int) $parentId);

            if ($parentId !== null && $parent === null) {
                return new JsonResponse([
                    'error' => ['code' => 'invalid_link', 'message' => 'No such table.'],
                ], 422);
            }

            try {
                $this->tables->link($table, $parent);
            } catch (DomainException $e) {
                return new JsonResponse(['error' => ['code' => 'invalid_link', 'message' => $e->getMessage()]], 422);
            }
        }

        return new JsonResponse(['table' => $table->refresh()->attributesToArray()]);
    }

    /** `DELETE /api/pos/tables/{table}` */
    public function destroyTable(Request $request, RestaurantTable $table): JsonResponse
    {
        $this->assertOwnedTable($request, $table);

        // RST-039 — same rule for one table. The order stays reachable rather than becoming a bill
        // nobody can open.
        if ($this->tables->tableHasDraftOrder((int) $table->getKey())) {
            return new JsonResponse([
                'error' => [
                    'code' => 'table_occupied',
                    'message' => 'That table still has an open bill.',
                ],
            ], 422);
        }

        $table->delete();

        return new JsonResponse(null, 204);
    }

    /**
     * The room this device is allowed to rearrange (BAN-449).
     *
     * `index` has always scoped its read through `$config->floors()`. The four write endpoints did
     * not scope anything: they took a route-bound model and force-filled it, so a device token —
     * which is issued per config and is the only credential these routes require — could move,
     * recolour or delete **any table in the database**, including another company's.
     *
     * That cost little while nothing called them from a till; the register's edit mode is what makes
     * it reachable, and the spec is explicit that "client-side ability checks are UX; the ingest
     * check is the control". A manager-gated button with an unguarded endpoint behind it is not a
     * control.
     *
     * 404 rather than 403: a device has no business learning that a given table id exists somewhere
     * else.
     */
    private function assertOwnedTable(Request $request, RestaurantTable $table): void
    {
        [, $config] = $this->deviceContext($request);

        $reachable = $config->floors()
            ->whereKey($table->restaurant_floor_id)
            ->exists();

        if (! $reachable || (int) $table->company_id !== (int) $config->company_id) {
            throw new NotFoundHttpException('No such table.');
        }
    }

    /**
     * A table this device may name in a request *body* — the lookup half of
     * {@see assertOwnedTable()}, which guards route-bound models.
     *
     * Returns null rather than throwing: a foreign id in a body is a refusal for that field, not a
     * missing route.
     */
    private function ownedTable(Request $request, int $id): ?RestaurantTable
    {
        [, $config] = $this->deviceContext($request);

        /** @var RestaurantTable|null $table */
        $table = RestaurantTable::query()->whereKey($id)->first();

        if ($table === null || (int) $table->company_id !== (int) $config->company_id) {
            return null;
        }

        return $config->floors()->whereKey($table->restaurant_floor_id)->exists() ? $table : null;
    }

    /** The floor half of {@see assertOwnedTable()}. */
    private function assertOwnedFloor(Request $request, Floor $floor): void
    {
        [, $config] = $this->deviceContext($request);

        if (! $config->floors()->whereKey($floor->getKey())->exists()) {
            throw new NotFoundHttpException('No such floor.');
        }
    }
}
