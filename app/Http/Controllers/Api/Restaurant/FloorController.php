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

        /** @var Floor $floor */
        $floor = Floor::query()->create([
            ...$request->validated(),
            'uuid' => (string) Str::uuid(),
            'company_id' => $config->company_id,
        ]);

        $config->floors()->syncWithoutDetaching([$floor->getKey()]);

        return new JsonResponse(['floor' => $floor->attributesToArray()], 201);
    }

    /** `PATCH /api/pos/floors/{floor}` */
    public function update(FloorRequest $request, Floor $floor): JsonResponse
    {
        $floor->forceFill($request->validated())->save();

        return new JsonResponse(['floor' => $floor->attributesToArray()]);
    }

    /** `DELETE /api/pos/floors/{floor}` */
    public function destroy(Floor $floor): JsonResponse
    {
        $floor->delete();

        return new JsonResponse(null, 204);
    }

    /** `POST /api/pos/tables` */
    public function storeTable(TableRequest $request): JsonResponse
    {
        [, $config] = $this->deviceContext($request);

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
    public function destroyTable(RestaurantTable $table): JsonResponse
    {
        $table->delete();

        return new JsonResponse(null, 204);
    }
}
