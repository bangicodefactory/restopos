<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\Restaurant;

use App\Http\Controllers\Api\Pos\Concerns\ResolvesDeviceContext;
use App\Http\Controllers\Controller;
use App\Http\Requests\Restaurant\MergeOrderRequest;
use App\Http\Requests\Restaurant\TransferOrderRequest;
use App\Http\Resources\Pos\OrderResource;
use App\Models\Pos\Order;
use App\Models\Restaurant\Table as RestaurantTable;
use App\Services\Restaurant\TableService;
use DomainException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * Transfer / merge / unmerge / guest count (spec 02 RST-050…RST-074).
 *
 * All four migrate the kitchen's "already sent" snapshot with the lines; the
 * `TableService` docblock explains why that is the load-bearing part.
 */
final class TableOrderController extends Controller
{
    use ResolvesDeviceContext;

    public function __construct(private readonly TableService $tables) {}

    /** `POST /api/pos/orders/{order}/transfer` */
    public function transfer(TransferOrderRequest $request, Order $order): JsonResponse
    {
        $this->assertOwned($request, $order);

        /** @var RestaurantTable $target */
        $target = RestaurantTable::query()->findOrFail((int) $request->validated('table_id'));

        try {
            $result = $this->tables->transfer(
                $order,
                $target,
                $request->validated('employee_id') === null ? null : (int) $request->validated('employee_id'),
            );
        } catch (DomainException $e) {
            return new JsonResponse(['error' => ['code' => 'transfer_refused', 'message' => $e->getMessage()]], 422);
        }

        $result['order']->load(['lines', 'payments', 'courses']);

        return new JsonResponse([
            'order' => OrderResource::make($result['order'])->resolve($request),
            'merged' => $result['merged'],
            'merge_id' => $result['merge_id'],
        ]);
    }

    /** `POST /api/pos/orders/{order}/merge` */
    public function merge(MergeOrderRequest $request, Order $order): JsonResponse
    {
        $this->assertOwned($request, $order);

        /** @var Order $target */
        $target = Order::query()->where('uuid', $request->validated('target_order_uuid'))->firstOrFail();

        try {
            $mergeId = $this->tables->merge(
                $order,
                $target,
                $request->validated('employee_id') === null ? null : (int) $request->validated('employee_id'),
            );
        } catch (DomainException $e) {
            return new JsonResponse(['error' => ['code' => 'merge_refused', 'message' => $e->getMessage()]], 422);
        }

        $target->refresh()->load(['lines', 'payments', 'courses']);

        return new JsonResponse([
            'order' => OrderResource::make($target)->resolve($request),
            'merge_id' => $mergeId,
        ]);
    }

    /** `POST /api/pos/order-merges/{merge}/unmerge` */
    public function unmerge(Request $request, int $merge): JsonResponse
    {
        $this->deviceContext($request);

        try {
            $restored = $this->tables->unmerge($merge, $request->integer('employee_id') ?: null);
        } catch (DomainException $e) {
            return new JsonResponse(['error' => ['code' => 'unmerge_refused', 'message' => $e->getMessage()]], 422);
        }

        $restored->load(['lines', 'payments', 'courses']);

        return new JsonResponse(['order' => OrderResource::make($restored)->resolve($request)]);
    }

    /** `PATCH /api/pos/orders/{order}/guests` */
    public function guests(Request $request, Order $order): JsonResponse
    {
        $this->assertOwned($request, $order);

        $request->validate(['guest_count' => ['required', 'integer', 'min:0', 'max:999']]);

        try {
            $order = $this->tables->setGuestCount($order, $request->integer('guest_count'));
        } catch (DomainException $e) {
            return new JsonResponse(['error' => ['code' => 'invalid_guest_count', 'message' => $e->getMessage()]], 422);
        }

        return new JsonResponse(['order' => OrderResource::make($order)->resolve($request)]);
    }

    private function assertOwned(Request $request, Order $order): void
    {
        [, $config] = $this->deviceContext($request);

        abort_unless((int) $order->pos_config_id === (int) $config->getKey(), 404);
    }
}
