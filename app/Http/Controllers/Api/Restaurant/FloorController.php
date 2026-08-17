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
            try {
                $this->tables->link(
                    $table,
                    $parentId === null ? null : RestaurantTable::query()->find((int) $parentId),
                );
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

    /** The floor half of {@see assertOwnedTable()}. */
    private function assertOwnedFloor(Request $request, Floor $floor): void
    {
        [, $config] = $this->deviceContext($request);

        if (! $config->floors()->whereKey($floor->getKey())->exists()) {
            throw new NotFoundHttpException('No such floor.');
        }
    }
}
